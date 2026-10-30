#!/usr/bin/env python3
"""Does the decision model earn a place in the loop?

Question: warden ran a single-shot decision model (`decision_shadow`, kind `triage`) beside its LLM
triage on 173 events. How often does its action (attach / new / fixed_by / ignore) agree with
(a) the LLM triage, (b) what actually happened to the event in the ledger, (c) the golden-set
labels where the event was labelled — overall and by confidence band?
Outcome mapping (ledger): duplicate_of set or close_reason 'duplicate' → attach; close_reason
'ignored' → ignore; close_reason 'fixed_by' → fixed_by; otherwise an item of its own → new.
Gold mapping: the event shares an incident group with an earlier event of its chunk → attach, else
new (gold has no ignore/fixed_by class, so only attach/new rows are scored against gold).
Inputs: snapshot warden.db (read-only), ../golden/labels/*.jsonl, ../golden/packets.jsonl.
Run: python3 -I decision_shadow.py → decision_shadow.out.json, .out.md
"""
import collections
import glob
import json
import os
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
db = sqlite3.connect("file:" + os.path.expanduser("~/.local/share/factory/snapshots/2026-10-22/warden.db") + "?mode=ro", uri=True)
rows = db.execute("""select d.event_id, d.llm_json, d.decision_json, t.duplicate_of, t.close_reason
                     from decision_shadow d left join triage_items t on t.event_id = d.event_id
                     where d.kind = 'triage' and d.decision_json is not null""").fetchall()

gold = {}
first_seen = {}
for line in open(os.path.join(HERE, "..", "golden", "packets.jsonl")):
    p = json.loads(line)
    first_seen[p["id"]] = p.get("first_seen") or ""
for f in glob.glob(os.path.join(HERE, "..", "golden", "labels", "*.jsonl")):
    labels = [json.loads(l) for l in open(f) if l.strip()]
    by_group = collections.defaultdict(list)
    for r in labels:
        by_group[r["incident_group"]].append(r["id"])
    for g, ids in by_group.items():
        ids.sort(key=lambda i: (first_seen.get(i, ""), i))
        for k, i in enumerate(ids):
            gold[i] = "new" if k == 0 else "attach"


def outcome(dup, close):
    if dup or close == "duplicate":
        return "attach"
    if close == "ignored":
        return "ignore"
    if close == "fixed_by":
        return "fixed_by"
    return "new"


def band(c):
    return ">=0.95" if c >= 0.95 else ("0.80-0.95" if c >= 0.80 else "<0.80")


stats = collections.defaultdict(lambda: collections.Counter())
conf_mix = collections.Counter()
for eid, llm, dec, dup, close in rows:
    d = json.loads(dec)
    a = d.get("action", {})
    choice, conf = a.get("choice"), float(a.get("confidence") or 0)
    b = band(conf)
    conf_mix[(b, choice)] += 1
    llm_action = (json.loads(llm) or {}).get("action") if llm else None
    out = outcome(dup, close)
    if gold.get(eid) is not None and llm_action is not None:
        stats[("llm_triage_vs_gold", "all")]["n"] += 1
        stats[("llm_triage_vs_gold", "all")]["agree"] += int(llm_action == gold[eid])
    for key, ref in (("vs_llm_triage", llm_action), ("vs_ledger_outcome", out), ("vs_gold", gold.get(eid))):
        if ref is None:
            continue
        for scope in ("all", b):
            stats[(key, scope)]["n"] += 1
            stats[(key, scope)]["agree"] += int(choice == ref)

result = {}
for (key, scope), c in sorted(stats.items()):
    result.setdefault(key, {})[scope] = {"n": c["n"], "agree": c["agree"], "rate": round(c["agree"] / c["n"], 3) if c["n"] else None}
out = {"rows": len(rows), "agreement": result,
       "choice_by_confidence_band": {f"{b}|{ch}": n for (b, ch), n in sorted(conf_mix.items())}}
json.dump(out, open(os.path.join(HERE, "decision_shadow.out.json"), "w"), indent=1)
md = ["# Decision model (decision_shadow) — agreement", "", f"{len(rows)} triage rows with a decision.", "", "| Reference | Band | n | Agree | Rate |", "|-|-|-|-|-|"]
for key, scopes in result.items():
    for scope, v in scopes.items():
        md.append(f"| {key} | {scope} | {v['n']} | {v['agree']} | {v['rate']} |")
open(os.path.join(HERE, "decision_shadow.out.md"), "w").write("\n".join(md) + "\n")
print("\n".join(md))
print(json.dumps(out["choice_by_confidence_band"]))
