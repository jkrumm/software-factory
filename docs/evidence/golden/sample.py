#!/usr/bin/env python3
"""Golden set, step 1: the sampling frame and the label packets.

Question: which warden events does a labeller get, and what mechanical evidence travels
with each, so that B-cubed grouping quality, escalation precision/recall and the
known-fix share can later be estimated against labelled truth?

Method (research/2026-10-22-ops-correlation-catalog-eval.md, section 5): entity-centric
sampling. An ENTITY is an incident candidate: one warden item plus its duplicate children
(`duplicate_of` chain resolved to the root); an event without a ledger row is a singleton
entity. Occurrences are a counter on the item, not separate rows. ENTITIES are drawn,
stratified by source family x outcome x period, in a fixed pseudo-random order (SHA-256
rank of seed + root event id), until the drawn entities cover >= TARGET_EVENTS events.
Escalated entities (`escalated` in DEFINITIONS.md) are a census sub-stratum of every
cell, and so is a pool of <= CENSUS_MAX_N entities. Then every other event whose
first_seen lies within +-30 min of a sampled event is added as context (`context: true`,
labelled like the rest). Estimation weights: 1 for census entities, N_pool / n_pool for
drawn ones; a context event is never an estimation element.

Definition keys (DEFINITIONS.md): `item`, `escalated`, `owner_touch`, `resolved` (the
outcome strata). Entities whose text names a service of a self-contained private repo are
dropped from the frame (counted in sample.out.json, never named).

Inputs, all read-only: snapshot warden.db (events, triage_items, item_transitions,
dispatches, operations) and agw-jobs.db (job_stats.error_head of failed dispatches); the
git history of the repos under ~/SourceRoot (`git log --before AS_OF`). IuRoot is never read.
Every row is filtered to < AS_OF; every free-text field goes through lib/redact.py.

Outputs, next to this script: sample.out.json (strata, totals, seed, weights) and
packets.jsonl, one line per event in time order. Packet keys: id, chunk, context, sample
{stratum, forced, weight}, entity {id, root, size, root_outcome, escalated, peers}, source,
external_id, first_seen, title, payload, event {resolved_at, reminders, msg_first, msg_last},
item, escalation {n, first_at, last_at, category, question, verdict_question},
transitions (strings `at from→to [×n] [| note]`), transitions_total, dispatches,
fix_commits, neighbours (+-30 min, in the set), neighbours_outside_set, pre_group,
pre_escalated, pre_owner_touch, pre_has_fix_commit, pre_prior_same_signature.
Deterministic: same snapshot, same bytes.

Run:  cd docs/evidence/golden && python3 -I sample.py
Env:  AS_OF (default 2026-10-22T08:00:00Z), FACTORY_SNAPSHOTS (default
      ~/.local/share/factory/snapshots).
"""

from __future__ import annotations

import bisect
import datetime as dt
import hashlib
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True          # no __pycache__ in the shared lib/ dir
sys.path.insert(0, str(HERE.parent / "lib"))
from redact import redact as _redact  # noqa: E402

# ---------------------------------------------------------------------------- constants

AS_OF_STR = os.environ.get("AS_OF", "2026-10-22T08:00:00Z")
SEED = "golden-2026-10-22-v1"
TARGET_EVENTS = 400          # sampled events (before context) the draw must cover
ESCALATED_TARGET = 120       # items the brief asks for; capped by what the snapshot holds
CENSUS_MAX_N = 3             # a pool this small is taken whole
FLOOR = 2                    # minimum pool draw per cell (when the pool has that many)
LAMBDA_STEP = 0.05           # pool draw n_h = max(FLOOR, ceil(lambda * sqrt(N_pool)))
WINDOW_MIN = 30              # context window, minutes, both sides
EXTERNAL_ID_MAX, TITLE_MAX, PAYLOAD_MAX, NOTE_MAX, VERDICT_MAX, SUBJECT_MAX = 80, 200, 400, 120, 300, 100
ITEM_NOTE_MAX, QUESTION_MAX, PEER_TITLE_MAX = 200, 300, 80
MAX_TRANSITIONS = 16
SOURCE_ROOT = Path.home() / "SourceRoot"
SNAP_DIR = Path(os.environ.get("FACTORY_SNAPSHOTS", Path.home() / ".local/share/factory/snapshots")) / AS_OF_STR[:10]

# Private, self-contained repos: name only, no commit subjects, and no entity text in the frame.
NAME_ONLY_REPOS = frozenset({"homelab-private", "dotfiles-private"})
# Generic words in the titles of private-repo items; everything else in those titles is a
# service name and becomes a runtime-derived term that excludes any entity mentioning it.
GENERIC = frozenset("""
    the and for with from into that this have been was were are not but its has had out off over
    app docker container containers state exited exit down push http https session sessions alert alerts
    monitor monitors status check checks current investigate rejected rotation rotated lost failed
    failure expires within hours still lists three first recent security obligation marked blind
    cookie cookies indexer indexers preferences homelab red circle white mark up healthy php put get
    vpn dead stale error errors timeout cron job jobs item items repo yes
""".split())

PERIODS = ("Apr-Jul", "Aug-Sep", "Oct")
FAMILIES = ("slack_alert", "slack_update", "human", "hermes_log", "github_*", "uk", "hyperdx", "other")
OUTCOMES = ("resolved", "ignored", "quiet", "needs_decision", "failed", "duplicate", "open", "unledgered")
TERMINAL = ("closed", "quiet", "fixed", "failed")      # DEFINITIONS.md reopen_rate
RECURRENCE_FROM = ("closed", "quiet", "fixed")         # an episode ends here; `failed` is a redrive, not a new episode


# ---------------------------------------------------------------------------- small helpers

def parse_ts(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


AS_OF = parse_ts(AS_OF_STR)
assert AS_OF is not None


def ts_short(d: dt.datetime | None) -> str | None:
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if d else None


_WS = re.compile(r"\s+")
_OPREF = re.compile(r"op://[^\s'\"`)>\]|]+")
_SLACK_LABEL = re.compile(r"<https?://[^|>\s]+\|([^>]+)>")
_SLACK_BARE = re.compile(r"<(https?://[^>|\s]+)>")
_SHA40 = re.compile(r"\b[0-9a-f]{40}\b")
_USERS = re.compile(r"(?i)(?<![\w.-])/users/[a-z0-9._-]*")
_INTERNAL_URL = re.compile(r"(?i)\bhttps?://[a-z0-9-]+(?::\d+)?(?=[/\s\"'>)\]|,;]|$)")   # single-label host: a container or LAN name
_HOST_SLUG = re.compile(r"(?i)(?<![a-z0-9])(?:[a-z0-9]+-)?jkrumm-com(?![a-z0-9])")   # slugs of titles carry hosts hyphenated
LOCAL_GATE = re.compile(r"(?i)jkrumm-com|(?<![\w.-])/users/|\.ts\.net|\.jkrumm\.com|\bhttps?://[a-z0-9-]+(?::\d+)?(?=[/\s\"'>)\]|,;]|$)")


def clean(text, limit: int) -> str:
    """Whitespace-collapsed, Slack links unwrapped, 40-hex ids shortened, redacted FIRST, truncated after
    (a cut can never expose the prefix of a secret)."""
    if text is None:
        return ""
    t = _WS.sub(" ", str(text)).strip()
    t = _SLACK_LABEL.sub(r"\1", t)
    t = _SLACK_BARE.sub(r"\1", t)
    t = _SHA40.sub(lambda m: m.group(0)[:10], t)
    t = _OPREF.sub("op://<ref>", t)
    t = _USERS.sub("~", t)
    t = _INTERNAL_URL.sub("http://<internal-host>", t)
    t = _HOST_SLUG.sub("<internal-host>", t)
    t = _redact(t)
    return t if len(t) <= limit else t[: limit - 1].rstrip() + "…"


def safe_json(s: str | None):
    if not s:
        return None
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return None


def rank_key(entity_key: str) -> str:
    return hashlib.sha256(f"{SEED}|{entity_key}".encode()).hexdigest()


def family_of(source: str) -> str:
    if source in ("github_go", "github_pr", "github_issue"):
        return "github_*"
    return source if source in FAMILIES else "other"


def period_of(t: dt.datetime) -> str:
    if t < dt.datetime(2026, 8, 1, tzinfo=dt.timezone.utc):
        return "Apr-Jul"
    if t < dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc):
        return "Aug-Sep"
    return "Oct"


# ---------------------------------------------------------------------------- normalised signatures

_SLACK_LINK = re.compile(r"<(?:https?://[^|>]*\|)?([^>]*)>")
_BATCH = re.compile(r"\s*\(×\d+ in batch\)")
_QUOTED = re.compile(r"(?<!\w)'[^']*'(?!\w)|(?<!\w)\"[^\"]*\"(?!\w)")   # a quote that opens a word, never a contraction
_TS = re.compile(r"\b\d{4}-\d{2}-\d{2}[ t]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:z|[+-]\d{2}:?\d{2})?")
_HEX = re.compile(r"\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b")
_NUM = re.compile(r"\d+")
_KUMA = re.compile(r"^\*?\[(?P<mon>[^\]]+)\]\s*\[:(?:red_circle|white_check_mark):[^\]]*\]", re.I)


def norm_text(t: str) -> str:
    t = (t or "").lower()
    t = _SLACK_LINK.sub(lambda m: m.group(1), t)
    t = _BATCH.sub("", t)
    t = _QUOTED.sub("'#'", t)
    t = _TS.sub("#", t)
    t = _HEX.sub("#", t)
    t = _NUM.sub("#", t)
    return _WS.sub(" ", t).strip()[:100]


def sig_key(source: str, title: str) -> str:
    """Normalised signature: the monitor name for a Kuma monitor (uk event or its Slack relay, so a Down
    pairs with its Up and with the monitor row); the volatile-token-free title for everything else."""
    if source == "uk":
        return norm_text(title)
    m = _KUMA.match(title or "") if source == "slack_alert" else None
    return norm_text(m.group("mon")) if m else norm_text(title)


# ---------------------------------------------------------------------------- git index

SHA_RE = re.compile(r"(?<![0-9A-Za-z])[0-9a-f]{7,40}(?![0-9A-Za-z])")
FIX_WORDS = re.compile(r"\b(fix(?:ed|es)?|landed|shipped|resolved|hardening|merged|root cause|patched|bumped|reverted)\b", re.I)
PR_URL = re.compile(r"https://github\.com/[\w.-]+/([\w.-]+)/pull/(\d+)")
PR_SUBJECT = re.compile(r"\(#(\d+)\)\s*$")
_CATEGORY = re.compile(r"\[([A-Za-z_ -]{3,24})\]")   # warden prefixes an escalation note with [product], [security], [blocker] ...


class GitIndex:
    """Commit metadata of the repos warden worked on, read once with `git log --before AS_OF`."""

    def __init__(self, names: set[str]):
        self.commits: dict[str, dict[str, tuple[dt.datetime, str]]] = {}
        self.pr: dict[str, dict[int, list[str]]] = {}
        self.prefix: dict[str, list[tuple[str, str]]] = defaultdict(list)
        for name in sorted(names):
            path = SOURCE_ROOT / name
            if not (path / ".git").exists():
                continue
            out = subprocess.run(
                ["git", "--no-optional-locks", "-C", str(path), "log", "--branches", "--remotes", "--tags",
                 f"--before={AS_OF_STR}", "--format=%H%x1f%cI%x1f%s%x1e"],
                capture_output=True, text=True, check=False).stdout
            repo_commits: dict[str, tuple[dt.datetime, str]] = {}
            repo_pr: dict[int, list[str]] = defaultdict(list)
            for rec in out.split("\x1e"):
                parts = rec.strip("\n").split("\x1f")
                if len(parts) != 3 or not parts[0]:
                    continue
                sha, when, subject = parts
                repo_commits[sha] = (parse_ts(when), subject)
                self.prefix[sha[:7]].append((name, sha))
                m = PR_SUBJECT.search(subject)
                if m:
                    repo_pr[int(m.group(1))].append(sha)
            self.commits[name] = repo_commits
            self.pr[name] = dict(repo_pr)

    def lookup(self, token: str, prefer: str | None) -> tuple[str, str] | None:
        """(repo, full sha) for a 7-40 char hex prefix; the preferred repo first; ambiguous -> None."""
        cands = [(r, s) for r, s in self.prefix.get(token[:7], []) if s.startswith(token)]
        if prefer:
            own = [c for c in cands if c[0] == prefer]
            if own:
                cands = own
        return cands[0] if len({s for _, s in cands}) == 1 else None


# ---------------------------------------------------------------------------- load snapshot

def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def load():
    warden = connect(SNAP_DIR / "warden.db")
    agw = connect(SNAP_DIR / "agw-jobs.db")
    events = {}
    for r in warden.execute("SELECT * FROM events ORDER BY id"):
        r = dict(r)
        t = parse_ts(r["first_seen"])
        if t is None or t >= AS_OF:
            continue
        r["_t"] = t
        r["payload"] = safe_json(r["payload_json"])
        resolved = parse_ts(r["resolved_at"])
        r["resolved_at"] = r["resolved_at"] if resolved and resolved < AS_OF else None
        events[r["id"]] = r
    items = {}
    for r in warden.execute("SELECT * FROM triage_items"):
        r = dict(r)
        created = parse_ts(r["created_at"])
        if r["event_id"] in events and created and created < AS_OF:
            items[r["event_id"]] = r
    trans: dict[int, list[dict]] = defaultdict(list)
    for r in warden.execute("SELECT * FROM item_transitions ORDER BY id"):
        r = dict(r)
        t = parse_ts(r["at"])
        if t and t < AS_OF and r["event_id"] in items:
            r["_t"] = t
            trans[r["event_id"]].append(r)
    disp = []
    for r in warden.execute("SELECT * FROM dispatches ORDER BY id"):
        r = dict(r)
        t = parse_ts(r["created_at"])
        if t and t < AS_OF:
            r["_t"] = t
            disp.append(r)
    ops = defaultdict(list)
    for r in warden.execute("SELECT * FROM operations ORDER BY started_at, op_id"):
        r = dict(r)
        t = parse_ts(r["started_at"])
        if t and t < AS_OF and r["event_id"] in items:
            ops[r["event_id"]].append(r)
    agw_stats = {r["id"]: dict(r) for r in agw.execute("SELECT id, tool, status, error_head, model, backend FROM job_stats")}
    return events, items, trans, disp, ops, agw_stats


# ---------------------------------------------------------------------------- entities and outcomes

def build_entities(events, items):
    def root_of(eid: int) -> int:
        seen = set()
        while eid in items and items[eid]["duplicate_of"] in items and eid not in seen:
            seen.add(eid)
            eid = items[eid]["duplicate_of"]
        return eid

    members: dict[int, list[int]] = defaultdict(list)
    root_for: dict[int, int] = {}
    for eid in events:
        r = root_of(eid)
        members[r].append(eid)
        root_for[eid] = r
    for r in members:
        members[r].sort(key=lambda e: (events[e]["_t"], e))
    return members, root_for


def item_state(item: dict, rows: list[dict]) -> str:
    return rows[-1]["to_state"] if rows else item["state"]


def item_outcome(item: dict | None, state: str, n_members: int) -> str:
    if item is None:
        return "unledgered"
    if n_members > 1:
        return "duplicate"
    if state == "closed":
        return {"resolved": "resolved", "fixed_by": "resolved", "ignored": "ignored", "duplicate": "duplicate"}.get(item["close_reason"] or "", "resolved")
    if state == "fixed":
        return "resolved"
    return state if state in ("quiet", "needs_decision", "failed") else "open"


def episodes(rows: list[dict]) -> tuple[int, dt.datetime | None]:
    """(episodes, start of the latest): a transition out of closed/quiet/fixed back into work opens a new one."""
    n, latest = 1, None
    for r in rows:
        if r["from_state"] in RECURRENCE_FROM and r["to_state"] not in TERMINAL:
            n += 1
            latest = r["_t"]
    return n, latest or (rows[0]["_t"] if rows else None)


# ---------------------------------------------------------------------------- payload excerpt

EXCERPT_KEYS = {
    "slack_alert": ("first_text", "batch_count", "batch_count_last"),
    "slack_update": ("first_text", "batch_count", "batch_count_last"),
    "hermes_log": ("first_line", "batch_count", "batch_count_last"),
    "human": ("why",),
    "github_go": ("repo", "number", "labels", "author"),
    "github_pr": ("repo", "author"),
    "github_issue": ("repo", "author"),
    "uk": ("type", "status", "via"),
    "hyperdx": ("state", "via", "message", "value"),
    "job": ("label", "owner", "grade", "reason", "rc", "consecutive_fail", "fails_24h", "last_ok", "every", "tail"),
    "docker_homelab": ("host", "kind"), "docker_vps": ("host", "kind"),
    "op_refs_homelab": ("host", "raw_error"), "op_refs_vps": ("host", "raw_error"),
    "hermes_cron": ("error", "last_run_at"),
    "stray_skill": ("path", "patch_count", "created_by"),
    "warden_self": ("first_text",), "warden_canary": ("canary",),
}
TEXT_KEYS = ("first_text", "first_line", "why")
COUNT_KEYS = ("batch_count", "batch_count_last")
_LOG_LINE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[,.]\d+\s+(ERROR|WARNING|INFO|CRITICAL|DEBUG)\s+(.*)$", re.S)


def excerpt(source: str, payload, shown_title: str) -> str:
    """The informative payload fields as `k=v; ...`; free text that merely repeats the title is cut to its continuation."""
    if not isinstance(payload, dict):
        return ""
    keys = EXCERPT_KEYS.get(source) or tuple(k for k, v in payload.items() if isinstance(v, (str, int, float, bool)))
    stem = _BATCH.sub("", shown_title.rstrip("…")).rstrip()
    parts = []
    for k in keys:
        v = payload.get(k)
        if v in (None, "", [], {}) or (k in COUNT_KEYS and v in (0, 1)):
            continue
        if isinstance(v, (list, dict)):
            v = json.dumps(v, ensure_ascii=False, separators=(",", ":"))
        text = clean(v, 10_000)
        if k in TEXT_KEYS:
            m = _LOG_LINE.match(text)
            if m:
                parts.append(f"log_at={m.group(1)}")
                parts.append(f"level={m.group(2)}")
                text = m.group(3)
            if text.startswith(stem):
                text = text[len(stem):].lstrip()
                if not text:
                    continue
                text = "…" + text
        parts.append(f"{k}={text}")
    return clean("; ".join(parts), PAYLOAD_MAX)


# ---------------------------------------------------------------------------- fix commits

def item_fix_commits(item: dict, rows: list[dict], ops_rows: list[dict], git: GitIndex) -> list[dict]:
    """Commits and PRs linked to an item: merged_sha, merge receipts, PR subject (#N), shas named in fix-worded notes."""
    repo = item["repo"] or None
    out: dict[tuple, dict] = {}

    def add(via: str, repo_name: str | None, sha: str | None, pr: int | None = None, merged: bool | None = None):
        meta = git.commits.get(repo_name or "", {}).get(sha or "") if sha else None
        key = (repo_name, sha or f"pr{pr}")
        if key in out:
            return
        entry = {"repo": repo_name, "sha": sha[:10] if sha else None, "subject": None, "date": None, "via": via}
        if meta:
            entry["date"] = ts_short(meta[0])
            if repo_name not in NAME_ONLY_REPOS:
                entry["subject"] = clean(meta[1], SUBJECT_MAX)
        elif sha:
            entry["unresolved"] = True
        if pr is not None:
            entry["pr"] = pr
        if merged is not None:
            entry["merged"] = merged
        out[key] = entry

    if item.get("merged_sha"):
        hit = git.lookup(item["merged_sha"], repo)
        add("merged_sha", hit[0] if hit else repo, hit[1] if hit else item["merged_sha"])
    for op in ops_rows:
        if op["kind"] != "merge" or op["outcome"] != "done":
            continue
        receipt = safe_json(op["receipt_json"]) or {}
        mc = receipt.get("mergeCommit")
        if mc:
            hit = git.lookup(mc, op["repo"] or repo)
            add("merge_receipt", hit[0] if hit else op["repo"], hit[1] if hit else mc, receipt.get("pullRequest"), True)
    m = PR_URL.search(item.get("pr_url") or "")
    if m:
        pr_repo, pr_num = m.group(1), int(m.group(2))
        shas = git.pr.get(pr_repo, {}).get(pr_num, [])
        landed = [e for e in out.values() if e["via"] in ("merged_sha", "merge_receipt")]
        for e in landed:
            e.setdefault("pr", pr_num)
        if shas:
            add("pr_subject", pr_repo, shas[0], pr_num, True)
        elif not landed:
            add("pr_url", pr_repo, None, pr_num, False)
    for text in [item.get("note") or ""] + [r["note"] or "" for r in rows]:
        if not FIX_WORDS.search(text):
            continue
        named = [n for n in git.commits if re.search(rf"\b{re.escape(n)}\b", text)]
        for tok in SHA_RE.findall(text):
            hit = git.lookup(tok, named[0] if len(named) == 1 else repo)
            if hit:
                add("note", hit[0], hit[1])
    return sorted(out.values(), key=lambda e: (e["date"] or "9", e["via"], e["sha"] or ""))


# ---------------------------------------------------------------------------- dispatch summaries

def verdict_text(d: dict, agw_stats) -> tuple[dict, str]:
    v = safe_json(d["verdict_json"])
    meta: dict = {"status": d["status"]}
    if not isinstance(v, dict):
        err = d.get("error") or (agw_stats.get(d["job_id"]) or {}).get("error_head") or ""
        return meta, f"error: {err}" if err else ""
    for src, dst in (("outcome", "outcome"), ("confidence", "conf"), ("nextAction", "next")):
        if isinstance(v.get(src), str):
            meta[dst] = v[src]
    if d["tier"] == "review":
        meta["blocking"] = len(v["blocking"]) if isinstance(v.get("blocking"), list) else 0
    pieces = []
    for label, key in (("Q", "decisionQuestion"), ("rc", "rootCause"), ("PR", "prTitle"), ("S", "summary")):
        if isinstance(v.get(key), str) and v[key].strip():
            pieces.append(f"{label}: {clean(v[key], 200 if label == 'S' else 150)}")
    return meta, " | ".join(pieces)


def dispatch_summary(disp_rows: list[dict], agw_stats) -> list[dict]:
    by_tier: dict[str, list[dict]] = defaultdict(list)
    for d in disp_rows:
        by_tier[d["tier"]].append(d)
    out = []
    for tier in ("investigate", "author", "implement", "review"):
        rows = sorted(by_tier.get(tier, []), key=lambda d: (d["_t"], d["id"]))
        if not rows:
            continue
        last = ([d for d in rows if d["verdict_json"]] or rows)[-1]
        meta, text = verdict_text(last, agw_stats)
        entry = {"tier": tier, "n": len(rows), **meta}
        if len(rows) > 1:
            entry["failed"] = sum(1 for d in rows if d["status"] == "failed")
        entry["text"] = clean(text, VERDICT_MAX)
        out.append(entry)
    return out


# ---------------------------------------------------------------------------- transitions

def compact_transitions(rows: list[dict]) -> list[str]:
    runs: list[list] = []
    for r in rows:
        note = clean(r["note"], NOTE_MAX)
        entry = [r["from_state"] or "∅", r["to_state"], ts_short(r["_t"]), note, 1]
        if runs and runs[-1][0] == entry[0] and runs[-1][1] == entry[1] and runs[-1][3][:24] == note[:24]:
            runs[-1][3], runs[-1][4] = note, runs[-1][4] + 1
        else:
            runs.append(entry)
    lines = [f"{at} {f}→{t}" + (f" ×{n}" if n > 1 else "") + (f" | {note}" if note else "") for f, t, at, note, n in runs]
    if len(lines) > MAX_TRANSITIONS:
        elided = len(lines) - (MAX_TRANSITIONS - 1)
        lines = lines[:3] + [f"… {elided} entries elided"] + lines[-(MAX_TRANSITIONS - 4):]
    return lines


# ---------------------------------------------------------------------------- base packets

def event_block(ev: dict) -> dict:
    """resolved_at, reminders and, for Slack rows, the message times: first_seen is the poll that ingested the
    batch (up to ~35 min after the message); ts_last is the latest message, ts_first can be months older."""
    block = {"resolved_at": ts_short(parse_ts(ev["resolved_at"])), "reminders": ev["reminder_count"]}
    payload = ev["payload"] if isinstance(ev["payload"], dict) else {}
    stamps = {}
    for key, name in (("ts_first", "msg_first"), ("ts_last", "msg_last")):
        try:
            stamps[name] = ts_short(dt.datetime.fromtimestamp(float(payload[key]), dt.timezone.utc))
        except (KeyError, TypeError, ValueError, OverflowError, OSError):
            continue
    if stamps.get("msg_first") == stamps.get("msg_last"):
        stamps.pop("msg_first", None)
    return {**block, **stamps}


def build_base_packets(events, items, trans, disp, ops, agw_stats, members, root_for, git):
    disp_by_job = {d["job_id"]: d for d in disp}
    disp_by_event: dict[int, list[dict]] = defaultdict(list)
    for d in disp:
        if d["origin_event_id"] in items:
            disp_by_event[d["origin_event_id"]].append(d)
    for eid, it in items.items():
        have = {d["id"] for d in disp_by_event[eid]}
        for col in ("dispatch_job", "implement_job", "validation_job"):
            d = disp_by_job.get(it.get(col) or "")
            if d and d["id"] not in have:
                disp_by_event[eid].append(d)
                have.add(d["id"])

    cluster: dict[str, list[int]] = defaultdict(list)
    for eid, it in items.items():
        if it["dispatch_job"]:
            cluster[it["dispatch_job"]].append(eid)

    fix_cache = {eid: item_fix_commits(it, trans.get(eid, []), ops.get(eid, []), git) for eid, it in items.items()}
    escalated = {eid for eid, rows in trans.items() if any(r["to_state"] == "needs_decision" for r in rows)}

    packets: dict[int, dict] = {}
    meta: dict[int, dict] = {}
    for eid, ev in events.items():
        it = items.get(eid)
        rows = trans.get(eid, [])
        root = root_for[eid]
        group = members[root]
        root_item = items.get(root)
        root_outcome = item_outcome(root_item, item_state(root_item, trans.get(root, [])), 1) if root_item else "unledgered"
        peers = [{"id": m, "first_seen": ts_short(events[m]["_t"]), "source": events[m]["source"],
                  "state": item_state(items[m], trans.get(m, [])) if m in items else None,
                  "title": clean(events[m]["title"], PEER_TITLE_MAX)} for m in group if m != eid]

        item_block = escalation = None
        if it:
            state = item_state(it, rows)
            n_ep, latest_ep = episodes(rows)
            item_block = {
                "id": eid, "state": state, "close_reason": it["close_reason"] if state == "closed" else None,
                "root_cause": clean(it["root_cause"], 100) or None, "duplicate_of": it["duplicate_of"],
                "occurrences": it["occurrences"], "signature": clean(f"{ev['source']}:{ev['external_id']}", 120),
                "repo": it["repo"] or None, "origin": it["origin"], "created_at": ts_short(parse_ts(it["created_at"])),
                "last_seen": ts_short(parse_ts(it["last_seen"])), "episodes": n_ep, "latest_episode_at": ts_short(latest_ep),
                "note": clean(it["note"], ITEM_NOTE_MAX) or None,
            }
            esc_rows = [r for r in rows if r["to_state"] == "needs_decision"]
            if esc_rows:
                last_note = esc_rows[-1]["note"] or ""
                tag = _CATEGORY.match(last_note)
                question = clean(last_note, QUESTION_MAX)
                escalation = {"n": len(esc_rows), "first_at": ts_short(esc_rows[0]["_t"]), "last_at": ts_short(esc_rows[-1]["_t"]),
                              "category": tag.group(1).lower() if tag else None, "question": question}
                for d in sorted(disp_by_event.get(eid, []), key=lambda d: d["_t"], reverse=True):
                    v = safe_json(d["verdict_json"])
                    vq = v.get("decisionQuestion") if isinstance(v, dict) else None
                    if isinstance(vq, str) and vq.strip():
                        if clean(vq, 60).rstrip("…") not in question:
                            escalation["verdict_question"] = clean(vq, 200)
                        break

        fixes = fix_cache.get(eid, [])
        for f in fixes:
            f["rel"] = ("before_episode" if parse_ts(f["date"]) < ev["_t"] else "after_episode") if f["date"] else "undated"
        hard = [f for f in fixes if f["via"] in ("merged_sha", "merge_receipt", "pr_subject", "note")]
        hand = any((r["note"] or "").startswith(("closed by hand", "re-investigation requested")) for r in rows)
        ops_owner = any(str(o["authorized_by"]).startswith(("owner", "cli")) for o in ops.get(eid, []))

        packets[eid] = {
            "id": eid, "chunk": None, "context": False, "sample": None,
            "entity": {"id": f"E{root}", "root": root, "size": len(group), "root_outcome": root_outcome,
                       "escalated": any(m in escalated for m in group), "peers": peers},
            "source": ev["source"], "external_id": clean(ev["external_id"], EXTERNAL_ID_MAX), "first_seen": ts_short(ev["_t"]),
            "title": clean(ev["title"], TITLE_MAX),
            "payload": excerpt(ev["source"], ev["payload"], clean(ev["title"], TITLE_MAX)),
            "event": event_block(ev),
            "item": item_block, "escalation": escalation,
            "transitions": compact_transitions(rows), "transitions_total": len(rows),
            "dispatches": dispatch_summary(disp_by_event.get(eid, []), agw_stats) if it else [],
            "fix_commits": fixes[:4],
            "neighbours": [], "neighbours_outside_set": 0, "pre_group": {},
            "pre_escalated": eid in escalated, "pre_owner_touch": eid in escalated or hand or ops_owner,
            "pre_has_fix_commit": bool(hard), "pre_prior_same_signature": {},
        }
        meta[eid] = {"sig": sig_key(ev["source"], ev["title"]), "repo": (it["repo"] or None) if it else None, "root": root,
                     "cluster": [m for m in cluster.get(it["dispatch_job"], []) if m != eid] if it and it["dispatch_job"] else [],
                     "fix_hard": hard, "escalated": eid in escalated}
    return packets, meta


# ---------------------------------------------------------------------------- private-repo scrub

def derive_private_terms(events, items, root_for, members) -> set[str]:
    """Service names taken from the titles of items routed to a private repo (and their duplicates and
    cluster mates). Derived at run time, never written to any output."""
    seed = {e for e, it in items.items() if it["repo"] in NAME_ONLY_REPOS}
    jobs = {items[e]["dispatch_job"] for e in seed if items[e]["dispatch_job"]}
    seed |= {e for e, it in items.items() if it["dispatch_job"] in jobs}
    for e in list(seed):
        seed.update(members[root_for[e]])
    terms: set[str] = set()
    for e in seed:
        for tok in re.findall(r"[A-Za-z][A-Za-z0-9]{2,}", events[e]["title"] or ""):
            low = tok.lower()
            if low not in GENERIC and (len(low) >= 5 or tok.isupper()):
                terms.add(low)
    return terms


# ---------------------------------------------------------------------------- sampling

def allocate(strata: dict[tuple, dict], members: dict[int, list[int]], target: int):
    """Smallest lambda whose draw (census + escalated + pool draws) covers >= target events."""
    lam = 0.0
    while True:
        chosen: set[int] = set()
        for h in strata.values():
            chosen.update(h["forced"])
            pool = h["pool_order"]
            want = len(pool) if len(pool) <= CENSUS_MAX_N else min(len(pool), max(FLOOR, math.ceil(lam * math.sqrt(len(pool)))))
            chosen.update(pool[:want])
        if sum(len(members[e]) for e in chosen) >= target or lam > 50:
            return lam, chosen
        lam = round(lam + LAMBDA_STEP, 4)


# ---------------------------------------------------------------------------- main

def main() -> int:
    events, items, trans, disp, ops, agw_stats = load()
    members, root_for = build_entities(events, items)

    repo_names = {it["repo"] for it in items.values() if it["repo"]} | {d["repo"] for d in disp if d["repo"]}
    for it in items.values():
        m = PR_URL.search(it["pr_url"] or "")
        if m:
            repo_names.add(m.group(1))
    git = GitIndex(repo_names)
    packets, meta = build_base_packets(events, items, trans, disp, ops, agw_stats, members, root_for, git)

    # ---- private exclusions: items routed to a private repo, and any event whose packet names one of its services
    terms = derive_private_terms(events, items, root_for, members)
    term_re = re.compile("(?<![a-z0-9])(?:" + "|".join(re.escape(t) for t in sorted(terms)) + ")(?![a-z0-9])", re.I) if terms else None
    private_event = {e for e, p in packets.items()
                     if ((items[e]["repo"] if e in items else None) or "") in NAME_ONLY_REPOS
                     or (term_re and term_re.search(json.dumps(p, ensure_ascii=False)))}
    private_roots = {root_for[e] for e in private_event}
    excluded_events = {e for r in private_roots for e in members[r]}

    # ---- strata over the eligible population: family x outcome x period, escalated entities a census sub-stratum
    strata: dict[tuple, dict] = {}
    for root, group in members.items():
        if root in private_roots:
            continue
        item = items.get(root)
        outcome = item_outcome(item, item_state(item, trans.get(root, [])) if item else "", len(group))
        key = (family_of(events[root]["source"]), outcome, period_of(min(events[m]["_t"] for m in group)))
        h = strata.setdefault(key, {"entities": [], "forced": [], "pool_order": [], "events": 0})
        h["entities"].append(root)
        h["events"] += len(group)
    for h in strata.values():
        h["entities"].sort()
        h["forced"] = [r for r in h["entities"] if any(meta[m]["escalated"] for m in members[r])]
        forced = set(h["forced"])
        h["pool_order"] = sorted((r for r in h["entities"] if r not in forced), key=lambda r: rank_key(str(r)))

    lam, chosen = allocate(strata, members, TARGET_EVENTS)
    sampled_ids = sorted(e for r in chosen for e in members[r])
    sampled_set = set(sampled_ids)

    weight: dict[int, float] = {}
    forced_root: set[int] = set()
    stratum_of: dict[int, str] = {}
    for key, h in strata.items():
        drawn = [r for r in h["pool_order"] if r in chosen]
        w_pool = round(len(h["pool_order"]) / len(drawn), 4) if drawn else None
        for r in h["entities"]:
            stratum_of[r] = "|".join(key)
        for r in h["forced"]:
            weight[r] = 1.0
            forced_root.add(r)
        for r in drawn:
            weight[r] = w_pool

    # ---- +-30 min context around every sampled event
    times = sorted((events[e]["_t"], e) for e in events if e not in excluded_events)
    t_only = [t for t, _ in times]
    window = dt.timedelta(minutes=WINDOW_MIN)
    context_ids: set[int] = set()
    for e in sampled_ids:
        t = events[e]["_t"]
        context_ids.update(x for _, x in times[bisect.bisect_left(t_only, t - window):bisect.bisect_right(t_only, t + window)])
    context_ids -= sampled_set
    packet_ids = sorted(sampled_set | context_ids, key=lambda e: (events[e]["_t"], e))
    in_set = set(packet_ids)

    # ---- finalise packets: neighbours, mechanical pre-labels
    set_times = [events[e]["_t"] for e in packet_ids]
    by_sig: dict[str, list[int]] = defaultdict(list)
    for _, e in times:
        by_sig[meta[e]["sig"]].append(e)
    out_packets = []
    for e in packet_ids:
        p, m, t = packets[e], meta[e], events[e]["_t"]
        near = [x for x in packet_ids[bisect.bisect_left(set_times, t - window):bisect.bisect_right(set_times, t + window)] if x != e]
        p["neighbours"] = near
        p["neighbours_outside_set"] = sum(1 for _, x in times[bisect.bisect_left(t_only, t - window):bisect.bisect_right(t_only, t + window)]
                                          if x != e and x not in in_set)
        group = members[m["root"]]
        pre_group = {"dup_root": m["root"]}
        if e == m["root"] and len(group) > 1:
            pre_group["dup_children"] = [x for x in group if x != e]
        same_sig = [x for x in near if meta[x]["sig"] == m["sig"] and x not in group]
        if same_sig:
            pre_group["same_signature_30m"] = same_sig
        if m["repo"]:
            same_repo = [x for x in near if meta[x]["repo"] == m["repo"] and x not in group]
            if same_repo:
                pre_group["same_repo_30m"] = same_repo
        cl = [x for x in m["cluster"] if x not in excluded_events]
        if cl:
            pre_group["cluster"] = cl
            gone = [{"id": x, "first_seen": ts_short(events[x]["_t"]), "title": clean(events[x]["title"], 60)} for x in cl if x not in in_set]
            if gone:
                pre_group["cluster_outside_set"] = gone
        p["pre_group"] = pre_group

        prior = [x for x in by_sig[m["sig"]] if x != e and x not in group and events[x]["_t"] < t]
        prior_items = [x for x in prior if x in items]
        fixed = []
        for x in prior_items:
            hit = next((f for f in meta[x]["fix_hard"] if f["date"] and parse_ts(f["date"]) < t), None)
            if hit:
                fixed.append((x, hit))
        p["pre_prior_same_signature"] = {
            "stem": clean(m["sig"], 100), "n_prior_events": len(prior), "n_prior_items": len(prior_items),
            "prior_ids": prior[-5:][::-1], "any_prior_fixed_by_change": bool(fixed),
            "fixed_examples": [{"id": x, "repo": f["repo"], "sha": f["sha"], "date": f["date"], "subject": f["subject"]}
                               for x, f in fixed[-2:][::-1]],
        }
        p["context"] = e in context_ids
        p["sample"] = None if p["context"] else {"stratum": stratum_of[m["root"]], "forced": m["root"] in forced_root,
                                                  "weight": weight[m["root"]]}
        out_packets.append(p)

    # ---- outputs
    (HERE / "packets.jsonl").write_text(
        "\n".join(json.dumps(p, ensure_ascii=False, separators=(",", ":")) for p in out_packets) + "\n", encoding="utf-8")

    esc_all = {e for e in events if meta[e]["escalated"]}
    esc_pop = esc_all - excluded_events
    esc_present = {e for e in packet_ids if meta[e]["escalated"]}
    strata_rows = []
    for key in sorted(strata, key=lambda k: (FAMILIES.index(k[0]), OUTCOMES.index(k[1]), PERIODS.index(k[2]))):
        h = strata[key]
        drawn = [r for r in h["pool_order"] if r in chosen]
        taken = [r for r in h["entities"] if r in chosen]
        strata_rows.append({
            "family": key[0], "outcome": key[1], "period": key[2],
            "N_entities": len(h["entities"]), "N_events": h["events"],
            "N_escalated": len(h["forced"]), "N_pool": len(h["pool_order"]),
            "pool_census": len(h["pool_order"]) <= CENSUS_MAX_N, "n_pool_drawn": len(drawn),
            "pool_weight": round(len(h["pool_order"]) / len(drawn), 4) if drawn else None,
            "n_entities": len(taken), "n_events": sum(len(members[r]) for r in taken),
        })
    by_fam = Counter(family_of(events[e]["source"]) for e in packet_ids)
    by_period = Counter(period_of(events[e]["_t"]) for e in packet_ids)
    n_fix_items = sum(1 for e in items if meta[e]["fix_hard"])
    n_pr_unresolved = sum(1 for it in items.values() if (m := PR_URL.search(it["pr_url"] or "")) and m.group(1) not in git.commits)
    n_reused = sum(1 for e, it in items.items() if events[e]["_t"] - parse_ts(it["created_at"]) > dt.timedelta(hours=1))
    lags = sorted((events[e]["_t"] - dt.datetime.fromtimestamp(float(events[e]["payload"]["ts_last"]), dt.timezone.utc)).total_seconds() / 60
                  for e in events if events[e]["source"] in ("slack_alert", "slack_update") and isinstance(events[e]["payload"], dict)
                  and events[e]["payload"].get("ts_last"))
    lag_median = round(lags[len(lags) // 2], 1) if lags else None
    result = {
        "script": "sample.py", "as_of": AS_OF_STR, "seed": SEED,
        "design": {
            "unit": "entity = item + duplicate children (duplicate_of chain to root); an event without a triage item is a singleton",
            "strata_dims": ["family", "outcome", "period"], "target_events": TARGET_EVENTS, "context_window_min": WINDOW_MIN,
            "allocation": f"escalated entities: census; pool per cell: all if <= {CENSUS_MAX_N}, else max({FLOOR}, ceil(lambda*sqrt(N_pool)))",
            "lambda": lam, "draw_order": "sha256(seed|root_event_id) ascending",
            "outcome_rules": "duplicate = entity with >=1 duplicate child; resolved = fixed | closed:resolved | closed:fixed_by; "
                             "unledgered = event without a triage item; open = new/triaged/working/merging/verifying",
            "period_rule": "earliest member first_seen (UTC): Apr-Jul < 2026-08-01 <= Aug-Sep < 2026-10-01 <= Oct",
            "estimation": {
                "element": "a sampled (non-context) event; context events are labelled to recover whole true groups, never an element",
                "weight": "packet sample.weight = 1 / inclusion probability of its entity: 1.0 for escalated entities and census pools, "
                          "N_pool / n_pool_drawn for drawn ones (strata[].pool_weight)",
            },
        },
        "population": {
            "events": len(events), "items": len(items), "unledgered_events": sum(1 for e in events if e not in items),
            "entities_eligible": sum(len(h["entities"]) for h in strata.values()),
            "events_eligible": sum(h["events"] for h in strata.values()),
            "escalated_items_all": len(esc_all), "escalated_items_eligible": len(esc_pop),
            "excluded_private_entities": len(private_roots), "excluded_private_events": len(excluded_events),
            "excluded_private_escalated_items": len(esc_all & excluded_events),
            "excluded_private_root_ids": ",".join(str(r) for r in sorted(private_roots)),
        },
        "totals": {
            "sampled_entities": len(chosen), "sampled_events": len(sampled_set), "context_events": len(context_ids),
            "packets": len(packet_ids), "escalated_items_present": len(esc_present),
            "escalated_target": ESCALATED_TARGET, "escalated_target_met": len(esc_present) >= ESCALATED_TARGET,
            "escalated_entities_present": len({root_for[e] for e in esc_present}),
            "multi_member_entities_sampled": sum(1 for r in chosen if len(members[r]) > 1),
            "unledgered_packets": sum(1 for e in packet_ids if e not in items),
            "packets_by_family": {f: by_fam.get(f, 0) for f in FAMILIES}, "packets_by_period": {p: by_period.get(p, 0) for p in PERIODS},
        },
        "strata": strata_rows,
        "data_notes": [
            f"Only {len(esc_all)} items in the whole snapshot have a transition into needs_decision, {len(esc_pop)} after the private-repo exclusion: "
            f"the {ESCALATED_TARGET}-item target cannot be met, every eligible one is included.",
            f"events.first_seen is the start of the LATEST episode: a recurring fingerprint reuses its row ({n_reused} items were created > 1 h before their event's first_seen). "
            "Item history (transitions) spans the earlier episodes.",
            "No triage item exists before 2026-09-08: every event of Apr-Aug and every slack_update event is unledgered (no outcome, transitions or dispatches).",
            "Occurrences are a counter on the item; repeated fires of one fingerprint are one event row, so the frame measures grouping over post-ingest events.",
            f"Slack rows: first_seen is the poll that ingested the batch, a median {lag_median} min after the latest message (event.msg_last in the packet); "
            "until about the end of August every source carries its 30-minute poll time. uk rows are Kuma DOWN states, resolved_at is the recovery.",
            f"Fix links: {n_fix_items} items carry a resolvable commit (merged_sha, merge receipt, PR subject or a fix-worded note); fixed_by_pr is empty in the snapshot; "
            f"{n_pr_unresolved} items link a PR in a repo without a local clone.",
        ],
    }
    (HERE / "sample.out.json").write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    # ---- self-checks: the redaction gate and the private-term leak check, over what was just written
    bad = 0
    for name in ("packets.jsonl", "sample.out.json"):
        for n, line in enumerate((HERE / name).read_text(encoding="utf-8").splitlines(), 1):
            if _redact(line) != line:
                bad += 1
                print(f"redaction gate: {name}:{n} still matches a pattern", file=sys.stderr)
            if term_re and term_re.search(line):
                bad += 1
                print(f"private-term gate: {name}:{n}", file=sys.stderr)
            if LOCAL_GATE.search(line):
                bad += 1
                print(f"host/path gate: {name}:{n}", file=sys.stderr)
    t = result["totals"]
    print(f"sampled entities {t['sampled_entities']}, sampled events {t['sampled_events']}, context events {t['context_events']}, "
          f"packets {t['packets']}, escalated present {t['escalated_items_present']} (eligible {len(esc_pop)} of {len(esc_all)}), "
          f"lambda {lam}, excluded private entities {len(private_roots)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
