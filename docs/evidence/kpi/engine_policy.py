#!/usr/bin/env python3
"""Round 5's open engine question, in numbers.

Question: what would moving agent-gateway's OpenCode workload (investigate, implement, review
angles; today on IU models) onto Claude Code on the Max subscription cost in weekly-quota terms?

Method:
1. Weekly Max window in list dollars: for each complete weekly cycle in quota.out.json, the Max
   list cost (usage.db snapshot, billing='max') divided by the cycle's 7-day peak → $ per 1 %.
2. agw OpenCode token mix from usage-tracker source `agent-gateway-opencode` (collected since the
   2026-10-22 Phase 0 fix; rows are immutable, read live and filtered to [2026-10-14, AS_OF)).
3. Price that mix at the Sonnet rates in usage-tracker's registry (`src/pricing.ts`, entry
   `claude-sonnet-5`, corrected 2026-09-24 from the vendor page): per 1M tokens input 2, output 10,
   cache read 0.2, cache write 2.5. Sonnet is `rd wave`'s default engine.
4. Weekly cost → % of the weekly window, against the observed 7-day p50/p90.
Inputs: quota.out.json; ~/.local/share/factory/snapshots/2026-10-22/usage.db; live
~/.local/share/usage-tracker/usage.db (read-only). Run: python3 -I engine_policy.py
"""
import json
import os
import sqlite3
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
AS_OF = os.environ.get("AS_OF", "2026-10-22T08:00:00Z")
RATES = {"input": 2.0, "output": 10.0, "cache_read": 0.2, "cache_write": 2.5}  # $/1M, pricing.ts claude-sonnet-5
WINDOW_START = "2026-10-14T00:00:00Z"


def ro(path):
    return sqlite3.connect("file:" + os.path.expanduser(path) + "?mode=ro", uri=True)


quota = json.load(open(os.path.join(HERE, "quota.out.json")))
snap = ro("~/.local/share/factory/snapshots/2026-10-22/usage.db")
per_pct = []
for c in quota["weekly_cycles"]:
    if c.get("partial") or not c.get("peak_7d"):
        continue
    (usd,) = snap.execute("select coalesce(sum(cost_usd),0) from usage_record where billing='max' and ts>=? and ts<?",
                          (c["start"], c["end"])).fetchone()
    per_pct.append(round(usd / c["peak_7d"], 2))
usd_per_pct = statistics.median(per_pct)

live = ro("~/.local/share/usage-tracker/usage.db")
row = live.execute("""select count(*), sum(input_tokens), sum(output_tokens), sum(cache_read_tokens),
                      sum(coalesce(cache_write_tokens,0)+coalesce(cache_write_1h_tokens,0)), sum(cost_usd), min(ts), max(ts)
                      from usage_record where source='agent-gateway-opencode' and ts>=? and ts<?""", (WINDOW_START, AS_OF)).fetchone()
n, tin, tout, tcr, tcw, iu_usd, t0, t1 = row
from datetime import datetime
days = (datetime.fromisoformat(t1.replace("Z", "+00:00")) - datetime.fromisoformat(t0.replace("Z", "+00:00"))).total_seconds() / 86400
sonnet_usd = (tin * RATES["input"] + tout * RATES["output"] + tcr * RATES["cache_read"] + tcw * RATES["cache_write"]) / 1e6
weekly_sonnet = sonnet_usd / days * 7
pct = weekly_sonnet / usd_per_pct
p50, p90 = quota["headline"]["seven_day_p50_p90_p99_max"][0:2]
out = {
    "as_of": AS_OF, "window": [t0, t1], "days": round(days, 2), "rows": n,
    "tokens": {"input": tin, "output": tout, "cache_read": tcr, "cache_write": tcw},
    "iu_cost_usd": round(iu_usd, 2), "iu_cost_per_week_usd": round(iu_usd / days * 7, 2),
    "sonnet_list_usd": round(sonnet_usd, 2), "sonnet_list_per_week_usd": round(weekly_sonnet, 2),
    "max_list_usd_per_1pct_week": {"median": usd_per_pct, "cycles": per_pct},
    "weekly_window_pct_if_on_max": round(pct, 1),
    "observed_7d_p50_p90": [p50, p90],
    "p50_after_move": round(p50 + pct, 1), "p90_after_move": round(p90 + pct, 1),
}
json.dump(out, open(os.path.join(HERE, "engine_policy.out.json"), "w"), indent=1)
open(os.path.join(HERE, "engine_policy.out.md"), "w").write(
    "# Engine policy in numbers\n\n"
    f"agw OpenCode workload {t0[:10]} → {t1[:10]} ({days:.1f} d, {n} rows): IU cost ${iu_usd:.2f} (${out['iu_cost_per_week_usd']}/week).\n"
    f"Same tokens at Sonnet list rates: ${sonnet_usd:.0f} (${weekly_sonnet:.0f}/week).\n"
    f"Max weekly window: ${usd_per_pct} list per 1 % (median of {len(per_pct)} complete cycles).\n"
    f"Moving it onto Max adds ≈ {pct:.1f} % of the weekly window: p50 {p50} → {out['p50_after_move']}, p90 {p90} → {out['p90_after_move']}.\n")
print(json.dumps({k: out[k] for k in ("iu_cost_per_week_usd", "sonnet_list_per_week_usd", "max_list_usd_per_1pct_week", "weekly_window_pct_if_on_max", "p50_after_move", "p90_after_move")}))
