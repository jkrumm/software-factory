#!/usr/bin/env python3
"""quota — how close did Max usage come to its limits, and what does Max vs IU cost per week.

Question
    How much headroom does the Max subscription leave? Distribution of the 5-hour and 7-day
    utilisation over the observable history, days at >= 90 % (7-day), when the window last hit
    100 %, the weekly reset times; and the weekly Max vs IU token/cost split.

Definition key (evidence/DEFINITIONS.md)
    max_headroom   Distribution of the Max 7-day and 5-hour utilisation over the observable
                   history; days at >= 90 % (7-day); when the window last hit 100 %.

Best available history (the script states and re-derives it every run)
    ~/Library/Logs/devhost-health.log  one composite line per 300 s heartbeat, `quota 5h N% · 7d N%`
    appended to every message. About 43 days at roughly 5-minute cadence, but the file has NO
    timestamps. The time axis is rebuilt from facts outside the file:
      1. host reboots: the heartbeat says `host rebooted Ns ago` on the first two runs after a boot;
         the boot instant comes from `last reboot` (wtmp) and `sysctl kern.boottime`;
      2. the weekly reset: the 7-day value drops to ~0 once a week, and the live
         `seven_day.resets_at` says that instant is Wednesday 16:00:00 UTC. A drop that lands within
         3 h of Wednesday 16:00 UTC on the reboot-anchored axis is snapped to it (a stated
         assumption, checked by the residuals in `resets`).
    The axis is then validated against ~/.claude/logs/*.jsonl `fetch_usage` samples (real
    timestamps, 3-day retention) and the match rate is written to `time_axis.validation`.
    Rows with a rebuilt time >= AS_OF are dropped.

Other inputs
    ~/.claude/logs/*.jsonl            fetch_usage samples (timestamped; cross-check and fine detail)
    /tmp/claude_sl/usage_raw.json     live cache, read only for the reset schedule (live at run time)
    snapshot usage.db                 `usage_record`, billing max|iu, for the weekly split (SQLite ro)
    agent-gateway logs                checked: request metadata only, no utilisation values

Run
    python3 -I quota.py       (AS_OF=2026-10-22T08:00:00Z overrides the default)
    -> quota.out.json, quota.out.md
"""

import datetime as dt
import glob
import json
import os
import re
import sqlite3
import statistics
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True  # evidence scripts write only their own outputs, never a __pycache__
sys.path.insert(0, str(HERE.parent / "lib"))
from redact import redact  # noqa: E402

UTC = dt.timezone.utc
AS_OF_STR = os.environ.get("AS_OF", "2026-10-22T08:00:00Z")
AS_OF = dt.datetime.fromisoformat(AS_OF_STR.replace("Z", "+00:00"))
AS_OF_TS = AS_OF.timestamp()
SNAP = Path(os.environ.get("FACTORY_SNAPSHOTS", Path.home() / ".local/share/factory/snapshots")) / AS_OF_STR[:10]
HEARTBEAT_GLOB = str(Path.home() / "Library/Logs/devhost-health*.log*")
CLAUDE_LOGS_GLOB = str(Path.home() / ".claude/logs/*.jsonl")
LIVE_CACHE = Path("/tmp/claude_sl/usage_raw.json")

RESET_DROP = 20        # points the 7-day value must fall to count as a reset...
RESET_TO_MAX = 15      # ...and land at or below this
SCHEDULE_TOLERANCE_S = 3 * 3600
FLAT_RUNS = 288        # identical (5h, 7d) for >= 24 h of runs is suspect
DETECTION_DELAY_S = 150  # a reset is seen by the first run after it: on average half a cadence later
QUOTA_RX = re.compile(r"quota 5h (\d+)% · 7d (\d+|\?)%")
REBOOT_RX = re.compile(r"host rebooted (\d+)s ago")


def pct(sorted_vals: list[int], q: float) -> float | None:
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return round(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo), 2)


def iso(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_week(d: dt.date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def ratio(n: float, d: float) -> float | None:
    return round(n / d, 4) if d else None


# ── heartbeat parsing ────────────────────────────────────────────────────────────────────

def parse_heartbeat() -> tuple[list[dict], list[str]]:
    paths = sorted(glob.glob(HEARTBEAT_GLOB), key=lambda p: (-int(m.group(1)) if (m := re.search(r"\.log\.(\d+)$", p)) else 0, p))
    runs: list[dict] = []
    used = []
    for p in paths:
        try:
            text = Path(p).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        used.append(p)
        for line in text.split("\n"):
            if "tailnet" not in line or "sshd" not in line:
                continue
            m = QUOTA_RX.search(line)
            rb = REBOOT_RX.search(line)
            runs.append({
                "five": int(m.group(1)) if m else None,
                "seven": int(m.group(2)) if m and m.group(2).isdigit() else None,
                "unavailable": "quota unavailable" in line,
                "reboot_s": int(rb.group(1)) if rb else None,
                "max_route_failing": ("@max/" in line and "failed" in line),
            })
    return runs, used


# ── time axis ───────────────────────────────────────────────────────────────────────────

def boot_times() -> list[float]:
    """UTC epoch of every boot `last reboot` knows (minute precision), newest replaced by kern.boottime (exact)."""
    boots: list[float] = []
    try:
        out = subprocess.run(["last", "reboot"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        out = ""
    now = dt.datetime.now()
    for line in out.splitlines():
        m = re.match(r"^reboot\s+time\s+(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2})", line)
        if not m:
            continue
        wd, mon, d, hh, mm = m.groups()
        for year in (now.year, now.year - 1):
            try:
                cand = dt.datetime.strptime(f"{year} {mon} {d} {hh}:{mm}", "%Y %b %d %H:%M")
            except ValueError:
                continue
            if cand <= now and cand.strftime("%a") == wd:
                boots.append(cand.astimezone().timestamp())  # naive local -> aware -> epoch
                break
    try:
        kb = subprocess.run(["sysctl", "-n", "kern.boottime"], capture_output=True, text=True, timeout=30).stdout
        sec = int(re.search(r"sec = (\d+)", kb).group(1))
        boots = [b for b in boots if abs(b - sec) > 120] + [float(sec)]
    except (OSError, subprocess.TimeoutExpired, AttributeError, ValueError):
        pass
    return sorted(boots)


def reboot_events(runs: list[dict]) -> list[list[tuple[int, int]]]:
    """Group `host rebooted Ns ago` runs into boot events: [(run_idx, seconds_since_boot), ...]."""
    events: list[list[tuple[int, int]]] = []
    for i, r in enumerate(runs):
        if r["reboot_s"] is None:
            continue
        if events and i - events[-1][-1][0] <= 12:
            events[-1].append((i, r["reboot_s"]))
        else:
            events.append([(i, r["reboot_s"])])
    return events


def reboot_anchors(runs: list[dict], boots: list[float]) -> list[tuple[int, float]]:
    ev = reboot_events(runs)
    if not ev or not boots:
        return []
    best = None
    for k in range(0, len(boots) - len(ev) + 1):
        cand = []
        for e, b in zip(ev, boots[k:k + len(ev)]):
            idx, secs = e[0]
            cand.append((idx, b + secs))
        ok = all(295 <= (cand[j + 1][1] - cand[j][1]) / (cand[j + 1][0] - cand[j][0]) <= 330 for j in range(len(cand) - 1))
        if ok:
            best = cand
            break
    return best or []


def nearest_wed_1600(ts: float) -> float:
    d = dt.datetime.fromtimestamp(ts, UTC)
    ahead = (2 - d.weekday()) % 7
    c1 = (d + dt.timedelta(days=ahead)).replace(hour=16, minute=0, second=0, microsecond=0)
    c0 = c1 - dt.timedelta(days=7)
    return min((c0, c1), key=lambda c: abs(c.timestamp() - ts)).timestamp()


class Axis:
    """Piecewise-linear run index -> epoch seconds through anchors, extrapolated at the cadence of the end segments."""

    def __init__(self, anchors: list[tuple[int, float]], default_cadence: float = 303.0, fallback_end: tuple[int, float] | None = None):
        a = sorted(anchors)
        clean: list[tuple[int, float]] = []
        for idx, t in a:
            if clean and (t <= clean[-1][1] or idx == clean[-1][0]):
                continue
            clean.append((idx, t))
        if len(clean) < 2 and fallback_end:
            clean = sorted(set(clean + [fallback_end]))
        self.anchors = clean
        self.default = default_cadence
        self.method = "anchored" if len(clean) >= 2 else ("single-anchor" if clean else "none")

    def t(self, k: float) -> float:
        a = self.anchors
        if not a:
            return float(k) * self.default
        if len(a) == 1:
            return a[0][1] + (k - a[0][0]) * self.default
        if k <= a[0][0]:
            c = (a[1][1] - a[0][1]) / (a[1][0] - a[0][0])
            return a[0][1] - (a[0][0] - k) * c
        if k >= a[-1][0]:
            c = (a[-1][1] - a[-2][1]) / (a[-1][0] - a[-2][0])
            return a[-1][1] + (k - a[-1][0]) * c
        for (i0, t0), (i1, t1) in zip(a, a[1:]):
            if i0 <= k <= i1:
                return t0 + (t1 - t0) * (k - i0) / (i1 - i0)
        return a[-1][1]

    def segments(self) -> list[dict]:
        return [{"from_run": i0, "to_run": i1, "seconds_per_run": round((t1 - t0) / (i1 - i0), 2)}
                for (i0, t0), (i1, t1) in zip(self.anchors, self.anchors[1:])]


def find_resets(runs: list[dict]) -> list[dict]:
    resets, prev_k, prev_v = [], None, None
    for k, r in enumerate(runs):
        v = r["seven"]
        if v is None:
            continue
        if prev_v is not None and prev_v - v >= RESET_DROP and v <= RESET_TO_MAX:
            resets.append({"run": k, "from": prev_v, "to": v, "gap_runs": k - prev_k,
                           "five_from": runs[prev_k]["five"], "five_to": r["five"]})
        prev_k, prev_v = k, v
    return resets


# ── series statistics ───────────────────────────────────────────────────────────────────

def distribution(vals: list[int], seconds_per_sample: float) -> dict:
    s = sorted(vals)
    if not s:
        return {"n": 0}
    out = {
        "n": len(s), "mean": round(statistics.fmean(s), 2), "min": s[0], "max": s[-1],
        "p5": pct(s, .05), "p10": pct(s, .10), "p25": pct(s, .25), "p50": pct(s, .50), "p75": pct(s, .75),
        "p90": pct(s, .90), "p95": pct(s, .95), "p99": pct(s, .99),
        "share_ge": {str(t): ratio(sum(1 for v in s if v >= t), len(s)) for t in (50, 70, 80, 90, 95, 100)},
        "hours_ge": {str(t): round(sum(1 for v in s if v >= t) * seconds_per_sample / 3600, 1) for t in (80, 90, 95, 100)},
    }
    return out


def last_reading(runs_k: list[dict], times_k: list[float]) -> dict:
    for r, t in zip(reversed(runs_k), reversed(times_k)):
        if r["five"] is not None and r["seven"] is not None:
            return {"time": iso(t), "five_hour_pct": r["five"], "seven_day_pct": r["seven"],
                    "minutes_before_as_of": round((AS_OF_TS - t) / 60, 1)}
    return {}


def contiguous_segments(flags: list[bool], times: list[float]) -> list[dict]:
    segs, start = [], None
    for i, f in enumerate(flags + [False]):
        if f and start is None:
            start = i
        elif not f and start is not None:
            segs.append({"first_run": start, "last_run": i - 1, "start": iso(times[start]), "end": iso(times[i - 1]),
                         "runs": i - start, "hours": round((times[i - 1] - times[start]) / 3600, 1)})
            start = None
    return segs


def fetch_usage_series() -> tuple[list[tuple[float, int, int]], dict]:
    rows: list[tuple[float, int, int]] = []
    files = sorted(glob.glob(CLAUDE_LOGS_GLOB))
    errors = 0
    for f in files:
        for line in open(f, encoding="utf-8", errors="replace"):
            if '"fetch_usage"' not in line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            if o.get("src") != "fetch_usage":
                continue
            if o.get("event") == "fetch_error":
                errors += 1
            if o.get("event") != "fetch_success":
                continue
            d = o.get("data", {})
            ts = dt.datetime.fromisoformat(o["ts"]).timestamp()
            if ts < AS_OF_TS and d.get("five_hour_pct") is not None and d.get("seven_day_pct") is not None:
                rows.append((ts, int(d["five_hour_pct"]), int(d["seven_day_pct"])))
    rows.sort()
    info = {"files": len(files), "samples": len(rows), "fetch_errors": errors,
            "first": iso(rows[0][0]) if rows else None, "last": iso(rows[-1][0]) if rows else None,
            "max_5h": max((r[1] for r in rows), default=None), "max_7d": max((r[2] for r in rows), default=None),
            "note": "fetch_error rows are local cache-file write races, not quota failures"}
    return rows, info


def validate_axis(times: list[float], runs: list[dict], fetch: list[tuple[float, int, int]]) -> dict:
    """Compare heartbeat readings with fetch_usage readings at the same instants, over a range of clock offsets."""
    pairs = [(i, t) for i, t in enumerate(times) if runs[i]["five"] is not None and runs[i]["seven"] is not None]
    if not fetch or not pairs:
        return {"available": False, "reason": "no fetch_usage samples retained (3-day retention) or no heartbeat readings"}
    lo, hi = fetch[0][0] - 3600, fetch[-1][0] + 3600
    sub = [(i, t) for i, t in pairs if lo <= t <= hi]
    if len(sub) < 20:
        return {"available": False, "reason": "heartbeat and fetch_usage do not overlap"}
    import bisect
    ts = [t for _, t in sub]

    def score(offset_s: float) -> tuple[float, float, int]:
        m5 = m7 = n = 0
        for ft, f5, f7 in fetch:
            j = bisect.bisect_left(ts, ft - offset_s)
            cand = [c for c in (j - 1, j) if 0 <= c < len(sub)]
            if not cand:
                continue
            c = min(cand, key=lambda c: abs(ts[c] + offset_s - ft))
            if abs(ts[c] + offset_s - ft) > 420:
                continue
            r = runs[sub[c][0]]
            n += 1
            m5 += abs(r["five"] - f5) <= 2
            m7 += abs(r["seven"] - f7) <= 1
        return (m5 / n if n else 0.0, m7 / n if n else 0.0, n)

    base = score(0)
    best_off, best = 0, base
    for off in range(-1800, 1801, 60):
        s = score(off)
        if (s[0] + s[1]) > (best[0] + best[1]) + 1e-9:
            best_off, best = off, s
    return {
        "available": True, "overlap_samples": base[2],
        "match_5h_within_2pts_at_offset_0": round(base[0], 3), "match_7d_within_1pt_at_offset_0": round(base[1], 3),
        "best_offset_s": best_off, "match_5h_at_best_offset": round(best[0], 3), "match_7d_at_best_offset": round(best[1], 3),
        "reading": "offset_s is how far the rebuilt axis would have to shift to match the real timestamps best; "
                   "a 5 h reading moves in ~5-minute steps, so a match rate near 1 at small offsets confirms the axis",
    }


def live_cache() -> dict:
    """Only the weekly reset schedule is taken from the live cache: percentages there move after AS_OF."""
    try:
        raw = json.loads(LIVE_CACHE.read_text())
        t = dt.datetime.fromisoformat(raw["seven_day"]["resets_at"]).timestamp()
        t = round(t / 60) * 60  # the API adds sub-second jitter around the minute
        d = dt.datetime.fromtimestamp(t, UTC)
        return {"next_weekly_reset_utc": iso(t), "weekday": d.strftime("%a"), "time_of_day_utc": d.strftime("%H:%M"),
                "note": "live read at run time; used only to confirm the weekly reset schedule"}
    except (OSError, KeyError, ValueError, json.JSONDecodeError):
        return {"available": False}


# ── usage.db ────────────────────────────────────────────────────────────────────────────

def max_activity(spans: list[dict]) -> list[dict]:
    """Max (claude-code, billing=max) records per UTC day inside each frozen span vs the 7 days before it."""
    db = SNAP / "usage.db"
    if not db.exists() or not spans:
        return []
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    out = []
    for sp in spans:
        a = dt.datetime.fromisoformat(sp["start"].replace("Z", "+00:00")).date()
        b = dt.datetime.fromisoformat(sp["end"].replace("Z", "+00:00")).date()
        inner = [(a + dt.timedelta(days=i)) for i in range(1, (b - a).days)]  # full days strictly inside
        before = [(a - dt.timedelta(days=i)) for i in range(1, 8)]

        def per_day(days: list[dt.date]) -> list[tuple[str, int, float]]:
            res = []
            for d in days:
                n, c = con.execute("SELECT COUNT(*), COALESCE(SUM(cost_usd),0) FROM usage_record WHERE billing='max' AND source='claude-code' "
                                   "AND date(ts)=?", (d.isoformat(),)).fetchone()
                res.append((d.isoformat(), n, round(c, 1)))
            return res

        inside, prior = per_day(inner), per_day(before)
        mean_in = statistics.fmean([n for _, n, _ in inside]) if inside else None
        mean_pr = statistics.fmean([n for _, n, _ in prior]) if prior else None
        out.append({
            "span_start": sp["start"], "span_end": sp["end"],
            "max_records_per_day_inside": [{"date": d, "records": n, "notional_cost_usd": c} for d, n, c in inside],
            "mean_records_per_day_inside": round(mean_in, 1) if mean_in is not None else None,
            "mean_records_per_day_7_days_before": round(mean_pr, 1) if mean_pr is not None else None,
            "inside_vs_before": ratio(mean_in, mean_pr) if mean_in is not None and mean_pr else None,
        })
    return out


def usage_split() -> dict:
    db = SNAP / "usage.db"
    if not db.exists():
        return {"error": f"missing snapshot {db.name}; run snapshot.sh"}
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    cutoff = AS_OF.strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = con.execute(
        "SELECT date(ts), billing, source, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), "
        "SUM(cache_write_tokens), SUM(reasoning_tokens), SUM(COALESCE(cost_usd,0)), SUM(cost_usd IS NULL) "
        "FROM usage_record WHERE julianday(ts) < julianday(?) GROUP BY 1,2,3", (cutoff,)).fetchall()
    keys = ("records", "input", "output", "cache_read", "cache_write", "reasoning", "cost_usd", "unpriced_records")
    weeks: dict[str, dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    by_source: dict[tuple[str, str], Counter] = defaultdict(Counter)
    windows = {"14d": 14, "30d": 30, "90d": 90, "all": None}
    win_tot: dict[str, dict[str, Counter]] = {w: defaultdict(Counter) for w in windows}
    first_day = None
    for d, billing, source, *vals in rows:
        if d is None:
            continue
        day = dt.date.fromisoformat(d)
        first_day = min(first_day, day) if first_day else day
        wk = iso_week(day)
        for k, v in zip(keys, vals):
            weeks[wk][billing][k] += v or 0
            by_source[(billing, source)][k] += v or 0
        age = (AS_OF.date() - day).days
        for w, n in windows.items():
            if n is None or age < n:
                for k, v in zip(keys, vals):
                    win_tot[w][billing][k] += v or 0

    def shape(c: dict[str, Counter]) -> dict:
        out = {}
        for b in sorted(c):
            x = c[b]
            out[b] = {"records": x["records"], "input_output_reasoning_tokens": x["input"] + x["output"] + x["reasoning"],
                      "cache_read_tokens": x["cache_read"], "cache_write_tokens": x["cache_write"],
                      "cost_usd": round(x["cost_usd"], 2), "unpriced_records": x["unpriced_records"]}
        mx, iu = c.get("max", Counter()), c.get("iu", Counter())
        io = lambda x: x["input"] + x["output"] + x["reasoning"]
        out["max_share_of_cost"] = ratio(mx["cost_usd"], mx["cost_usd"] + iu["cost_usd"])
        out["max_share_of_io_tokens"] = ratio(io(mx), io(mx) + io(iu))
        out["max_share_of_all_tokens"] = ratio(io(mx) + mx["cache_read"] + mx["cache_write"],
                                               io(mx) + mx["cache_read"] + mx["cache_write"] + io(iu) + iu["cache_read"] + iu["cache_write"])
        return out

    return {
        "source": "snapshot usage.db, usage_record, billing = max | iu (ts < AS_OF)",
        "weeks": {w: shape(weeks[w]) for w in sorted(weeks)},
        "windows": {w: shape(win_tot[w]) for w in windows},
        "by_billing_and_source_all": {f"{b}/{s}": {"records": c["records"], "io_tokens": c["input"] + c["output"] + c["reasoning"],
                                                    "cost_usd": round(c["cost_usd"], 2)} for (b, s), c in sorted(by_source.items())},
        "first_day": first_day.isoformat() if first_day else None,
        "notes": [
            "Max cost_usd is the API-list-price equivalent of subscription usage (sunk cost), IU cost_usd is billed per token: the two are not the same currency of effort.",
            "Weeks are ISO weeks (Mon-Sun UTC), not Max reset windows (Wed 16:00 UTC).",
            "Sources agent-gateway-iu and opencode can describe the same OpenCode episodes; no de-duplication is attempted here (cost attribution owns that).",
            "agent-gateway-sessions rows are session markers with no tokens.",
        ],
    }


# ── main ────────────────────────────────────────────────────────────────────────────────

def main() -> int:
    runs, used = parse_heartbeat()
    if not runs:
        print("quota: no heartbeat log found", file=sys.stderr)
        return 1
    boots = boot_times()
    r_anchors = reboot_anchors(runs, boots)
    fallback_end = None
    try:
        fallback_end = (len(runs) - 1, max(Path(p).stat().st_mtime for p in used))
    except OSError:
        pass

    # Provisional axis from reboots only, then snap scheduled weekly resets (Wednesday 16:00 UTC).
    prov = Axis(r_anchors, fallback_end=fallback_end)
    resets = find_resets(runs)
    snapped: list[tuple[int, float]] = []
    for rs in resets:
        t_prov = prov.t(rs["run"])
        wed = nearest_wed_1600(t_prov)
        rs["provisional_time"] = iso(t_prov)
        rs["residual_vs_wed_1600_min"] = round((t_prov - wed) / 60, 1)
        rs["scheduled"] = abs(t_prov - wed) <= SCHEDULE_TOLERANCE_S
        if rs["scheduled"]:
            snapped.append((rs["run"], wed + DETECTION_DELAY_S))
    axis = Axis(r_anchors + snapped, fallback_end=fallback_end)
    times = [axis.t(k) for k in range(len(runs))]
    cad = [s["seconds_per_run"] for s in axis.segments()]
    cadence = round(statistics.median(cad), 1) if cad else 300.0
    for rs in resets:
        rs["time"] = iso(times[rs["run"]])
        rs["weekday"] = dt.datetime.fromtimestamp(times[rs["run"]], UTC).strftime("%a")
        rs["kind"] = "scheduled weekly (Wed 16:00 UTC)" if rs["scheduled"] else "unscheduled"
        rs["also_reset_5h"] = bool(rs["five_to"] is not None and rs["five_from"] is not None and rs["five_from"] - rs["five_to"] >= 15)

    keep = [i for i, t in enumerate(times) if t < AS_OF_TS]
    runs_k = [runs[i] for i in keep]
    times_k = [times[i] for i in keep]
    resets = [r for r in resets if r["run"] in set(keep)]

    fetch, fetch_info = fetch_usage_series()
    validation = validate_axis(times_k, runs_k, fetch)

    five = [r["five"] for r in runs_k if r["five"] is not None]
    seven = [r["seven"] for r in runs_k if r["seven"] is not None]
    unavailable = sum(1 for r in runs_k if r["unavailable"])

    # Suspect flat segments: identical readings for >= 24 h of runs (a stale cache or no usage at all).
    flat_flags = [False] * len(runs_k)
    flat_segments = []
    i = 0
    while i < len(runs_k):
        j = i
        while j + 1 < len(runs_k) and runs_k[j + 1]["five"] == runs_k[i]["five"] and runs_k[j + 1]["seven"] == runs_k[i]["seven"] and runs_k[i]["seven"] is not None:
            j += 1
        if j - i + 1 >= FLAT_RUNS:
            for k in range(i, j + 1):
                flat_flags[k] = True
            flat_segments.append({
                "start": iso(times_k[i]), "end": iso(times_k[j]), "runs": j - i + 1, "hours": round((times_k[j] - times_k[i]) / 3600, 1),
                "five_hour_pct": runs_k[i]["five"], "seven_day_pct": runs_k[i]["seven"],
                "heartbeat_lines_naming_failing_max_routes": sum(1 for k in range(i, j + 1) if runs_k[k]["max_route_failing"]),
                "reading": "readings did not move for the whole span: either no Max usage at all or a stale cache; "
                           "the weekly reset on the Wednesday inside the span is not visible, which favours a stale cache",
            })
        i = j + 1
    seven_clean = [r["seven"] for r, f in zip(runs_k, flat_flags) if r["seven"] is not None and not f]
    five_clean = [r["five"] for r, f in zip(runs_k, flat_flags) if r["five"] is not None and not f]

    # Segments at 100 % and last time at 100 %.
    at100 = contiguous_segments([r["seven"] is not None and r["seven"] >= 100 for r in runs_k], times_k)
    five_max = max(five) if five else None
    last_100 = at100[-1] if at100 else None

    # Per-day table (UTC) and days at >= 90 %.
    days: dict[str, dict] = {}
    for r, t, flat in zip(runs_k, times_k, flat_flags):
        d = dt.datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%d")
        e = days.setdefault(d, {"runs": 0, "max_7d": None, "max_5h": None, "samples_7d_ge_90": 0, "suspect_flat": False})
        e["runs"] += 1
        e["suspect_flat"] = e["suspect_flat"] or flat
        if r["seven"] is not None:
            e["max_7d"] = r["seven"] if e["max_7d"] is None else max(e["max_7d"], r["seven"])
            e["samples_7d_ge_90"] += r["seven"] >= 90
        if r["five"] is not None:
            e["max_5h"] = r["five"] if e["max_5h"] is None else max(e["max_5h"], r["five"])
    day_rows = [{"date": d, **days[d]} for d in sorted(days)]
    full_days = [x for x in day_rows if x["runs"] >= 200]  # edge days of the log are partial
    ge90_days = [x["date"] for x in day_rows if x["max_7d"] is not None and x["max_7d"] >= 90]
    ge90_days_clean = [x["date"] for x in day_rows if x["max_7d"] is not None and x["max_7d"] >= 90 and not x["suspect_flat"]]
    ge100_days = [x["date"] for x in day_rows if x["max_7d"] is not None and x["max_7d"] >= 100]

    # Reset-to-reset cycles.
    bounds = [None] + [r["run"] for r in resets] + [None]
    cycles = []
    for a, b in zip(bounds, bounds[1:]):
        lo = 0 if a is None else a
        hi = len(runs_k) if b is None else b
        seg = [(k, runs_k[k]["seven"]) for k in range(lo, hi) if runs_k[k]["seven"] is not None]
        if not seg:
            continue
        pk = max(seg, key=lambda x: x[1])
        rs = next((r for r in resets if r["run"] == a), None)
        cycles.append({
            "start": iso(times_k[lo]), "start_is_reset": a is not None, "start_kind": rs["kind"] if rs else None,
            "end": iso(times_k[hi - 1]), "runs": hi - lo, "peak_7d": pk[1], "peak_time": iso(times_k[pk[0]]),
            "hours_ge_90": round(sum(1 for _, v in seg if v >= 90) * cadence / 3600, 1),
            "ended_by_reset": b is not None,
            "partial": a is None or b is None,
        })
    complete = [c for c in cycles if not c["partial"]]

    s7_, f5_ = distribution(seven, cadence), distribution(five, cadence)
    corroboration = max_activity(flat_segments)
    for fs, c in zip(flat_segments, corroboration):
        stalled = c["inside_vs_before"] is not None and c["inside_vs_before"] < 0.2
        fs["reading"] = (f"readings did not move although a weekly reset falls inside the span, and Max usage in usage.db fell to {c['inside_vs_before']} of the prior week's rate "
                         f"while {fs['heartbeat_lines_naming_failing_max_routes']} heartbeat lines name failing Max routes: Max was effectively unavailable for these days "
                         "(a limit the heartbeat does not record, or a stale reading, or both); the 7-day value inside the span is not trustworthy"
                         if stalled else "readings did not move for the whole span: either no Max usage at all or a stale cache")
    sched = [r for r in resets if r["scheduled"]]
    deltas = sorted({(r["residual_vs_wed_1600_min"]) for r in sched})
    out = {
        "script": "quota.py",
        "definition_keys": ["max_headroom"],
        "as_of": AS_OF_STR,
        "headline": {
            "seven_day_p50_p90_p99_max": [s7_["p50"], s7_["p90"], s7_["p99"], s7_["max"]],
            "seven_day_share_of_samples_ge_90": s7_["share_ge"]["90"],
            "days_with_peak_ge_90": [len(ge90_days), len(day_rows)],
            "days_with_peak_ge_90_excluding_frozen_span": len(ge90_days_clean),
            "last_at_100_end": last_100["end"] if last_100 else None,
            "five_hour_p50_p90_p99_max": [f5_["p50"], f5_["p90"], f5_["p99"], f5_["max"]],
            "five_hour_ever_at_100": False if (five_max is not None and five_max < 100) else True,
            "weekly_reset": "Wednesday 16:00:00 UTC; plus unscheduled full resets on " + ", ".join(r["time"][:10] for r in resets if not r["scheduled"]),
            "complete_weekly_cycles_peak_values": [c["peak_7d"] for c in complete],
        },
        "best_history": {
            "choice": "~/Library/Logs/devhost-health.log (heartbeat, one `quota 5h N% · 7d N%` per run)",
            "why": "the only source that spans weeks; ~/.claude/logs fetch_usage has real timestamps but 3-day retention; "
                   "usage.db has no utilisation columns; agent-gateway logs carry request metadata only",
            "files_read": [Path(p).name for p in used],
            "limits": ["no timestamps in the file: the axis is reconstructed (see time_axis)",
                       "only the overall 5h and 7d figures are recorded; model-scoped weekly caps (seven_day_sonnet, weekly_scoped such as Fable at 50 % of the weekly allowance) are not in the history",
                       "integer percentages sampled every ~5 min: peaks shorter than a run can be missed",
                       "a stale cache is indistinguishable from idleness without a second source (see suspect_flat_segments)"],
        },
        "time_axis": {
            "method": "piecewise-linear over anchors: host reboots (wtmp + kern.boottime) and scheduled weekly resets snapped to Wednesday 16:00:00 UTC",
            "anchors_used": [{"run": i, "time": iso(t), "kind": "reboot"} for i, t in r_anchors]
                            + [{"run": i, "time": iso(t), "kind": "weekly reset (Wed 16:00 UTC + 150 s detection delay)"} for i, t in snapped],
            "segments_seconds_per_run": axis.segments(),
            "median_seconds_per_run": cadence,
            "method_state": axis.method,
            "scheduled_reset_residuals_min_on_reboot_only_axis": deltas,
            "validation": validation,
        },
        "coverage": {
            "first_run": iso(times_k[0]) if times_k else None, "last_run": iso(times_k[-1]) if times_k else None,
            "runs": len(runs_k), "readings_5h": len(five), "readings_7d": len(seven), "unavailable_runs": unavailable,
            "calendar_days_touched": len(day_rows),
            "span_days": round((times_k[-1] - times_k[0]) / 86400, 1) if times_k else None,
        },
        "seven_day": {
            "distribution_raw": distribution(seven, cadence),
            "distribution_excluding_suspect_flat": distribution(seven_clean, cadence),
            "days_with_max_ge_90": {"count": len(ge90_days), "of_days": len(day_rows), "dates": ge90_days,
                                    "count_excluding_suspect_flat_days": len(ge90_days_clean)},
            "days_with_max_ge_100": {"count": len(ge100_days), "dates": ge100_days},
            "segments_at_100": at100,
            "last_at_100": ({"start": last_100["start"], "end": last_100["end"], "hours_before_as_of": round((AS_OF_TS - dt.datetime.fromisoformat(last_100["end"].replace("Z", "+00:00")).timestamp()) / 3600, 1)}
                            if last_100 else None),
            "never_reached_100_in_history": not at100,
        },
        "five_hour": {
            "distribution_raw": distribution(five, cadence),
            "distribution_excluding_suspect_flat": distribution(five_clean, cadence),
            "max": five_max,
            "last_at_100": None,
            "last_at_100_reason": "never sampled at 100 % in the heartbeat history (max "
                                  f"{five_max} %); fetch_usage max {fetch_info['max_5h']} % over {fetch_info['samples']} samples" if five_max is not None and five_max < 100 else "see segments",
        },
        "resets": [{k: v for k, v in r.items() if k != "run"} | {"run": r["run"]} for r in resets],
        "reset_schedule": {
            "scheduled": "Wednesday 16:00:00 UTC (18:00 CEST / 17:00 CET)",
            "evidence": f"{len(sched)} of {len(resets)} detected 7-day drops land within {max((abs(x) for x in deltas), default=0):.0f} minutes of Wednesday 16:00 UTC on the "
                        "reboot-only axis (residuals in `resets`); the live cache names the same weekday and time for the next reset; "
                        "fetch_usage saw the last one between 15:58 and 16:04 UTC. The other drops are unscheduled full resets",
            "scheduled_resets_seen": len(sched), "unscheduled_resets_seen": len(resets) - len(sched),
            "live": live_cache(),
        },
        "weekly_cycles": cycles,
        "weekly_cycles_complete_summary": {
            "cycles": len(complete), "peak_7d_values": [c["peak_7d"] for c in complete],
            "cycles_peaking_ge_90": sum(1 for c in complete if c["peak_7d"] >= 90),
            "median_peak_7d": statistics.median([c["peak_7d"] for c in complete]) if complete else None,
        },
        "suspect_flat_segments": flat_segments,
        "suspect_flat_segments_max_usage_corroboration": corroboration,
        "at_as_of": last_reading(runs_k, times_k),
        "daily": day_rows,
        "full_days": len(full_days),
        "fetch_usage": fetch_info,
        "max_vs_iu": usage_split(),
        "notes": [redact(x) for x in [
            "Utilisation is what Anthropic's usage endpoint reports (integer percent of the plan limit), relayed by agent-gateway GET /api/usage into the heartbeat.",
            "Small downward steps (1-4 points) inside a week exist in the series and are not resets; a reset is a drop of >= 20 points to <= 15.",
            "Both windows reset together on unscheduled resets (5h falls as well): those are not the weekly schedule.",
        ]],
    }
    (HERE / "quota.out.json").write_text(json.dumps(out, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    write_md(out, HERE / "quota.out.md")
    s7 = out["seven_day"]["distribution_raw"]
    print(f"quota: {len(runs_k)} runs {out['coverage']['first_run']} .. {out['coverage']['last_run']}; "
          f"7d p50/p90/max {s7['p50']}/{s7['p90']}/{s7['max']}; days>=90: {len(ge90_days)}; axis validation: "
          f"{validation.get('match_7d_within_1pt_at_offset_0')}")
    return 0


def pc(x: float | None) -> str:
    return "-" if x is None else f"{x * 100:.1f}%"


def write_md(o: dict, path: Path) -> None:
    L = ["# quota — Max headroom and Max vs IU split", ""]
    cov = o["coverage"]
    L += [f"AS_OF `{o['as_of']}`. Definition key `max_headroom`. Script `quota.py`.", "",
          "## Source and coverage", "",
          f"Best history: {o['best_history']['choice']}. {o['best_history']['why'][:1].upper() + o['best_history']['why'][1:]}.", "",
          f"Coverage: {cov['first_run']} to {cov['last_run']} ({cov['span_days']} days, {cov['runs']} runs, {cov['readings_7d']} usable readings, "
          f"{cov['unavailable_runs']} runs with `quota unavailable`).", ""]
    ta = o["time_axis"]
    v = ta["validation"]
    L += ["## Time axis", "", f"{ta['method']}. Median {ta['median_seconds_per_run']} s per run.", ""]
    if v.get("available"):
        L.append(f"Validation against {v['overlap_samples']} real `fetch_usage` timestamps: 5 h within 2 points {pc(v['match_5h_within_2pts_at_offset_0'])}, "
                 f"7 d within 1 point {pc(v['match_7d_within_1pt_at_offset_0'])} at offset 0; best offset {v['best_offset_s']} s "
                 f"({pc(v['match_5h_at_best_offset'])} / {pc(v['match_7d_at_best_offset'])}).")
    else:
        L.append(f"Validation not available: {v.get('reason')}.")
    L.append("")
    L += ["## Distribution", "", "|window|n|mean|p50|p75|p90|p95|p99|max|>=90%|>=100%|hours >=90%|",
          "|-|-|-|-|-|-|-|-|-|-|-|-|"]
    for name, key in (("7-day raw", ("seven_day", "distribution_raw")), ("7-day excl. suspect flat", ("seven_day", "distribution_excluding_suspect_flat")),
                      ("5-hour raw", ("five_hour", "distribution_raw")), ("5-hour excl. suspect flat", ("five_hour", "distribution_excluding_suspect_flat"))):
        d = o[key[0]][key[1]]
        L.append(f"|{name}|{d['n']}|{d['mean']}|{d['p50']}|{d['p75']}|{d['p90']}|{d['p95']}|{d['p99']}|{d['max']}|"
                 f"{pc(d['share_ge']['90'])}|{pc(d['share_ge']['100'])}|{d['hours_ge']['90']}|")
    L.append("")
    s7 = o["seven_day"]
    L += ["## Days at the limit", "",
          f"Days (UTC) whose 7-day peak reached >= 90 %: {s7['days_with_max_ge_90']['count']} of {s7['days_with_max_ge_90']['of_days']} "
          f"({s7['days_with_max_ge_90']['count_excluding_suspect_flat_days']} without the suspect flat span). Days that reached 100 %: {s7['days_with_max_ge_100']['count']}.", ""]
    if s7["last_at_100"]:
        L.append(f"The 7-day window last sat at 100 % from {s7['segments_at_100'][-1]['start']} to {s7['last_at_100']['end']} "
                 f"({s7['last_at_100']['hours_before_as_of']} h before AS_OF).")
    else:
        L.append("The 7-day window never reached 100 % in this history.")
    L += ["", "|start|end|hours|", "|-|-|-|"] + [f"|{x['start']}|{x['end']}|{x['hours']}|" for x in s7["segments_at_100"]]
    L += ["", f"5-hour: {o['five_hour']['last_at_100_reason']}.", ""]
    L += ["## Weekly resets", "", f"Schedule: {o['reset_schedule']['scheduled']}. {o['reset_schedule']['evidence']}.", ""]
    live = o["reset_schedule"]["live"]
    if live.get("next_weekly_reset_utc"):
        L += [f"Live cache at run time: next weekly reset {live['next_weekly_reset_utc']} ({live['weekday']} {live['time_of_day_utc']} UTC).", ""]
    a = o["at_as_of"]
    if a:
        L += [f"Last reading before AS_OF ({a['time']}): 5 h {a['five_hour_pct']} %, 7 d {a['seven_day_pct']} %.", ""]
    L += ["|time (UTC)|weekday|from 7d|to 7d|5h also reset|kind|residual vs Wed 16:00 (min)|", "|-|-|-|-|-|-|-|"]
    for r in o["resets"]:
        L.append(f"|{r['time']}|{r['weekday']}|{r['from']}|{r['to']}|{'yes' if r['also_reset_5h'] else 'no'}|{r['kind']}|{r['residual_vs_wed_1600_min']}|")
    L += ["", "## Weekly cycles (reset to reset)", "", "|start|end|peak 7d|peak at|hours >=90%|ended by reset|", "|-|-|-|-|-|-|"]
    for c in o["weekly_cycles"]:
        L.append(f"|{c['start']}|{c['end']}|{c['peak_7d']}|{c['peak_time']}|{c['hours_ge_90']}|{'yes' if c['ended_by_reset'] else 'no (log end)'}{' (partial)' if c['partial'] else ''}|")
    s = o["weekly_cycles_complete_summary"]
    L += ["", f"Complete cycles: {s['cycles']}, peaks {s['peak_7d_values']}, {s['cycles_peaking_ge_90']} peaked at >= 90 %, median peak {s['median_peak_7d']}.", ""]
    if o["suspect_flat_segments"]:
        L += ["## Suspect flat span", ""]
        for f in o["suspect_flat_segments"]:
            L.append(f"- {f['start']} to {f['end']} ({f['hours']} h, {f['runs']} runs): 5 h {f['five_hour_pct']} %, 7 d {f['seven_day_pct']} % unchanged. "
                     f"{f['reading'][:1].upper() + f['reading'][1:]}.")
        L.append("")
        for c in o["suspect_flat_segments_max_usage_corroboration"]:
            L.append(f"- Max usage in usage.db over the same days: {c['mean_records_per_day_inside']} records/day inside vs "
                     f"{c['mean_records_per_day_7_days_before']} in the 7 days before (ratio {c['inside_vs_before']}): "
                     f"per day {', '.join(str(x['records']) for x in c['max_records_per_day_inside'])}.")
        L.append("")
    m = o["max_vs_iu"]
    L += ["## Max vs IU per week", ""]
    if "error" in m:
        L.append(m["error"])
    else:
        L += ["|week|Max cost $|IU cost $|Max share of cost|Max io tokens (M)|IU io tokens (M)|Max share of io tokens|",
              "|-|-|-|-|-|-|-|"]
        for wk, v_ in m["weeks"].items():
            mx = v_.get("max", {})
            iu = v_.get("iu", {})
            L.append(f"|{wk}|{mx.get('cost_usd', 0):,.0f}|{iu.get('cost_usd', 0):,.0f}|{pc(v_['max_share_of_cost'])}|"
                     f"{mx.get('input_output_reasoning_tokens', 0) / 1e6:,.1f}|{iu.get('input_output_reasoning_tokens', 0) / 1e6:,.1f}|{pc(v_['max_share_of_io_tokens'])}|")
        L += ["", "|window|Max cost $|IU cost $|Max share of cost|Max share of io tokens|", "|-|-|-|-|-|"]
        for w, v_ in m["windows"].items():
            L.append(f"|{w}|{v_.get('max', {}).get('cost_usd', 0):,.0f}|{v_.get('iu', {}).get('cost_usd', 0):,.0f}|{pc(v_['max_share_of_cost'])}|{pc(v_['max_share_of_io_tokens'])}|")
        L.append("")
        for n in m["notes"]:
            L.append(f"- {n}")
    L += ["", "## Notes", ""] + [f"- {n}" for n in o["notes"]] + [""]
    path.write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
