#!/usr/bin/env python3
"""Cost of the warden loop per resolved item, with the attribution coverage stated.

Question
    What does one resolved item cost in agent spend, split by tier (triage, investigate,
    implement, review, check) and by backend (Max vs IU), and how much of the spend could
    be tied to an item at all? Plus the agent spend per day over the last 30 days, by
    source, as context.

Definition keys (evidence/DEFINITIONS.md)
    cost_per_resolved_item = cost of every agent job attributable to an item / resolved
    items, per window. `item` and `resolved` come from ledger.py (the same code as
    baseline.py), windows are cohorts of items by `created_at`.

Attribution path (each job is priced from up to three sources, never double counted)
    item -> job:   warden.db `dispatches.origin_event_id` + `dispatches.job_id`
                   (investigate, implement, review, author; the review rows are the step-7
                   validation jobs); `decision_shadow.event_id` + `llm_job` (triage) and
                   `decision_job` (decide). A job on a duplicate row rolls up to the parent.
    job -> price, exact:
        usage.db `usage_record` rows whose `project` is `.../worktrees/<job id>`
        (claude-code on Max or IU, opencode v1); and agent-gateway's OpenCode v2 store,
        `session_v2.metadata.agw.jobId` with `session_v2.cost` (opencode v2, from
        2026-10-14, NOT in usage.db: the usage-tracker collector reads the v1 store only).
    job -> price, windowed (estimate): usage.db `agent-gateway-iu` rows (review router,
        adversary, OCR; triage; decide) carry no job id; each is matched to the agw jobs
        of the same tool whose run interval contains the call, and its cost is split
        equally among them. Only available inside the job store (job_stats, from 2026-10-09).
    Max rows are priced at list price by usage-tracker ("sunk": the subscription is paid
    anyway), so Max is reported as a list-price equivalent, never added to IU cash.

Inputs
    <snapshots>/<AS_OF date>/{warden.db, agw-jobs.db, usage.db}   frozen, mode=ro
    ~/.local/share/agent-gateway/opencode/opencode.db  LIVE, mode=ro, rows < AS_OF (an
        OpenCode store, so allowed by evidence/README.md; snapshot.sh does not capture it,
        so a re-run after agent-gateway prunes sessions can differ; session counts are
        printed in the output). Override with AGW_OPENCODE_DB.
    ../lib/redact.py

Run
    python3 -I cost.py          (env: AS_OF, FACTORY_SNAPSHOTS, AGW_OPENCODE_DB)
Outputs
    cost.out.json  cost.out.md   (stable key order, no wall-clock values)
Python 3.9+ stdlib only.
"""

from __future__ import annotations

import bisect
import datetime as dt
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True  # the evidence tree stays free of .pyc files
from ledger import (  # noqa: E402
    AS_OF,
    AS_OF_RAW,
    UTC,
    WINDOWS,
    by_id,
    cohort,
    iso,
    md_table,
    open_ro,
    parse_ts,
    pc,
    pctl,
    redact,
    rows,
    snap_dir,
)

AS_OF_S = AS_OF.strftime("%Y-%m-%dT%H:%M:%S")  # usage.db `ts` is ISO-8601 UTC, so a prefix compare is a time compare
AS_OF_MS = int(AS_OF.timestamp() * 1000)
WT_RE = re.compile(r"/worktrees/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")
SLACK_S = 5.0  # tolerance when a usage row's interval is matched to a job's run interval
V2_PATH = Path(os.environ.get("AGW_OPENCODE_DB", "~/.local/share/agent-gateway/opencode/opencode.db")).expanduser()
TIERS = ("triage", "investigate", "implement", "review", "check", "author", "decide")
SUBTOOL_TO_JOBTOOL = {
    "review:router": "review", "review:adversary": "review", "review_ocr": "review",
    "triage": "triage", "decide": "decide",
}


def money(x):
    return round(x, 4)


def usd(x):
    return "n/a" if x is None else (f"${x:,.2f}" if abs(x) >= 0.005 or x == 0 else f"${x:.4f}")


# ----------------------------------------------------------------------------- inputs
wcon = open_ro(snap_dir / "warden.db")
wcon.row_factory = sqlite3.Row
for _name in ("agw-jobs.db", "usage.db"):
    if not (snap_dir / _name).exists():
        sys.exit(f"cost: snapshot missing: {snap_dir / _name} (run evidence/snapshot.sh)")
acon = open_ro(snap_dir / "agw-jobs.db")
ucon = open_ro(snap_dir / "usage.db")

# ----------------------------------------------------------------------------- job universe
jobs = {}


def add_job(jid, tier, event, created, source, status="recorded"):
    if not jid or jid in jobs or created is None or created >= AS_OF:
        return
    jobs[jid] = SimpleNamespace(
        id=jid, tier=tier, origin_event=event, created=created, source=source, status=status, item=None, link="none",
        exact_iu=0.0, exact_max=0.0, v2_cost=0.0, win_iu=0.0, exact_rows=0, unpriced_rows=0, v2_sessions=0, win_rows=0,
        session_rows=0, backends=set(), by_source=defaultdict(float),
    )


for r in wcon.execute("SELECT job_id, tier, origin_event_id, created_at, status FROM dispatches ORDER BY id"):
    add_job(r["job_id"], r["tier"], r["origin_event_id"], parse_ts(r["created_at"]), "dispatches", r["status"])
for r in wcon.execute("SELECT event_id, llm_job, decision_job, created_at FROM decision_shadow ORDER BY id"):
    created = parse_ts(r["created_at"])
    add_job(r["llm_job"], "triage", r["event_id"], created, "decision_shadow")
    add_job(r["decision_job"], "decide", r["event_id"], created, "decision_shadow")


def item_for(event_id):
    """The item a job's cost belongs to: the row itself, or the parent when the row is a duplicate."""
    r, hops, via_dup = by_id.get(event_id), 0, False
    while r is not None and r.is_dup and hops < 5:
        via_dup = True
        r = by_id.get(r.duplicate_of) if r.duplicate_of is not None else None
        hops += 1
    if r is None or r.is_dup:
        return None, ("duplicate_without_parent" if via_dup else "origin_row_missing")
    return r.event_id, ("via_duplicate_parent" if via_dup else "direct")


for j in jobs.values():
    if j.origin_event is None:
        j.link = "no_origin_event"
    else:
        j.item, j.link = item_for(j.origin_event)

# ----------------------------------------------------------------------------- price: exact, usage.db
usage_rows_seen = 0
for src, billing, project, cost, sub in ucon.execute(
    "SELECT source, billing, project, cost_usd, sub_tool FROM usage_record WHERE project LIKE '%/worktrees/%' AND ts < ?",
    (AS_OF_S,),
):
    m = WT_RE.search(project or "")
    j = jobs.get(m.group(1)) if m else None
    if j is None:
        continue
    usage_rows_seen += 1
    if src == "agent-gateway-sessions":  # job-scoped session records: backend and turns, no tokens, no cost
        j.session_rows += 1
        j.backends.add(billing)
        continue
    j.exact_rows += 1
    j.backends.add(billing)
    if cost is None:
        j.unpriced_rows += 1
        continue
    if billing == "max":
        j.exact_max += cost
    else:
        j.exact_iu += cost
    j.by_source[f"{src}/{billing}"] += cost

# ----------------------------------------------------------------------------- price: exact, OpenCode v2 store
v2 = {"available": False, "path": "~/.local/share/agent-gateway/opencode/opencode.db"}
v2_daily = defaultdict(float)
v2_by_tool = defaultdict(lambda: [0, 0.0])
v2_providers = Counter()
if V2_PATH.exists():
    try:
        vcon = sqlite3.connect(f"file:{quote(str(V2_PATH))}?mode=ro", uri=True)
        vcon.execute("PRAGMA query_only=ON")
        n = n_job = n_warden = 0
        first = last = None
        total = warden_total = 0.0
        for sid, meta, cost, tc, model in vcon.execute(
            "SELECT id, metadata, cost, time_created, model FROM session_v2 WHERE time_created < ?", (AS_OF_MS,)
        ):
            n += 1
            first = tc if first is None else min(first, tc)
            last = tc if last is None else max(last, tc)
            c = float(cost or 0.0)
            total += c
            day = dt.datetime.fromtimestamp(tc / 1000, UTC).strftime("%Y-%m-%d")
            v2_daily[day] += c
            try:
                agw = (json.loads(meta) if meta else {}).get("agw") or {}
                prov = (json.loads(model) if model else {}).get("providerID")
            except (ValueError, AttributeError):
                agw, prov = {}, None
            v2_providers[prov] += 1
            jid, tool = agw.get("jobId"), agw.get("tool")
            if tool:
                tool_key = tool.split(":bench")[0] if tool.startswith("bench:") else tool
                v2_by_tool[tool_key][0] += 1
                v2_by_tool[tool_key][1] += c
            if jid:
                n_job += 1
            j = jobs.get(jid) if jid else None
            if j is not None:
                n_warden += 1
                warden_total += c
                j.v2_sessions += 1
                j.v2_cost += c
                j.backends.add("iu")
                j.by_source["opencode-v2/iu"] += c
        v2.update({
            "available": True, "sessions": n, "sessions_with_agw_job_id": n_job, "sessions_of_warden_jobs": n_warden,
            "first_session": iso(dt.datetime.fromtimestamp(first / 1000, UTC)) if first else None,
            "last_session": iso(dt.datetime.fromtimestamp(last / 1000, UTC)) if last else None,
            "total_cost_usd": money(total), "warden_jobs_cost_usd": money(warden_total),
            "providers": dict(sorted((str(k), v) for k, v in v2_providers.items())),
        })
        vcon.close()
    except sqlite3.Error as exc:
        v2["error"] = type(exc).__name__

# ----------------------------------------------------------------------------- price: windowed, usage.db agent-gateway-iu
stats = list(acon.execute("SELECT id, tool, created_at, started_at, finished_at FROM job_stats WHERE created_at < ?", (AS_OF_MS,)))
store_first = min((r[2] for r in stats), default=None)
horizon_s = store_first / 1000 if store_first else None
tool_iv = defaultdict(list)
for jid, tool, created, started, finished in stats:
    if finished is None:
        continue
    tool_iv[tool].append(((started or created) / 1000, finished / 1000, jid))
for t in tool_iv:
    tool_iv[t].sort()
tool_starts = {t: [x[0] for x in v] for t, v in tool_iv.items()}

win = {"rows": 0, "usd": 0.0, "buckets": defaultdict(lambda: [0, 0.0]), "to_warden_usd": 0.0, "to_other_usd": 0.0}
for ts, sub, dur, cost in ucon.execute(
    "SELECT ts, sub_tool, duration_ms, cost_usd FROM usage_record WHERE source='agent-gateway-iu' AND ts < ?", (AS_OF_S,)
):
    c = float(cost or 0.0)
    win["rows"] += 1
    win["usd"] += c
    tool = SUBTOOL_TO_JOBTOOL.get(sub)
    end = parse_ts(ts).timestamp()
    start = end - (dur or 0) / 1000.0
    if tool is None:
        bucket = "unmapped_sub_tool"
    elif horizon_s is None or end < horizon_s:
        bucket = "before_job_store"
    else:
        ivs, starts = tool_iv.get(tool, []), tool_starts.get(tool, [])
        hi = bisect.bisect_right(starts, start + SLACK_S)
        cands = [x[2] for x in ivs[:hi] if x[1] + SLACK_S >= end]
        bucket = "no_candidate_job" if not cands else ("unique_job" if len(cands) == 1 else "shared_between_jobs")
        for jid in cands:
            j = jobs.get(jid)
            if j is not None:
                j.win_iu += c / len(cands)
                j.win_rows += 1
                j.backends.add("iu")
                j.by_source["agent-gateway-iu(windowed)/iu"] += c / len(cands)
                win["to_warden_usd"] += c / len(cands)
            else:
                win["to_other_usd"] += c / len(cands)
    win["buckets"][bucket][0] += 1
    win["buckets"][bucket][1] += c

# ----------------------------------------------------------------------------- per-job totals
for j in jobs.values():
    j.priced_exact = (j.exact_rows - j.unpriced_rows) > 0 or j.v2_sessions > 0
    j.priced = j.priced_exact or j.win_rows > 0
    j.iu = j.exact_iu + j.v2_cost + j.win_iu
    j.max_list = j.exact_max
    j.exact_total = j.exact_iu + j.exact_max + j.v2_cost
    j.backend = ("both" if {"iu", "max"} <= j.backends else "iu" if "iu" in j.backends else "max" if "max" in j.backends else "unknown")


def agg(js):
    """Sums over a set of jobs, with coverage."""
    js = list(js)
    priced = [j for j in js if j.priced]
    return {
        "jobs": len(js), "priced": len(priced), "priced_exact": sum(1 for j in js if j.priced_exact),
        "priced_windowed_only": sum(1 for j in js if j.priced and not j.priced_exact),
        "priced_share": None if not js else round(len(priced) / len(js), 4),
        "iu_cash_usd": money(sum(j.iu for j in js)), "max_list_usd": money(sum(j.max_list for j in js)),
        "exact_usd": money(sum(j.exact_total for j in js)), "windowed_usd": money(sum(j.win_iu for j in js)),
    }


# ----------------------------------------------------------------------------- windows
items_by_job = defaultdict(list)
for j in jobs.values():
    if j.item is not None:
        items_by_job[j.item].append(j)


def window_block(items_c):
    ids = {r.event_id for r in items_c}
    js = [j for i in ids for j in items_by_job.get(i, [])]
    resolved = sum(1 for r in items_c if r.resolved_ever)
    a = agg(js)
    total = a["iu_cash_usd"] + a["max_list_usd"]
    by_tier = {}
    for t in TIERS:
        tj = [j for j in js if j.tier == t]
        b = agg(tj)
        b["per_resolved_item_usd"] = {
            "iu_cash": None if not resolved else money(b["iu_cash_usd"] / resolved),
            "max_list": None if not resolved else money(b["max_list_usd"] / resolved),
        }
        by_tier[t] = b
    by_backend = {}
    for name in ("iu", "max", "both", "unknown"):
        bj = [j for j in js if j.backend == name]
        by_backend[name] = {"jobs": len(bj), "priced": sum(1 for j in bj if j.priced), "iu_cash_usd": money(sum(j.iu for j in bj)),
                            "max_list_usd": money(sum(j.max_list for j in bj))}
    by_source = defaultdict(float)
    for j in js:
        for k, v in j.by_source.items():
            by_source[k] += v
    return {
        "key": "cost_per_resolved_item",
        "items": len(items_c), "resolved_items": resolved,
        "jobs_attributable_to_items": a["jobs"], "jobs_priced": a["priced"], "jobs_priced_share": a["priced_share"],
        "jobs_priced_exact": a["priced_exact"], "jobs_priced_windowed_only": a["priced_windowed_only"],
        "cost_usd": {"iu_cash": a["iu_cash_usd"], "max_list_equivalent": a["max_list_usd"], "total_list_equivalent": money(total),
                     "exact": a["exact_usd"], "windowed_estimate": a["windowed_usd"]},
        "per_resolved_item_usd": {
            "iu_cash": None if not resolved else money(a["iu_cash_usd"] / resolved),
            "max_list_equivalent": None if not resolved else money(a["max_list_usd"] / resolved),
            "total_list_equivalent": None if not resolved else money(total / resolved),
            "iu_cash_exact_only": None if not resolved else money((a["exact_usd"] - a["max_list_usd"]) / resolved),
        },
        "per_item_usd": {"iu_cash": None if not items_c else money(a["iu_cash_usd"] / len(items_c)),
                         "max_list_equivalent": None if not items_c else money(a["max_list_usd"] / len(items_c))},
        "by_tier": by_tier, "by_backend": by_backend,
        "by_source": {k: money(v) for k, v in sorted(by_source.items())},
    }


windows = {}
for name, days in WINDOWS:
    windows[name] = {"from": iso(cohort(days)[0]) if days else None, "to": iso(AS_OF), **window_block(cohort(days)[2])}

# creation-week view: where the coverage breaks
def week_start(d):
    return (d - dt.timedelta(days=d.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)


items_all = cohort(None)[2]
wk_items = defaultdict(list)
for r in items_all:
    wk_items[week_start(r.created)].append(r)
by_creation_week = []
for w0 in sorted(wk_items):
    blk = window_block(wk_items[w0])
    iy, iw, _ = w0.isocalendar()
    by_creation_week.append({
        "week": f"{iy}-W{iw:02d}", "start": iso(w0)[:10], "items": blk["items"], "resolved_items": blk["resolved_items"],
        "jobs": blk["jobs_attributable_to_items"], "jobs_priced_share": blk["jobs_priced_share"],
        "iu_cash_usd": blk["cost_usd"]["iu_cash"], "max_list_usd": blk["cost_usd"]["max_list_equivalent"],
        "per_resolved_iu_cash": blk["per_resolved_item_usd"]["iu_cash"],
        "per_resolved_max_list": blk["per_resolved_item_usd"]["max_list_equivalent"],
    })

# ----------------------------------------------------------------------------- coverage of the whole job universe
all_jobs = list(jobs.values())
cov_tier = {}
for t in TIERS:
    tj = [j for j in all_jobs if j.tier == t]
    a = agg(tj)
    cov_tier[t] = {"jobs": a["jobs"], "priced_exact": a["priced_exact"], "priced_windowed_only": a["priced_windowed_only"],
                   "unpriced": a["jobs"] - a["priced"], "priced_share": a["priced_share"],
                   "linked_to_item": sum(1 for j in tj if j.item is not None)}
cov_link = Counter(j.link for j in all_jobs)
cov_backend = {}
for name in ("iu", "max", "both", "unknown"):
    bj = [j for j in all_jobs if j.backend == name]
    cov_backend[name] = {"jobs": len(bj), "priced": sum(1 for j in bj if j.priced),
                         "priced_share": None if not bj else round(sum(1 for j in bj if j.priced) / len(bj), 4)}
wk_jobs = defaultdict(list)
for j in all_jobs:
    wk_jobs[week_start(j.created)].append(j)
cov_week = []
for w0 in sorted(wk_jobs):
    a = agg(wk_jobs[w0])
    iy, iw, _ = w0.isocalendar()
    cov_week.append({"week": f"{iy}-W{iw:02d}", "start": iso(w0)[:10], "jobs": a["jobs"], "priced_exact": a["priced_exact"],
                     "priced_windowed_only": a["priced_windowed_only"], "priced_share": a["priced_share"],
                     "iu_cash_usd": a["iu_cash_usd"], "max_list_usd": a["max_list_usd"]})
cov_day = defaultdict(lambda: [0, 0])
for j in all_jobs:
    d = iso(j.created)[:10]
    cov_day[d][0] += 1
    cov_day[d][1] += j.priced_exact
last_exact_day = max((d for d, (n, p) in cov_day.items() if p > 0), default=None)
last_max_day = max((iso(j.created)[:10] for j in all_jobs if j.exact_max > 0), default=None)
first_priced = min((j.created for j in all_jobs if j.priced_exact), default=None)
_opc_last = ucon.execute("SELECT MAX(ts) FROM usage_record WHERE source='opencode' AND ts < ?", (AS_OF_S,)).fetchone()[0]
gap_start = parse_ts(_opc_last) if _opc_last else None
gap_end = parse_ts(v2.get("first_session")) if v2.get("first_session") else None


def unpriced_reason(j):
    if j.status in ("failed", "cancelled") and not j.session_rows and j.exact_rows == 0:
        return "failed_or_cancelled_without_any_usage_row"  # never ran (bad cwd, aborted): no spend expected
    if first_priced is not None and j.created < first_priced:
        return "created_before_the_first_priced_job"
    if gap_start and gap_end and gap_start <= j.created < gap_end:
        return "created_in_the_opencode_collector_gap"
    return "sessions_row_only" if j.session_rows else "no_usage_row_at_all"


unpriced_reasons = defaultdict(Counter)
for j in all_jobs:
    if not j.priced:
        unpriced_reasons[unpriced_reason(j)][j.tier] += 1
val_tiers = Counter()
for r in wcon.execute("SELECT v.tier FROM dispatches d JOIN dispatches v ON v.job_id = d.validation_job_id"):
    val_tiers[r[0]] += 1
coverage = {
    "universe": "warden-owned agw jobs created before AS_OF: every dispatches.job_id plus decision_shadow llm_job and decision_job",
    "jobs_total": len(all_jobs),
    "jobs_priced_exact": sum(1 for j in all_jobs if j.priced_exact),
    "jobs_priced_exact_share": round(sum(1 for j in all_jobs if j.priced_exact) / len(all_jobs), 4),
    "jobs_priced_incl_windowed": sum(1 for j in all_jobs if j.priced),
    "jobs_priced_incl_windowed_share": round(sum(1 for j in all_jobs if j.priced) / len(all_jobs), 4),
    "jobs_no_spend_expected": sum(1 for j in all_jobs if not j.priced and unpriced_reason(j) == "failed_or_cancelled_without_any_usage_row"),
    "jobs_priced_share_excluding_no_spend_expected": round(
        sum(1 for j in all_jobs if j.priced) / (len(all_jobs) - sum(1 for j in all_jobs if not j.priced and unpriced_reason(j) == "failed_or_cancelled_without_any_usage_row")), 4),
    "link_to_item": dict(sorted(cov_link.items())),
    "cost_of_jobs_without_an_item": {
        "jobs": sum(1 for j in all_jobs if j.item is None),
        **{k: v for k, v in zip(("iu_cash_usd", "max_list_usd"), (money(sum(j.iu for j in all_jobs if j.item is None)),
                                                                  money(sum(j.max_list for j in all_jobs if j.item is None))))},
        "note": "not in any window: dispatches without an origin event, or whose duplicate row has no parent",
    },
    "by_tier": cov_tier, "by_backend": cov_backend, "by_week": cov_week,
    "last_day_with_an_exactly_priced_job": last_exact_day,
    "last_day_with_a_max_priced_job": last_max_day,
    "unpriced_jobs_by_reason": {k: {"total": sum(v.values()), "by_tier": dict(sorted(v.items()))} for k, v in sorted(unpriced_reasons.items())},
    "opencode_collector_gap": {"from": iso(gap_start) if gap_start else None, "to": iso(gap_end) if gap_end else None},
    "validation_job_tiers": dict(sorted(val_tiers.items())),
    "first_day_of_job_store": iso(dt.datetime.fromtimestamp(horizon_s, UTC))[:10] if horizon_s else None,
    "usage_rows_matched_to_warden_jobs": usage_rows_seen,
    "exact_rows_without_cost": sum(j.unpriced_rows for j in all_jobs),
    "windowed_attribution_agent_gateway_iu_rows": {
        "rows": win["rows"], "usd": money(win["usd"]), "to_warden_jobs_usd": money(win["to_warden_usd"]),
        "to_other_agw_jobs_usd": money(win["to_other_usd"]),
        "buckets": {k: {"rows": v[0], "usd": money(v[1])} for k, v in sorted(win["buckets"].items())},
        "slack_seconds": SLACK_S,
        "warden_share_of_matched_usd": None if not (win["to_warden_usd"] + win["to_other_usd"]) else round(
            win["to_warden_usd"] / (win["to_warden_usd"] + win["to_other_usd"]), 4),
        "before_job_store_usd_if_warden_share_applied": None if not (win["to_warden_usd"] + win["to_other_usd"]) else money(
            win["buckets"]["before_job_store"][1] * win["to_warden_usd"] / (win["to_warden_usd"] + win["to_other_usd"])),
    },
    "opencode_v2_store": v2,
}

# job store by tool, linked and priced (what the store holds vs what the ledger can see)
store_by_tool = defaultdict(lambda: {"jobs": 0, "warden_owned": 0, "warden_owned_priced": 0})
for jid, tool, created, started, finished in stats:
    s = store_by_tool[tool]
    s["jobs"] += 1
    j = jobs.get(jid)
    if j is not None:
        s["warden_owned"] += 1
        s["warden_owned_priced"] += j.priced
store_by_tool = dict(sorted(store_by_tool.items(), key=lambda kv: -kv[1]["jobs"]))

# ----------------------------------------------------------------------------- context: agent spend per day, last 30 days, by source
lo30 = AS_OF - dt.timedelta(days=30)
lo30_s = lo30.strftime("%Y-%m-%dT%H:%M:%S")
daily = defaultdict(lambda: defaultdict(float))
daily_n = defaultdict(lambda: defaultdict(int))
for d, src, billing, n, c in ucon.execute(
    "SELECT substr(ts,1,10), source, billing, COUNT(*), COALESCE(SUM(cost_usd),0) FROM usage_record WHERE ts >= ? AND ts < ? GROUP BY 1,2,3",
    (lo30_s, AS_OF_S),
):
    daily[d][f"{src}/{billing}"] += c
    daily_n[d][f"{src}/{billing}"] += n
for d, c in v2_daily.items():
    if lo30.strftime("%Y-%m-%d") <= d <= AS_OF.strftime("%Y-%m-%d"):
        daily[d]["opencode-v2/iu (not in usage.db)"] += c
src_keys = sorted({k for d in daily.values() for k in d})
day_list = sorted(daily)
daily_rows = []
for d in day_list:
    iu = sum(v for k, v in daily[d].items() if k.endswith("/iu") or k.endswith("/iu (not in usage.db)"))
    mx = sum(v for k, v in daily[d].items() if k.endswith("/max"))
    daily_rows.append({"day": d, "partial": d in (lo30.strftime("%Y-%m-%d"), AS_OF.strftime("%Y-%m-%d")),
                       "iu_cash_usd": money(iu), "max_list_usd": money(mx),
                       "by_source": {k: money(v) for k, v in sorted(daily[d].items())}})
tot_by_source = defaultdict(float)
for d in daily.values():
    for k, v in d.items():
        tot_by_source[k] += v
cc_rows = []
for sub, billing, n, c in ucon.execute(
    "SELECT COALESCE(sub_tool,''), billing, COUNT(*), COALESCE(SUM(cost_usd),0) FROM usage_record "
    "WHERE source='claude-code' AND ts >= ? AND ts < ? GROUP BY 1,2 ORDER BY 4 DESC", (lo30_s, AS_OF_S)):
    cc_rows.append({"sub_tool": redact(sub) or "(none)", "billing": billing, "rows": n, "usd": money(c)})
context = {
    "window": f"[{iso(lo30)}, {iso(AS_OF)})",
    "note": "usd = usage-tracker cost_usd: IU rows are cash per token, Max rows are list-price equivalents of a flat subscription",
    "total_by_source_usd": {k: money(v) for k, v in sorted(tot_by_source.items(), key=lambda kv: -kv[1])},
    "total_iu_cash_usd": money(sum(r["iu_cash_usd"] for r in daily_rows)),
    "total_max_list_usd": money(sum(r["max_list_usd"] for r in daily_rows)),
    "daily": daily_rows,
    "claude_code_by_sub_tool": cc_rows[:12],
    "agent_gateway_job_store_by_tool": store_by_tool,
    "opencode_v2_sessions_by_tool": {k: {"sessions": v[0], "usd": money(v[1])} for k, v in sorted(v2_by_tool.items(), key=lambda kv: -kv[1][1])},
}

# ----------------------------------------------------------------------------- data quality
priced_costs = {t: sorted(j.iu + j.max_list for j in all_jobs if j.tier == t and j.priced) for t in TIERS}
quality = {
    "snapshot_dir": "~/.local/share/factory/snapshots/" + AS_OF_RAW[:10],
    "usage_tracker_opencode_collector_last_row": ucon.execute(
        "SELECT MAX(ts) FROM usage_record WHERE source='opencode' AND ts < ?", (AS_OF_S,)).fetchone()[0],
    "usage_rows_with_job_worktree_last_day": ucon.execute(
        "SELECT substr(MAX(ts),1,10) FROM usage_record WHERE source IN ('claude-code','opencode') AND project LIKE '%/worktrees/%' AND ts < ?",
        (AS_OF_S,)).fetchone()[0],
    "agent_gateway_sessions_rows_carry_tokens": ucon.execute(
        "SELECT COUNT(*) FROM usage_record WHERE source='agent-gateway-sessions' AND (input_tokens>0 OR output_tokens>0 OR cost_usd>0) AND ts < ?",
        (AS_OF_S,)).fetchone()[0],
    "median_cost_per_priced_job_usd": {t: (money(pctl(v, 0.5)) if v else None) for t, v in priced_costs.items()},
    "p90_cost_per_priced_job_usd": {t: (money(pctl(v, 0.9)) if v else None) for t, v in priced_costs.items()},
    "check_tier_jobs_owned_by_warden": sum(1 for j in all_jobs if j.tier == "check"),
    "usage_db_cost_semantics": "Max rows are list-price equivalents (sunk); IU rows are per-token cash",
}

result = {
    "meta": {"script": "evidence/kpi/cost.py", "as_of": iso(AS_OF), "definitions": "evidence/DEFINITIONS.md",
             "cohort": "items by created_at in window; cost of every job attributable to those items up to AS_OF; denominator = resolved items"},
    "attribution_coverage": coverage,
    "windows": windows,
    "by_creation_week": by_creation_week,
    "context_agent_cost_last_30d": context,
    "data_quality": quality,
}
json_text = json.dumps(result, indent=2, ensure_ascii=False) + "\n"

# ----------------------------------------------------------------------------- markdown
md = []
w = md.append
w(f"# Cost per resolved item, AS_OF {iso(AS_OF)}")
w("")
w("Generated by `evidence/kpi/cost.py` (definition `cost_per_resolved_item`). Cost = every agent job attributable to an item, "
  "divided by the items that reached a resolved state (same `item` and `resolved` code as `baseline.py`). "
  "**IU** is cash per token; **Max** is a list-price equivalent of a flat subscription (sunk), shown beside IU, never added into cash. "
  "Numbers are in `cost.out.json`.")
w("")
w("## Headline")
w("")
hr = []
for n in ("14d", "30d", "all"):
    b = windows[n]
    p = b["per_resolved_item_usd"]
    hr.append([n, b["items"], b["resolved_items"], f"{b['jobs_priced']}/{b['jobs_attributable_to_items']} ({pc(b['jobs_priced'], b['jobs_attributable_to_items'])})",
               usd(b["cost_usd"]["iu_cash"]), usd(b["cost_usd"]["max_list_equivalent"]), usd(p["iu_cash"]), usd(p["max_list_equivalent"]), usd(p["total_list_equivalent"])])
w(md_table(["window", "items", "resolved", "jobs priced", "IU cash", "Max list-eq", "IU cash per resolved", "Max list-eq per resolved", "total list-eq per resolved"], hr))
w("")
w(f"Of {coverage['jobs_total']} warden-owned jobs, {coverage['jobs_priced_exact']} ({pc(coverage['jobs_priced_exact'], coverage['jobs_total'])}) are priced from exact rows "
  f"and {coverage['jobs_priced_incl_windowed']} ({pc(coverage['jobs_priced_incl_windowed'], coverage['jobs_total'])}) when the windowed estimate counts "
  f"(another {coverage['jobs_no_spend_expected']} failed or were cancelled before any usage and should cost nothing; leaving those out, {100 * coverage['jobs_priced_share_excluding_no_spend_expected']:.1f} % are priced). "
  f"{coverage['link_to_item'].get('no_origin_event', 0)} jobs carry no origin event and {coverage['link_to_item'].get('via_duplicate_parent', 0)} were rolled up from a duplicate row to its parent. "
  f"The windowed part is {usd(windows['all']['cost_usd']['windowed_estimate'])} of {usd(windows['all']['cost_usd']['iu_cash'])} IU cash (window all).")
w("")
w("## Cost by tier")
w("")
for n in ("30d", "all"):
    b = windows[n]
    w(f"**{n}** ({b['resolved_items']} resolved items)")
    w("")
    w(md_table(["tier", "jobs", "priced", "IU cash", "Max list-eq", "windowed part of IU", "IU cash per resolved", "Max list-eq per resolved"],
               [[t, v["jobs"], f"{v['priced']} ({pc(v['priced'], v['jobs'])})", usd(v["iu_cash_usd"]), usd(v["max_list_usd"]), usd(v["windowed_usd"]),
                 usd(v["per_resolved_item_usd"]["iu_cash"]), usd(v["per_resolved_item_usd"]["max_list"])] for t, v in b["by_tier"].items()]))
    w("")
w("`check`: warden owns no `check` jobs. Its step-7 validation is a `review` job (" + ", ".join(f"{n} validation links point at {t} dispatches" for t, n in coverage["validation_job_tiers"].items())
  + f"), so the `check` tier is zero by construction; agent-gateway's {store_by_tool.get('check', {}).get('jobs', 0)} `check` jobs come from Claude Code sessions. "
  "`triage` and `decide` exist only from 2026-10-15 (the first `decision_shadow` row): earlier triage jobs have no ledger link. `author` is two jobs.")
w("")
w("## Cost by backend")
w("")
w(md_table(["window", "IU cash", "share of priced cost", "IU cash per resolved", "Max list-eq", "Max list-eq per resolved"],
           [[n, usd(windows[n]["cost_usd"]["iu_cash"]), pc(windows[n]["cost_usd"]["iu_cash"], windows[n]["cost_usd"]["total_list_equivalent"]),
             usd(windows[n]["per_resolved_item_usd"]["iu_cash"]), usd(windows[n]["cost_usd"]["max_list_equivalent"]),
             usd(windows[n]["per_resolved_item_usd"]["max_list_equivalent"])] for n in ("14d", "30d", "all")]))
w("")
w("By the backend each job ran on:")
w("")
w(md_table(["window", "backend", "jobs", "priced", "IU cash", "Max list-eq"],
           [[n, k, v["jobs"], v["priced"], usd(v["iu_cash_usd"]), usd(v["max_list_usd"])] for n in ("30d", "all") for k, v in windows[n]["by_backend"].items()]))
w("")
w("Backend is read from the usage rows that priced the job (billing), else from its `agent-gateway-sessions` rows; `both` = the job ran sessions on both (review angles on one, synthesis on the other); `unknown` = no row names a backend. "
  "No warden job created after " + str(coverage["last_day_with_a_max_priced_job"]) + " has a Max row; every later job ran on IU through OpenCode.")
w("")
src_rows = sorted(windows["all"]["by_source"].items(), key=lambda kv: -kv[1])
w("Where the priced cost comes from (window all):")
w("")
w(md_table(["source / billing", "usd"], [[k, usd(v)] for k, v in src_rows]))
w("")
w("## Attribution coverage")
w("")
w(md_table(["tier", "jobs", "linked to item", "priced exact", "priced windowed only", "unpriced", "priced share"],
           [[t, v["jobs"], v["linked_to_item"], v["priced_exact"], v["priced_windowed_only"], v["unpriced"], pc(v["jobs"] - v["unpriced"], v["jobs"])] for t, v in cov_tier.items()]))
w("")
w("By creation week of the job (where the gaps are):")
w("")
w(md_table(["week", "jobs", "priced exact", "windowed only", "priced share", "IU cash", "Max list-eq"],
           [[x["week"], x["jobs"], x["priced_exact"], x["priced_windowed_only"], pc(x["priced_exact"] + x["priced_windowed_only"], x["jobs"]), usd(x["iu_cash_usd"]), usd(x["max_list_usd"])] for x in cov_week]))
w("")
w("By item creation week (cost per resolved item, with the share of jobs priced):")
w("")
w(md_table(["week", "items", "resolved", "jobs", "priced", "IU cash", "Max list-eq", "IU cash per resolved", "Max list-eq per resolved"],
           [[x["week"], x["items"], x["resolved_items"], x["jobs"], "n/a" if x["jobs_priced_share"] is None else f"{100 * x['jobs_priced_share']:.0f} %", usd(x["iu_cash_usd"]), usd(x["max_list_usd"]),
             usd(x["per_resolved_iu_cash"]), usd(x["per_resolved_max_list"])] for x in by_creation_week]))
w("")
wa = coverage["windowed_attribution_agent_gateway_iu_rows"]
w(f"Windowed attribution (agent-gateway's direct IU calls, {wa['rows']} rows, {usd(wa['usd'])}): "
  + ", ".join(f"{k} {v['rows']} rows / {usd(v['usd'])}" for k, v in wa["buckets"].items())
  + f". {usd(wa['to_warden_jobs_usd'])} landed on warden-owned jobs and {usd(wa['to_other_agw_jobs_usd'])} on other callers' jobs (waves and sessions run reviews too). "
  "A call overlapping several jobs of the same tool is split equally, so this part is an estimate. Before the job store starts (" + str(coverage["first_day_of_job_store"]) + ") there are no intervals and nothing is matched: "
  f"those {usd(wa['buckets'].get('before_job_store', {}).get('usd', 0))} of direct calls are in no item's cost. At the post-store warden share ({100 * wa['warden_share_of_matched_usd']:.1f} % of matched calls) about "
  f"{usd(wa['before_job_store_usd_if_warden_share_applied'])} of it would be warden's, so the IU cash above is low by roughly that much (not added).")
w("")
v = v2
if v.get("available"):
    w(f"OpenCode v2 store: {v['sessions']} sessions ({v['first_session']} to {v['last_session']}), {v['sessions_with_agw_job_id']} carry an agent-gateway job id, "
      f"{v['sessions_of_warden_jobs']} belong to warden jobs ({usd(v['warden_jobs_cost_usd'])} of {usd(v['total_cost_usd'])}). This store is not in usage.db (see caveats).")
else:
    w("OpenCode v2 store: not readable at this path; jobs from 2026-10-14 are unpriced except by the windowed estimate.")
w("")
w("What the agent-gateway job store holds (from 2026-10-09) and how much of it the ledger can see:")
w("")
w(md_table(["tool", "jobs in the store", "owned by a warden item or shadow row", "of those priced"],
           [[t, v["jobs"], v["warden_owned"], v["warden_owned_priced"]] for t, v in store_by_tool.items()]))
w("")
w("`review` jobs outside warden come from Claude Code sessions and waves; `update_pr`, `check`, `prose`, `narrative`, `overview` and the rest carry no item link in the ledger, so their cost (if any) is in no item.")
w("")
w("## Context: agent spend per day, last 30 days, by source")
w("")
w(f"Window {context['window']}; IU cash {usd(context['total_iu_cash_usd'])}, Max list-equivalent {usd(context['total_max_list_usd'])}. "
  "Everything agents spent, not only the warden loop: most Max spend is interactive and wave sessions.")
w("")
top_src = [k for k, _ in sorted(tot_by_source.items(), key=lambda kv: -kv[1])][:7]
w(md_table(["day"] + top_src + ["other", "IU cash", "Max list-eq"],
           [[x["day"] + ("*" if x["partial"] else "")] + [usd(x["by_source"].get(k, 0.0)) for k in top_src]
            + [usd(sum(vv for kk, vv in x["by_source"].items() if kk not in top_src)), usd(x["iu_cash_usd"]), usd(x["max_list_usd"])] for x in daily_rows]))
w("")
w("`*` = partial day (window edges). `opencode-v2/iu (not in usage.db)` is read from agent-gateway's OpenCode store, by the day a session started.")
w("")
w("Claude Code by sub_tool in the window (shows how little of Max spend is agent-gateway work):")
w("")
w(md_table(["sub_tool", "billing", "rows", "usd"], [[r["sub_tool"], r["billing"], r["rows"], usd(r["usd"])] for r in cc_rows[:10]]))
w("")
w("## Data quality and caveats")
w("")
w(f"- usage-tracker's `opencode` collector last stored a row at {quality['usage_tracker_opencode_collector_last_row']} while reporting `ok`. It reads `~/.local/share/opencode/opencode.db` (`usage-tracker/src/collectors/opencode.ts:31`, tables `session` and `message`); "
  f"agent-gateway's OpenCode v2 server writes `~/.local/share/agent-gateway/opencode/opencode.db` (table `session_v2`, first session {v2.get('first_session')}). "
  "So usage.db, and anything built on it (Argo's `usage_record`), has no IU OpenCode session since 2026-10-13. This script reads the v2 store directly, which `snapshot.sh` does not freeze.")
ur = coverage["unpriced_jobs_by_reason"]
w(f"- {coverage['jobs_total'] - coverage['jobs_priced_incl_windowed']} of {coverage['jobs_total']} jobs are unpriced: "
  + ", ".join(f"{v['total']} {k.replace('_', ' ')}" for k, v in ur.items())
  + f". The `agent-gateway-sessions` rows name the backend and the turns but {quality['agent_gateway_sessions_rows_carry_tokens']} of them carry tokens or cost, so a job with only those rows is unpriced.")
w("- Jobs run in place (no worktree) cannot be matched by path and stay unpriced unless a windowed row falls on them; the same holds for any episode whose usage rows lack the worktree project.")
w("- Pricing: usage-tracker `pricing.ts` and OpenCode v2's own `session_v2.cost` agree on Haiku 5.5 ($0.10 in, $0.50 out, $0.01 cache read, $0.125 cache write per million tokens); Max rows are list prices, so a Max figure is what the usage would cost on the API, not what was paid.")
w("- Items that were never given a dispatch (quiet, ignored, duplicates) cost nothing here by construction; the numerator includes the cost of items that did not resolve (failed, ignored, still open), as the definition says.")
md_text = "\n".join(md) + "\n"

for label, text in (("json", json_text), ("md", md_text)):
    if redact(text) != text:
        print(f"cost: redactor changed the {label} output (kept the redacted form)", file=sys.stderr)
(HERE / "cost.out.json").write_text(redact(json_text), encoding="utf-8")
(HERE / "cost.out.md").write_text(redact(md_text), encoding="utf-8")
print(f"cost: {len(all_jobs)} warden jobs, {coverage['jobs_priced_incl_windowed']} priced; wrote cost.out.json and cost.out.md")
