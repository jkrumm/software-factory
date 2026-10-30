#!/usr/bin/env python3
"""Weekly cost of the factory in Max % of the weekly window and IU dollars: today vs ADR-007/008.

Question (panel objection cos-1, with the inputs cos-2 and cos-7 need)
    What does the factory cost per week in Max % of the weekly window and in IU dollars,
    today and fully running under ADR-008 (engine by class) and ADR-007 (mothers, leads)?
    Also: the owner-interactive share of the window per weekly cycle (p50, p90: the owner
    reserve, cos-2) and the Max % that lapses unused per cycle (cos-7).

Definition keys
    This script defines its own (stated in the output `definitions`): weekly class cost,
    window % = list USD / (list USD per 1 % of the weekly window), cycle share, lapsed %.
    The $/1 % calibration is kpi/engine_policy.out.json `max_list_usd_per_1pct_week`
    (one value per complete weekly cycle); cycles come from kpi/quota.out.json.

Inputs (all read-only)
    <snapshots>/<AS_OF date>/usage.db       frozen; every source except agent-gateway-opencode
    ~/.local/share/usage-tracker/usage.db   LIVE, rows < AS_OF, ONLY source
                                            'agent-gateway-opencode' (collected since the
                                            Phase 0 fix; the snapshot has none)
    kpi/engine_policy.out.json, kpi/quota.out.json, ../lib/redact.py
    ADR-007 / ADR-008 are the policy; their encoding is the constants below.

Method
    1. Classify every usage row by (source, billing, sub_tool, project) into CLASSES.
    2. Weekly tokens and cost = window total x 7 / covered days. Rows the usage-tracker
       OpenCode collectors cover are scaled by the days they were actually collected
       (the v1 -> v2 store gap is excluded, not counted as zero).
    3. Convert Max list USD to window % with the per-cycle $/1 % values; report the
       median and the min..max over cycles.
    4. Projection = today, minus work ADR-008 moves between engines, plus the ADR-007
       mother and lead wakes (assumption constants below), priced from the measured wave
       session size.
    5. Per complete weekly cycle: class Max USD in the cycle / that cycle's $/1 % = the
       cycle's share of the window; today's cycle % is the measured one, the projection
       adds the weekly delta scaled to the cycle's length.

Run
    python3 -I forecast.py          (env: AS_OF, FACTORY_SNAPSHOTS, USAGE_LIVE_DB)
Outputs
    forecast.out.json  forecast.out.md   (stable key order, no wall-clock values)
Python 3.9+ stdlib only.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
sys.dont_write_bytecode = True
from redact import redact  # noqa: E402

# --------------------------------------------------------------------------- constants
AS_OF_RAW = os.environ.get("AS_OF", "2026-10-22T08:00:00Z")
AS_OF = dt.datetime.strptime(AS_OF_RAW, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
WINDOWS = (30, 7)                       # days before AS_OF; 30 d is the headline, 7 d the recent rate
HEADLINE_DAYS = 30

# ADR-007: fleet <=> >= 10 planned units closed in 90 d and >= 25 commits/week.
FLEET_PROJECTS = ("basalt-ui", "argo", "weatherorb", "shutterflow", "dotfiles", "warden")

# ADR-007 mothers and leads: assumptions, not measurements (no mother runs yet).
MOTHERS = 6                             # one per fleet project; counted fully incremental
                                        # (an upper bound: 3 exist ad hoc and sit in 'fleet_waves')
MOTHER_WAKES_PER_DAY = 4                # on-demand wakes per project per day (new conditions/requests)
MOTHER_ROTATIONS_PER_DAY = 1            # daily rotation = one handover wake
LEADS = 3                               # concurrently active plans/epics, fleet-wide
LEAD_WAKES_PER_DAY = 6                  # sequencing/rebase/review turns per lead per day
WAKE_SIZE_FRACTION = 0.25               # a wake is this fraction of the MEDIAN wave session's tokens
                                        # (a wake reads state and files tasks; it never edits code)

# ADR-008 reassignments: share of a class's weekly cost that moves between engines.
WAVE_ROUTINE_TO_IU_SHARE = 0.0          # routine fixes inside rd waves -> IU. 0 = nothing moves (no
                                        # measurement of the routine share in Max waves); sensitivity below
SENSITIVITY_WAVE_ROUTINE_SHARES = (0.1, 0.25)
AGW_TOOLS_MAX_TO_IU_SHARE = 0.0         # ADR-008 does not classify agw review/check/narrative (cos-3):
                                        # they stay where they are; sensitivity moves all of it
# IU price of work moved off Max: IU $ per Max list $ for the same work, measured by
# engine_policy.py (IU OpenCode spend / the same tokens at Sonnet list). Upper bound: Max rows
# are priced at their own, mostly dearer, models.
IU_USD_PER_MAX_LIST_USD = None          # filled from engine_policy.out.json

OWNER_RESERVE_ADR008_PCT = 15           # ADR-008's reserve, compared with the measured owner share
TOP_PROJECTS = 12

CLASSES = (
    "owner_interactive",   # Claude Code / OpenCode driven by the owner
    "fleet_waves",         # rd wave / fan / fleet sessions: mothers, leads, workers
    "agw_tools",           # agent-gateway review / check / prose / narrative / triage / decide / …
    "agw_opencode_impl",   # agent-gateway implement / investigate (dispatch)
    "research",
    "hermes",
    "other",
)
MAX_CLASS_ENGINE_ADR008 = {            # where each class runs once ADR-008 is in force
    "owner_interactive": "max (owner's choice)",
    "fleet_waves": "max (features, waves, mothers, leads)",
    "agw_tools": "unchanged (unclassified in ADR-008)",
    "agw_opencode_impl": "iu (routine fixes, investigate)",
    "research": "iu",
    "hermes": "iu",
    "other": "unchanged",
}

SNAP_ROOT = Path(os.environ.get("FACTORY_SNAPSHOTS", str(Path.home() / ".local/share/factory/snapshots")))
SNAP_DB = SNAP_ROOT / AS_OF_RAW[:10] / "usage.db"
LIVE_DB = Path(os.environ.get("USAGE_LIVE_DB", str(Path.home() / ".local/share/usage-tracker/usage.db")))
LIVE_ONLY_SOURCE = "agent-gateway-opencode"


def iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def pctl(vals: list[float], p: float) -> float | None:
    """Linear-interpolated percentile (p in 0..100)."""
    if not vals:
        return None
    v = sorted(vals)
    k = (len(v) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def r(x: float | None, n: int = 2) -> float | None:
    return None if x is None else round(x, n)


def tilde(path: str | None) -> str:
    p = path or ""
    for home in ("/Users/" + "jkrumm", "/Users/" + "johannes.krumm"):
        p = p.replace(home, "~")
    return p


def repo_of(project: str | None) -> str:
    """Repo name only: first path component under SourceRoot/IuRoot (worktrees fold into their repo)."""
    p = tilde(project)
    for root in ("~/SourceRoot/", "~/IuRoot/"):
        if p.startswith(root):
            name = p[len(root):].split("/")[0]
            return name[:-3] if name.endswith("-wt") else name
    return p or "(none)"


def classify(source: str, billing: str, sub: str, project: str | None) -> str:
    if source == "claude-code" and billing == "max" and sub == "interactive":
        return "owner_interactive"
    if source == "opencode" and sub == "interactive":
        return "owner_interactive"
    if source == "claude-code" and sub in ("wave", "fleet", "fan"):
        return "fleet_waves"
    if source == "research-gateway":
        return "research"
    if source == "hermes":
        return "hermes"
    if sub.endswith(":dispatch") or sub == "dispatch":
        return "agw_opencode_impl"
    if source == "agent-gateway-opencode" and sub in ("", "-"):
        return "agw_opencode_impl"          # untagged v2 rows: the dispatch store's remainder
    if sub.startswith("agent-gateway:") or source in ("agent-gateway-iu", "agent-gateway-opencode"):
        return "agw_tools"
    return "other"


def is_fleet_project(project: str | None) -> bool:
    return repo_of(project) in FLEET_PROJECTS


# --------------------------------------------------------------------------- data
SUM = ("sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens)", "sum(coalesce(cost_usd,0))")


def grouped(con: sqlite3.Connection, t0: str, t1: str, source: str | None = None) -> list[tuple]:
    q = (f"select source, billing, coalesce(sub_tool,''), project, count(*), {SUM[0]}, {SUM[1]} "
         "from usage_record where ts >= ? and ts < ?")
    args: list = [t0, t1]
    if source:
        q += " and source = ?"
        args.append(source)
    else:
        q += " and source != ?"
        args.append(LIVE_ONLY_SOURCE)
    q += " group by 1,2,3,4"
    return con.execute(q, args).fetchall()


def load_window(snap: sqlite3.Connection, live: sqlite3.Connection, days: int) -> list[dict]:
    t0 = iso(AS_OF - dt.timedelta(days=days))
    t1 = iso(AS_OF)
    out = []
    for con, source in ((snap, None), (live, LIVE_ONLY_SOURCE)):
        for src, billing, sub, project, n, tok, usd in grouped(con, t0, t1, source):
            out.append({"source": src, "billing": billing, "sub": sub, "project": project,
                        "rows": n, "tokens": tok or 0, "usd": usd or 0.0,
                        "class": classify(src, billing, sub, project)})
    return out


def opencode_gap(snap: sqlite3.Connection, live: sqlite3.Connection) -> tuple[dt.datetime, dt.datetime] | None:
    """Window between the last v1 OpenCode agw row and the first v2 row: nothing was collected."""
    last_v1 = snap.execute("select max(ts) from usage_record where source='opencode' "
                           "and sub_tool like 'agent-gateway:%' and ts < ?", (iso(AS_OF),)).fetchone()[0]
    first_v2 = live.execute("select min(ts) from usage_record where source=? and ts < ?",
                            (LIVE_ONLY_SOURCE, iso(AS_OF))).fetchone()[0]
    if not last_v1 or not first_v2:
        return None
    p = lambda s: dt.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc)
    a, b = p(last_v1), p(first_v2)
    return (a, b) if b > a else None


def is_oc_collected(row: dict) -> bool:
    return (row["source"] == "opencode" and row["sub"].startswith("agent-gateway:")) or row["source"] == LIVE_ONLY_SOURCE


def covered_days(days: int, gap) -> float:
    if not gap:
        return float(days)
    w0, w1 = AS_OF - dt.timedelta(days=days), AS_OF
    ov = max(0.0, (min(w1, gap[1]) - max(w0, gap[0])).total_seconds() / 86400)
    return days - ov


def weekly(rows: list[dict], days: int, gap) -> dict:
    """Per class and billing: weekly tokens and USD."""
    f_all = 7 / days
    f_oc = 7 / covered_days(days, gap)
    agg: dict = defaultdict(lambda: {"tokens": 0.0, "usd": 0.0, "rows": 0})
    for row in rows:
        f = f_oc if is_oc_collected(row) else f_all
        a = agg[(row["class"], row["billing"])]
        a["tokens"] += row["tokens"] * f
        a["usd"] += row["usd"] * f
        a["rows"] += row["rows"]
    return agg


# --------------------------------------------------------------------------- main
def main() -> None:
    ep = json.loads((HERE / "engine_policy.out.json").read_text())
    quota = json.loads((HERE / "quota.out.json").read_text())
    per_pct_cycles = ep["max_list_usd_per_1pct_week"]["cycles"]
    per_pct_median = ep["max_list_usd_per_1pct_week"]["median"]
    iu_ratio = ep["iu_cost_per_week_usd"] / ep["sonnet_list_per_week_usd"]
    global IU_USD_PER_MAX_LIST_USD
    IU_USD_PER_MAX_LIST_USD = iu_ratio
    lo_pp, hi_pp = min(per_pct_cycles), max(per_pct_cycles)   # USD per 1 %: dear = few %, cheap = many %

    def pct(usd: float, per: float) -> float:
        return usd / per

    def pct_range(usd: float) -> dict:
        return {"median": r(pct(usd, per_pct_median), 1), "low": r(pct(usd, hi_pp), 1), "high": r(pct(usd, lo_pp), 1)}

    snap, live = ro(SNAP_DB), ro(LIVE_DB)
    gap = opencode_gap(snap, live)
    assert snap.execute("select count(*) from usage_record where source=?", (LIVE_ONLY_SOURCE,)).fetchone()[0] == 0, \
        "snapshot already holds the live-only source: double count"

    # ---- today: per-class weekly, both windows
    win_rows = {d: load_window(snap, live, d) for d in WINDOWS}
    win_weekly = {d: weekly(win_rows[d], d, gap) for d in WINDOWS}
    today = win_weekly[HEADLINE_DAYS]

    def cls_line(agg, c, billing):
        a = agg.get((c, billing), {"tokens": 0.0, "usd": 0.0, "rows": 0})
        return a["tokens"], a["usd"]

    # ---- wave session size (median over sessions) -> tokens per wake
    t0 = iso(AS_OF - dt.timedelta(days=HEADLINE_DAYS))
    sess = snap.execute(
        "select json_extract(raw,'$.sessionId') sid, sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens), "
        "sum(coalesce(cost_usd,0)) from usage_record where source='claude-code' and billing='max' and sub_tool='wave' "
        "and ts >= ? and ts < ? and sid is not null group by sid", (t0, iso(AS_OF))).fetchall()
    sess_tokens = [s[1] for s in sess]
    sess_usd = [s[2] for s in sess]
    wave_tok, wave_usd = cls_line(today, "fleet_waves", "max")
    wave_rows = [x for x in win_rows[HEADLINE_DAYS] if x["class"] == "fleet_waves"]
    w_tokens_30d = sum(x["tokens"] for x in wave_rows if x["sub"] == "wave")
    w_usd_30d = sum(x["usd"] for x in wave_rows if x["sub"] == "wave")
    usd_per_token = w_usd_30d / w_tokens_30d if w_tokens_30d else 0.0
    median_session_tokens = pctl(sess_tokens, 50) or 0.0
    tokens_per_wake = WAKE_SIZE_FRACTION * median_session_tokens
    usd_per_wake = tokens_per_wake * usd_per_token
    wakes_per_week_mothers = MOTHERS * (MOTHER_WAKES_PER_DAY + MOTHER_ROTATIONS_PER_DAY) * 7
    wakes_per_week_leads = LEADS * LEAD_WAKES_PER_DAY * 7
    mother_usd_wk = wakes_per_week_mothers * usd_per_wake
    lead_usd_wk = wakes_per_week_leads * usd_per_wake
    mother_tok_wk = wakes_per_week_mothers * tokens_per_wake
    lead_tok_wk = wakes_per_week_leads * tokens_per_wake

    # ---- projection by class
    proj: dict = {}
    for c in CLASSES:
        tk_m, usd_m = cls_line(today, c, "max")
        tk_i, usd_i = cls_line(today, c, "iu")
        moved_usd = moved_tok = 0.0
        if c == "fleet_waves":
            moved_usd, moved_tok = usd_m * WAVE_ROUTINE_TO_IU_SHARE, tk_m * WAVE_ROUTINE_TO_IU_SHARE
        if c == "agw_tools":
            moved_usd, moved_tok = usd_m * AGW_TOOLS_MAX_TO_IU_SHARE, tk_m * AGW_TOOLS_MAX_TO_IU_SHARE
        add_usd = (mother_usd_wk + lead_usd_wk) if c == "fleet_waves" else 0.0
        add_tok = (mother_tok_wk + lead_tok_wk) if c == "fleet_waves" else 0.0
        proj[c] = {
            "max_usd": usd_m - moved_usd + add_usd, "max_tokens": tk_m - moved_tok + add_tok,
            "iu_usd": usd_i + moved_usd * iu_ratio, "iu_tokens": tk_i + moved_tok,
        }

    # ---- per-cycle: shares, lapsed, projected
    cycles = [c for c in quota["weekly_cycles"] if not c["partial"] and c["ended_by_reset"] and c["start_is_reset"]]
    assert len(cycles) == len(per_pct_cycles), (len(cycles), len(per_pct_cycles))
    cyc_out = []
    own_per_pct_check = []
    for c, per in zip(cycles, per_pct_cycles):
        a, b = c["start"], c["end"]
        days = (dt.datetime.strptime(b, "%Y-%m-%dT%H:%M:%SZ") - dt.datetime.strptime(a, "%Y-%m-%dT%H:%M:%SZ")).total_seconds() / 86400
        by_class: dict = defaultdict(float)
        for src, billing, sub, project, n, tok, usd in grouped(snap, a, b):
            if billing == "max":
                by_class[classify(src, billing, sub, project)] += usd or 0.0
        total = sum(by_class.values())
        own_per_pct_check.append(r(total / c["peak_7d"], 2))
        share = by_class["owner_interactive"] / per
        # projection: weekly delta of Max USD (design - today), scaled to this cycle's length
        delta_wk = sum(p["max_usd"] for p in proj.values()) - sum(cls_line(today, k, "max")[1] for k in CLASSES)
        proj_pct = c["peak_7d"] + delta_wk * days / 7 / per
        cyc_out.append({
            "start": a, "end": b, "days": r(days, 2), "usd_per_1pct": per, "peak_7d_pct": c["peak_7d"],
            "max_list_usd": r(total, 0), "owner_interactive_usd": r(by_class["owner_interactive"], 0),
            "owner_share_of_window_pct": r(share, 1),
            "owner_share_per_7d_pct": r(share * 7 / days, 1),
            "factory_share_of_window_pct": r((total - by_class["owner_interactive"]) / per, 1),
            "lapsed_pct_today": r(max(0.0, 100 - c["peak_7d"]), 1),
            "projected_demand_pct": r(proj_pct, 1),
            "projected_lapsed_pct": r(max(0.0, 100 - proj_pct), 1),
            "projected_overflow_pct": r(max(0.0, proj_pct - 100), 1),
        })

    def stat(key):
        v = [x[key] for x in cyc_out]
        return {"p50": r(pctl(v, 50), 1), "p90": r(pctl(v, 90), 1), "min": r(min(v), 1), "max": r(max(v), 1)}

    # ---- totals
    today_max_usd = sum(cls_line(today, c, "max")[1] for c in CLASSES)
    today_iu_usd = sum(cls_line(today, c, "iu")[1] for c in CLASSES)
    proj_max_usd = sum(p["max_usd"] for p in proj.values())
    proj_iu_usd = sum(p["iu_usd"] for p in proj.values())
    recent = win_weekly[7]
    recent_max = sum(a["usd"] for (c, b), a in recent.items() if b == "max")
    recent_iu = sum(a["usd"] for (c, b), a in recent.items() if b == "iu")

    # sensitivities (Max USD/week, IU USD/week)
    def sens(wave_share=0.0, agw_share=0.0):
        mx = proj_max_usd - cls_line(today, "fleet_waves", "max")[1] * (wave_share - WAVE_ROUTINE_TO_IU_SHARE) \
            - cls_line(today, "agw_tools", "max")[1] * (agw_share - AGW_TOOLS_MAX_TO_IU_SHARE)
        iu = proj_iu_usd + iu_ratio * (cls_line(today, "fleet_waves", "max")[1] * (wave_share - WAVE_ROUTINE_TO_IU_SHARE)
                                       + cls_line(today, "agw_tools", "max")[1] * (agw_share - AGW_TOOLS_MAX_TO_IU_SHARE))
        return {"max_usd_wk": r(mx, 0), "max_pct_wk": pct_range(mx), "iu_usd_wk": r(iu, 1)}

    sensitivities = {f"waves_routine_{int(s * 100)}pct_to_iu": sens(wave_share=s) for s in SENSITIVITY_WAVE_ROUTINE_SHARES}
    sensitivities["agw_tools_all_to_iu"] = sens(agw_share=1.0)
    sensitivities["no_mothers_or_leads"] = {
        "max_usd_wk": r(proj_max_usd - mother_usd_wk - lead_usd_wk, 0),
        "max_pct_wk": pct_range(proj_max_usd - mother_usd_wk - lead_usd_wk), "iu_usd_wk": r(proj_iu_usd, 1)}
    for mult in (2, 4):
        extra = (mother_usd_wk + lead_usd_wk) * (mult - 1)
        sensitivities[f"wake_load_x{mult}"] = {
            "max_usd_wk": r(proj_max_usd + extra, 0), "max_pct_wk": pct_range(proj_max_usd + extra),
            "iu_usd_wk": r(proj_iu_usd, 1)}

    # ---- class table
    classes_out = {}
    for c in CLASSES:
        tk_m, usd_m = cls_line(today, c, "max")
        tk_i, usd_i = cls_line(today, c, "iu")
        _, usd_m7 = cls_line(recent, c, "max")
        _, usd_i7 = cls_line(recent, c, "iu")
        p = proj[c]
        classes_out[c] = {
            "engine_adr008": MAX_CLASS_ENGINE_ADR008[c],
            "today_30d": {
                "max_tokens_wk": r(tk_m, 0), "max_list_usd_wk": r(usd_m, 0), "max_pct_wk": pct_range(usd_m),
                "iu_tokens_wk": r(tk_i, 0), "iu_usd_wk": r(usd_i, 2)},
            "recent_7d": {"max_list_usd_wk": r(usd_m7, 0), "max_pct_wk": pct_range(usd_m7), "iu_usd_wk": r(usd_i7, 2)},
            "projected": {
                "max_tokens_wk": r(p["max_tokens"], 0), "max_list_usd_wk": r(p["max_usd"], 0),
                "max_pct_wk": pct_range(p["max_usd"]), "iu_tokens_wk": r(p["iu_tokens"], 0), "iu_usd_wk": r(p["iu_usd"], 2)},
        }

    # ---- sub-tool and project detail (30 d, weekly)
    f30 = 7 / HEADLINE_DAYS
    f_oc = 7 / covered_days(HEADLINE_DAYS, gap)
    by_sub: dict = defaultdict(lambda: {"tokens": 0.0, "usd": 0.0})
    by_proj: dict = defaultdict(float)
    fleet_split = {"fleet_projects": 0.0, "other_projects": 0.0}
    for row in win_rows[HEADLINE_DAYS]:
        f = f_oc if is_oc_collected(row) else f30
        k = (row["class"], row["source"], row["billing"], row["sub"] or "-")
        by_sub[k]["tokens"] += row["tokens"] * f
        by_sub[k]["usd"] += row["usd"] * f
        if row["class"] == "fleet_waves":
            by_proj[repo_of(row["project"])] += row["usd"] * f
            fleet_split["fleet_projects" if is_fleet_project(row["project"]) else "other_projects"] += row["usd"] * f
    sub_out = [{"class": k[0], "source": k[1], "billing": k[2], "sub_tool": redact(k[3]),
                "tokens_wk": r(v["tokens"], 0), "usd_wk": r(v["usd"], 2)}
               for k, v in sorted(by_sub.items(), key=lambda kv: (-kv[1]["usd"], kv[0]))]
    proj_out = [{"repo": redact(k), "max_list_usd_wk": r(v, 0)}
                for k, v in sorted(by_proj.items(), key=lambda kv: -kv[1])[:TOP_PROJECTS]]

    out = {
        "as_of": AS_OF_RAW,
        "script": "kpi/forecast.py",
        "question": "cos-1: factory cost per week in Max % of the weekly window and IU dollars, today vs ADR-007/008",
        "definitions": {
            "weekly": f"window total x 7 / days covered; OpenCode-collected agw rows exclude the v1->v2 collector gap",
            "max_pct": "Max list USD per week / (list USD per 1 % of the weekly window); median uses the median "
                       "cycle value, low/high use the dearest/cheapest cycle",
            "cycle_share": "class Max list USD in a complete weekly cycle / that cycle's USD per 1 %",
            "lapsed_pct": "100 - the cycle's peak 7-day reading (usage the window could have carried but did not)",
            "projected_demand_pct": "cycle peak + weekly Max delta of the design, scaled to the cycle length; "
                                    "may exceed 100 (= demand the guard must defer or flip to IU)",
        },
        "constants": {
            "headline_window_days": HEADLINE_DAYS, "fleet_projects": list(FLEET_PROJECTS),
            "mothers": MOTHERS, "mother_wakes_per_day": MOTHER_WAKES_PER_DAY,
            "mother_rotations_per_day": MOTHER_ROTATIONS_PER_DAY, "leads": LEADS,
            "lead_wakes_per_day": LEAD_WAKES_PER_DAY, "wake_size_fraction_of_median_wave_session": WAKE_SIZE_FRACTION,
            "wave_routine_to_iu_share": WAVE_ROUTINE_TO_IU_SHARE,
            "agw_tools_max_to_iu_share": AGW_TOOLS_MAX_TO_IU_SHARE,
            "iu_usd_per_max_list_usd": r(iu_ratio, 4),
            "usd_per_1pct_cycles": per_pct_cycles, "usd_per_1pct_median": per_pct_median,
            "owner_reserve_adr008_pct": OWNER_RESERVE_ADR008_PCT,
        },
        "collection": {
            "live_only_source": LIVE_ONLY_SOURCE,
            "opencode_gap_days_excluded_30d": r(HEADLINE_DAYS - covered_days(HEADLINE_DAYS, gap), 2),
            "own_usd_per_1pct_check": own_per_pct_check,
        },
        "wave_session": {
            "sessions_30d": len(sess), "median_tokens": r(median_session_tokens, 0),
            "p90_tokens": r(pctl(sess_tokens, 90), 0), "median_list_usd": r(pctl(sess_usd, 50), 2),
            "p90_list_usd": r(pctl(sess_usd, 90), 2), "wave_usd_per_million_tokens": r(usd_per_token * 1e6, 2),
            "tokens_per_wake": r(tokens_per_wake, 0), "list_usd_per_wake": r(usd_per_wake, 2),
            "mother_wakes_per_week": wakes_per_week_mothers, "lead_wakes_per_week": wakes_per_week_leads,
            "mother_list_usd_wk": r(mother_usd_wk, 0), "lead_list_usd_wk": r(lead_usd_wk, 0),
            "mother_pct_wk": pct_range(mother_usd_wk), "lead_pct_wk": pct_range(lead_usd_wk),
        },
        "totals": {
            "today_30d": {"max_list_usd_wk": r(today_max_usd, 0), "max_pct_wk": pct_range(today_max_usd),
                          "iu_usd_wk": r(today_iu_usd, 1)},
            "recent_7d": {"max_list_usd_wk": r(recent_max, 0), "max_pct_wk": pct_range(recent_max),
                          "iu_usd_wk": r(recent_iu, 1)},
            "projected": {"max_list_usd_wk": r(proj_max_usd, 0), "max_pct_wk": pct_range(proj_max_usd),
                          "iu_usd_wk": r(proj_iu_usd, 1)},
        },
        "classes": classes_out,
        "fleet_waves_split_wk": {k: r(v, 0) for k, v in fleet_split.items()},
        "fleet_waves_top_repos": proj_out,
        "sub_tools": sub_out,
        "cycles": cyc_out,
        "owner_interactive_share_of_window_pct": {
            "per_cycle": stat("owner_share_of_window_pct"), "per_7d": stat("owner_share_per_7d_pct"),
            "adr008_reserve_pct": OWNER_RESERVE_ADR008_PCT,
            "cycles_above_reserve": sum(1 for x in cyc_out if x["owner_share_per_7d_pct"] > OWNER_RESERVE_ADR008_PCT),
            "cycles": len(cyc_out)},
        "lapsed_pct": {"today": stat("lapsed_pct_today"), "projected": stat("projected_lapsed_pct")},
        "projected_demand_pct": stat("projected_demand_pct"),
        "projected_overflow_pct": stat("projected_overflow_pct"),
        "cycles_projected_demand_over_100": sum(1 for x in cyc_out if x["projected_demand_pct"] > 100),
        "sensitivities": sensitivities,
        "notes": [
            "Max rows are list-price equivalents (sunk subscription); IU rows are cash.",
            "Mother/lead load is an assumption set, not a measurement: no mother runs yet (report/05-decisions.md).",
            "Today's cycle % is the measured 7-day peak by construction ($/1 % is calibrated on the same cycles).",
            "A cycle's peak is censored at 100 %: where it hit 100, true demand was higher, so design demand and overflow there are lower bounds.",
            "recent_7d is a calendar 7 days spanning two resets (10-17 unscheduled, 10-21 scheduled); it is a burn-rate signal, not a window reading.",
            "claude-code agent-gateway:dispatch on IU stopped 2026-09-24; it inflates the 30 d IU rate versus recent_7d.",
        ],
    }
    out = json.loads(redact(json.dumps(out, indent=1, sort_keys=True)))
    (HERE / "forecast.out.json").write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
    (HERE / "forecast.out.md").write_text(render(out))
    t = out["totals"]
    print(json.dumps({"today": t["today_30d"], "projected": t["projected"]}))


def fmt_range(p: dict) -> str:
    return f"{p['median']:.0f} ({p['low']:.0f}-{p['high']:.0f})"


def render(o: dict) -> str:
    L = ["# Factory weekly capacity: today vs full design (ADR-007 / ADR-008)", "",
         f"AS_OF {o['as_of']}. `{o['script']}`. Max in list USD and % of the weekly window "
         "(median; range = dearest..cheapest cycle). IU in cash USD.", "",
         "## Capacity per week", "",
         "|class|today Max $|today Max %|today IU $|design Max $|design Max %|design IU $|engine under ADR-008|",
         "|-|-|-|-|-|-|-|-|"]
    for c, v in o["classes"].items():
        t, p = v["today_30d"], v["projected"]
        L.append(f"|{c}|{t['max_list_usd_wk']:,.0f}|{fmt_range(t['max_pct_wk'])}|{t['iu_usd_wk']:,.1f}|"
                 f"{p['max_list_usd_wk']:,.0f}|{fmt_range(p['max_pct_wk'])}|{p['iu_usd_wk']:,.1f}|{v['engine_adr008']}|")
    t, p, rc = o["totals"]["today_30d"], o["totals"]["projected"], o["totals"]["recent_7d"]
    L.append(f"|**total**|{t['max_list_usd_wk']:,.0f}|{fmt_range(t['max_pct_wk'])}|{t['iu_usd_wk']:,.1f}|"
             f"{p['max_list_usd_wk']:,.0f}|{fmt_range(p['max_pct_wk'])}|{p['iu_usd_wk']:,.1f}||")
    L.append(f"|recent 7 d (context)|{rc['max_list_usd_wk']:,.0f}|{fmt_range(rc['max_pct_wk'])}|{rc['iu_usd_wk']:,.1f}|||||")
    w = o["wave_session"]
    L += ["", "## Mother and lead wakes (assumption, not measurement)", "",
          f"- {o['constants']['mothers']} mothers x ({o['constants']['mother_wakes_per_day']} wakes + "
          f"{o['constants']['mother_rotations_per_day']} rotation)/day, {o['constants']['leads']} leads x "
          f"{o['constants']['lead_wakes_per_day']} wakes/day = {w['mother_wakes_per_week'] + w['lead_wakes_per_week']} wakes/week.",
          f"- Wake = {o['constants']['wake_size_fraction_of_median_wave_session']} x median wave session "
          f"({w['median_tokens']:,.0f} tokens over {w['sessions_30d']} sessions, p90 {w['p90_tokens']:,.0f}) = "
          f"{w['tokens_per_wake']:,.0f} tokens = ${w['list_usd_per_wake']} list (wave rate ${w['wave_usd_per_million_tokens']}/M tokens).",
          f"- Mothers ${w['mother_list_usd_wk']:,.0f}/week = {fmt_range(w['mother_pct_wk'])} %; "
          f"leads ${w['lead_list_usd_wk']:,.0f}/week = {fmt_range(w['lead_pct_wk'])} %.",
          "", "## Per weekly cycle (7 complete cycles)", "",
          "|cycle start|days|$/1 %|peak 7d %|owner $|owner % of window|owner % per 7 d|factory %|lapsed % today|design demand %|design lapsed %|design overflow %|",
          "|-|-|-|-|-|-|-|-|-|-|-|-|"]
    for c in o["cycles"]:
        L.append(f"|{c['start'][:10]}|{c['days']}|{c['usd_per_1pct']}|{c['peak_7d_pct']}|{c['owner_interactive_usd']:,.0f}|"
                 f"{c['owner_share_of_window_pct']}|{c['owner_share_per_7d_pct']}|{c['factory_share_of_window_pct']}|"
                 f"{c['lapsed_pct_today']}|{c['projected_demand_pct']}|{c['projected_lapsed_pct']}|{c['projected_overflow_pct']}|")
    s, s7 = o["owner_interactive_share_of_window_pct"]["per_cycle"], o["owner_interactive_share_of_window_pct"]["per_7d"]
    lp, lj = o["lapsed_pct"]["today"], o["lapsed_pct"]["projected"]
    L += ["", f"- Owner-interactive share per cycle: p50 {s['p50']} %, p90 {s['p90']} % (per 7 d: p50 {s7['p50']}, p90 {s7['p90']}); "
          f"ADR-008 reserve {o['constants']['owner_reserve_adr008_pct']} %, exceeded in "
          f"{o['owner_interactive_share_of_window_pct']['cycles_above_reserve']} of {o['owner_interactive_share_of_window_pct']['cycles']} cycles (per 7 d).",
          f"- Max lapsed per cycle today: p50 {lp['p50']} %, p90 {lp['p90']} %; design: p50 {lj['p50']} %, p90 {lj['p90']} %.",
          f"- Design demand per cycle: p50 {o['projected_demand_pct']['p50']} %, p90 {o['projected_demand_pct']['p90']} %; "
          f"over 100 % in {o['cycles_projected_demand_over_100']} of {len(o['cycles'])} cycles.",
          "", "## Sensitivities (design, per week)", "", "|case|Max $|Max %|IU $|", "|-|-|-|-|"]
    for k, v in o["sensitivities"].items():
        L.append(f"|{k}|{v['max_usd_wk']:,.0f}|{fmt_range(v['max_pct_wk'])}|{v['iu_usd_wk']:,.1f}|")
    L += ["", "## Fleet waves by repo (Max list $/week, top)", "", "|repo|$|", "|-|-|"]
    L += [f"|{x['repo']}|{x['max_list_usd_wk']:,.0f}|" for x in o["fleet_waves_top_repos"]]
    L += ["", "## Notes", ""] + [f"- {n}" for n in o["notes"]]
    L += [f"- OpenCode collector gap excluded from the 30 d divisor: {o['collection']['opencode_gap_days_excluded_30d']} days.",
          f"- Own $/1 % check (cycle Max list / peak): {o['collection']['own_usd_per_1pct_check']} vs engine_policy {o['constants']['usd_per_1pct_cycles']}."]
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    main()
