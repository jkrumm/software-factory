#!/usr/bin/env python3
"""Shared derivation of the warden ledger for the kpi scripts.

Question
    One definition per metric: `item`, `escalated`, `owner_touch`, `resolved` and the
    per-item facts they need are derived here once, so baseline.py and cost.py cannot
    drift apart. Importing this module loads the frozen snapshot and derives every row.

Definition keys (evidence/DEFINITIONS.md)
    item, escalated, owner_touch, resolved (and their inputs: first_seen, change evidence,
    reopen transitions). Metrics, windows and reports live in baseline.py.

Inputs
    <snapshots>/<AS_OF date>/warden.db   frozen copy, opened mode=ro (never the live ledger)
    ../lib/redact.py

Run
    Not run directly; `python3 -I baseline.py` and `python3 -I cost.py` import it.
    env: AS_OF (default 2026-10-22T08:00:00Z), FACTORY_SNAPSHOTS (default ~/.local/share/factory/snapshots)
"""

from __future__ import annotations

import datetime as dt
import json
import math
import os
import re
import sqlite3
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
sys.dont_write_bytecode = True  # the evidence tree stays free of .pyc files
from redact import redact  # noqa: E402

UTC = dt.timezone.utc
AS_OF_RAW = os.environ.get("AS_OF", "2026-10-22T08:00:00Z")
SNAP_ROOT = Path(os.environ.get("FACTORY_SNAPSHOTS", "~/.local/share/factory/snapshots")).expanduser()

WINDOWS = (("14d", 14), ("30d", 30), ("90d", 90), ("all", None))
TERMINAL_SET = ("closed", "quiet", "fixed", "failed")  # reopen_rate: states an item can come back from
NON_TERMINAL = ("new", "triaged", "working", "merging", "verifying", "needs_decision")
RESOLVED_CLOSE = ("resolved", "fixed_by")
FAMILIES = ("slack_alert", "slack_update", "human", "hermes_log", "github_*", "uk", "hyperdx", "other")

HAND_CLOSE_PREFIX = "closed by hand"
REINVEST_PREFIX = "re-investigation requested"
# Owner-like transition notes that DEFINITIONS.md does not name; reported as a sensitivity only.
UNLISTED_TOUCH_PREFIXES = ("retried by owner", "adopted by owner", "aborted:", "revived by scripts/reset-frozen-notes.py")
RECOVERY_RE = re.compile(r"recover|signal quiet|no new occurrence|nothing left", re.I)
IGNORE_NOTE_PREFIXES = ("matched the policy ignore list", "unstructured #alerts prose", "aborted:")
SHA_RE = re.compile(r"\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b")
NOT_A_COMMIT_BEFORE = re.compile(r"(job|verdict|episode|dispatch|session|op)\s*#?\s*$", re.I)
DISMISSAL_RE = re.compile(r"duplicate of|log noise|false positive|superseded|not a defect|not a fault", re.I)


# ----------------------------------------------------------------------------- helpers
def parse_ts(s):
    if s is None or s == "":
        return None
    s = str(s).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    d = dt.datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=UTC)
    return d.astimezone(UTC)


def iso(d):
    return None if d is None else d.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


AS_OF = parse_ts(AS_OF_RAW)


def rx(text):
    """Free text from the ledger goes through the shared redactor before it is written."""
    return redact(str(text)) if text is not None else None


def pctl(sorted_vals, p):
    n = len(sorted_vals)
    if n == 0:
        return None
    k = (n - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def kaplan_meier(event_durations, censored_durations):
    """Median and p90 of a right-censored duration sample (hours). None when the curve never gets there."""
    data = [(d, 1) for d in event_durations] + [(d, 0) for d in censored_durations]
    data.sort(key=lambda x: (x[0], -x[1]))
    at_risk, surv, med, p90, i = len(data), 1.0, None, None, 0
    while i < len(data):
        t, deaths, leaves, j = data[i][0], 0, 0, i
        while j < len(data) and data[j][0] == t:
            deaths += data[j][1]
            leaves += 1
            j += 1
        if deaths:
            surv *= 1 - deaths / at_risk
            if med is None and surv <= 0.5:
                med = t
            if p90 is None and surv <= 0.1:
                p90 = t
        at_risk -= leaves
        i = j
    return med, p90


def rate(n, d):
    return None if not d else round(n / d, 4)


def pc(n, d):
    return "n/a" if not d else f"{100 * n / d:.1f} %"


def fmt_h(h):
    if h is None:
        return "n/a"
    return f"{h:.1f} h" if h < 48 else f"{h / 24:.1f} d"


def r1(x):
    return None if x is None else round(x, 2)


def family_of(source):
    if source in ("slack_alert", "slack_update", "human", "hermes_log", "uk", "hyperdx"):
        return source
    return "github_*" if source.startswith("github_") else "other"


def norm_title(title):
    """Normalised title: lowercase, symbols and emoji stripped, every token with a digit dropped."""
    s = unicodedata.normalize("NFKC", title or "").lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return " ".join(t for t in s.split() if not re.search(r"\d", t))


def lower_note(t):
    return (t.note or "").strip().lower()


def md_table(headers, rows):
    out = ["|" + "|".join(headers) + "|", "|" + "|".join("-" for _ in headers) + "|"]
    out += ["|" + "|".join(str(c) for c in r) + "|" for r in rows]
    return "\n".join(out)


# ----------------------------------------------------------------------------- load
def open_ro(path):
    return sqlite3.connect(f"file:{quote(str(path))}?mode=ro", uri=True)


snap_dir = SNAP_ROOT / AS_OF_RAW[:10]
db_path = snap_dir / "warden.db"
if not db_path.exists():
    sys.exit(f"ledger: snapshot missing: {db_path} (run evidence/snapshot.sh)")
con = open_ro(db_path)
con.row_factory = sqlite3.Row

rows = []
for r in con.execute(
    """SELECT t.event_id, t.repo, t.state, t.origin, t.created_at, t.updated_at, t.first_seen AS ti_first_seen,
              t.close_reason, t.duplicate_of, t.pr_url, t.merged_sha, t.fixed_by_pr, t.revert_pr, t.reverting_sha,
              e.source, e.title, e.first_seen AS ev_first_seen, e.resolved_at AS ev_resolved_at
       FROM triage_items t JOIN events e ON e.id = t.event_id ORDER BY t.event_id"""
):
    created = parse_ts(r["created_at"])
    if created is None or created >= AS_OF:
        continue
    rows.append(SimpleNamespace(**dict(r), created=created))
by_id = {r.event_id: r for r in rows}

trans_by = defaultdict(list)
n_trans_total = n_trans_after = 0
for r in con.execute("SELECT id, event_id, from_state, to_state, at, note FROM item_transitions ORDER BY id"):
    n_trans_total += 1
    at = parse_ts(r["at"])
    if at is None or at >= AS_OF:
        n_trans_after += 1
        continue
    if r["event_id"] in by_id:
        trans_by[r["event_id"]].append(
            SimpleNamespace(id=r["id"], frm=r["from_state"], to=r["to_state"], at=at, note=r["note"] or "")
        )

ops_by = defaultdict(list)
for r in con.execute("SELECT op_id, event_id, kind, authorized_by, started_at, outcome FROM operations"):
    st = parse_ts(r["started_at"])
    if st is None or st >= AS_OF:
        continue
    ops_by[r["event_id"]].append(SimpleNamespace(**dict(r), started=st))

events_by_source = Counter(
    r["source"] for r in con.execute("SELECT source, first_seen FROM events") if (parse_ts(r["first_seen"]) or AS_OF) < AS_OF
)
all_transitions = [t for ts in trans_by.values() for t in ts]
log_start = min((t.at for t in all_transitions), default=None)
latest_transition = max((t.at for t in all_transitions), default=None)
latest_row_update = max((parse_ts(r.updated_at) for r in rows), default=None)
snapshot_mtime = None
try:
    snapshot_mtime = dt.datetime.fromtimestamp(db_path.stat().st_mtime, UTC)
except OSError:
    pass


# ----------------------------------------------------------------------------- per-item derivation
def closed_reason(rec, k, trs):
    """close_reason of the k-th transition into `closed`. The ledger clears it when an item leaves `closed`,
    so only the item's current closure has it recorded; earlier closures are inferred from the note."""
    t = trs[k]
    if rec.row_current and k == len(trs) - 1 and rec.state == "closed":
        return rec.close_reason, "row"
    n = lower_note(t)
    if n.startswith("attached to #"):
        return "duplicate", "inferred"
    if n.startswith("fixed by"):
        return "fixed_by", "inferred"
    if n == "" or n.startswith(IGNORE_NOTE_PREFIXES):
        return "ignored", "inferred"
    return "resolved", "inferred"


def quiet_recovered(rec, t):
    n = t.note or ""
    if RECOVERY_RE.search(n):
        return True
    ev_res = parse_ts(rec.ev_resolved_at)
    return n == "" and ev_res is not None and ev_res < AS_OF


def derive(rec):
    trs = trans_by.get(rec.event_id, [])
    ops = ops_by.get(rec.event_id, [])
    rec.trs = trs
    rec.row_current = (parse_ts(rec.updated_at) or AS_OF) < AS_OF
    rec.state = trs[-1].to if trs else (rec.state if rec.row_current else "new")
    rec.family = family_of(rec.source)
    rec.repo_label = rx(rec.repo) if rec.repo else "(none)"
    ti_fs, ev_fs = parse_ts(rec.ti_first_seen), parse_ts(rec.ev_first_seen)
    rec.t0 = min(x for x in (rec.created, ti_fs, ev_fs) if x is not None)
    rec.event_fs_later = bool(ev_fs and ti_fs and ev_fs > ti_fs)

    # item vs duplicate (DEFINITIONS `item`)
    if rec.row_current:
        rec.is_dup = rec.close_reason == "duplicate" or rec.duplicate_of is not None
    else:
        last_closed = next((t for t in reversed(trs) if t.to == "closed"), None)
        rec.is_dup = rec.state == "closed" and last_closed is not None and lower_note(last_closed).startswith("attached to #")

    # escalated (DEFINITIONS `escalated`)
    nd = [t for t in trs if t.to == "needs_decision"]
    rec.nd_count = len(nd)
    rec.escalated = bool(nd)
    rec.nd_first = nd[0].at if nd else None

    # owner_touch (DEFINITIONS `owner_touch`)
    hand = [t for t in trs if lower_note(t).startswith(HAND_CLOSE_PREFIX)]
    rec.hand_close = bool(hand)
    rec.reinvest = any(lower_note(t).startswith(REINVEST_PREFIX) for t in trs)
    rec.op_touch = any(o.authorized_by.lower().startswith(("owner:", "cli:")) for o in ops)
    rec.touch = rec.escalated or rec.hand_close or rec.reinvest or rec.op_touch
    rec.unlisted_touch = any(lower_note(t).startswith(UNLISTED_TOUCH_PREFIXES) for t in trs)
    first_hand = lower_note(hand[0]) if hand else ""
    rec.hand_actor = ("improve_loop" if "improve loop" in first_hand else "hermes" if "hermes" in first_hand
                      else "owner_or_unspecified") if hand else None
    rec.hand_dismissal = bool(hand) and bool(DISMISSAL_RE.search(first_hand))
    rec.hand_dup_unflagged = (not rec.is_dup) and any(
        re.search(r"duplicate of", lower_note(t)) and lower_note(t).startswith((HAND_CLOSE_PREFIX, "aborted:")) for t in trs)

    # resolved (DEFINITIONS `resolved`): every transition into a resolved state, with the evidence class
    rec.res_events = []  # (at, kind, kind_inferred_from_note)
    rec.n_closed_inferred = 0
    for k, t in enumerate(trs):
        kind = inferred = None
        if t.to == "fixed":
            kind = "fixed"
        elif t.to == "closed":
            reason, src = closed_reason(rec, k, trs)
            if src == "inferred":
                rec.n_closed_inferred += 1
            if reason in RESOLVED_CLOSE:
                kind, inferred = "closed_" + reason, src == "inferred"
        elif t.to == "quiet" and quiet_recovered(rec, t):
            kind = "quiet_recovery"
        if kind:
            rec.res_events.append((t.at, kind, bool(inferred)))
    rec.resolved_first_at = rec.resolved_first_kind = None
    rec.resolved_inferred = False
    rec.resolved_ever = bool(rec.res_events)
    if rec.res_events:
        rec.resolved_first_at, rec.resolved_first_kind, rec.resolved_inferred = rec.res_events[0]
    if not trs:  # no history: the item predates the transition log, current state is all there is
        ev_res = parse_ts(rec.ev_resolved_at)
        if rec.state == "fixed" or (rec.state == "closed" and rec.close_reason in RESOLVED_CLOSE):
            rec.resolved_ever, rec.resolved_first_kind = True, "no_history_" + rec.state
        elif rec.state == "quiet" and ev_res is not None and ev_res < AS_OF:
            rec.resolved_ever, rec.resolved_first_kind, rec.resolved_first_at = True, "quiet_recovery", ev_res
            rec.res_events.append((ev_res, "quiet_recovery", False))

    # outcome at AS_OF (mutually exclusive buckets)
    final_reason = None
    if rec.state == "closed":
        last_k = max((k for k, t in enumerate(trs) if t.to == "closed"), default=None)
        final_reason = closed_reason(rec, last_k, trs)[0] if last_k is not None else rec.close_reason
    rec.final_reason = final_reason
    if rec.state == "fixed":
        rec.outcome = "resolved"
    elif rec.state == "closed":
        rec.outcome = ("resolved" if final_reason in RESOLVED_CLOSE else "ignored" if final_reason == "ignored"
                       else "duplicate" if final_reason == "duplicate" else "closed_unknown")
    elif rec.state == "quiet":
        last_q = next((t for t in reversed(trs) if t.to == "quiet"), None)
        ok = quiet_recovered(rec, last_q) if last_q else (parse_ts(rec.ev_resolved_at) is not None)
        rec.outcome = "resolved" if ok else "quiet_unrecovered"
    elif rec.state == "failed":
        rec.outcome = "failed"
    elif rec.state == "needs_decision":
        rec.outcome = "awaiting_owner"
    else:
        rec.outcome = "in_progress"

    # reopen_rate (DEFINITIONS `reopen_rate`)
    rec.reopen_trans = [t for t in trs if t.frm in TERMINAL_SET and t.to in NON_TERMINAL]
    rec.reopened = bool(rec.reopen_trans)
    reached = {t.to for t in trs} & set(TERMINAL_SET)
    if not trs and rec.state in TERMINAL_SET:
        reached = {rec.state}
    rec.reached_terminal = bool(reached)
    rec.reached_nofail = bool(reached & {"closed", "quiet", "fixed"})
    rec.reopen_nofail = any(t.frm in ("closed", "quiet", "fixed") and t.to in NON_TERMINAL for t in trs)

    # change evidence for regression_rate, and when the change first existed (a fix is a resolution at or after it)
    ev, change_times = set(), []
    if rec.merged_sha:
        ev.add("merged_sha")
    merge_ops = [o for o in ops if o.kind == "merge" and o.outcome == "done"]
    if merge_ops:
        ev.add("merge_operation")
        change_times += [o.started for o in merge_ops]
    if rec.fixed_by_pr:
        ev.add("fixed_by_pr")
    if rec.pr_url:
        ev.add("pr_url")
    for t in hand:
        for m in SHA_RE.finditer(t.note):
            if not NOT_A_COMMIT_BEFORE.search(t.note[max(0, m.start() - 14):m.start()]):
                ev.add("hand_close_commit")
                change_times.append(t.at)
    change_times += [t.at for t in trs if t.to == "merging" or lower_note(t).startswith(("pr_opened", "pr_updated"))]
    rec.change_evidence = ev
    rec.t_change = min(change_times) if change_times else None
    # merged by warden: a merge operation or merged_sha, or the item entered `verifying` (which only a merge opens)
    rec.merged_by_warden = bool(ev & {"merged_sha", "merge_operation"}) or any(t.to == "verifying" for t in trs)
    rec.reverted = rec.revert_pr is not None or rec.reverting_sha is not None
    rec.revert_impossible = any("cannot auto-revert" in lower_note(t) for t in trs)
    rec.verify_failed = any(t.frm == "verifying" and t.to == "failed" for t in trs)
    rec.norm = norm_title(rec.title)
    return rec


for _r in rows:
    derive(_r)
items_all = [r for r in rows if not r.is_dup]
dups_all = [r for r in rows if r.is_dup]
norm_index = defaultdict(list)
for _r in rows:
    if _r.norm:
        norm_index[_r.norm].append(_r)


def cohort(window_days):
    lo = None if window_days is None else AS_OF - dt.timedelta(days=window_days)
    pick = lambda xs: [r for r in xs if lo is None or r.created >= lo]
    return lo, pick(rows), pick(items_all), pick(dups_all)


