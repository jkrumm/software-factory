#!/usr/bin/env python3
"""Owner pages per week and the genuine share of escalations — the two SLO baselines proof.md needs.

owner_pages (DEFINITIONS.md): needs_decision entries + legacy notified_at posts + reminders, counted in
the 28 days before AS_OF (reminders attributed to events whose last reminder falls in the window —
a lower bound, the ledger keeps only the last reminder time). genuine_escalation_share: golden-set
packets with pre_escalated true whose label genuine_owner_decision = y, per escalated item.
Inputs: snapshot warden.db (read-only), ../golden/packets.jsonl, ../golden/labels/*.jsonl.
Run: python3 -I owner_pages.py → owner_pages.out.json
"""
import glob, json, os, sqlite3
HERE = os.path.dirname(os.path.abspath(__file__))
AS_OF = os.environ.get("AS_OF", "2026-10-22T08:00:00Z")
db = sqlite3.connect("file:" + os.path.expanduser("~/.local/share/factory/snapshots/2026-10-22/warden.db") + "?mode=ro", uri=True)
start = "2026-09-24T08:00:00Z"  # AS_OF − 28 d
nd = db.execute("select count(*) from item_transitions where to_state='needs_decision' and at>=? and at<?", (start, AS_OF)).fetchone()[0]
posts = db.execute("select count(*) from events where notified_at>=? and notified_at<?", (start, AS_OF)).fetchone()[0]
rem = db.execute("select coalesce(sum(reminder_count),0) from events where last_reminder_at>=? and last_reminder_at<?", (start, AS_OF)).fetchone()[0]
total = nd + posts + rem
esc_items, genuine_items = set(), set()
pk = {}
for line in open(os.path.join(HERE, "..", "golden", "packets.jsonl")):
    p = json.loads(line); pk[p["id"]] = p
for f in glob.glob(os.path.join(HERE, "..", "golden", "labels", "*.jsonl")):
    for l in open(f):
        if not l.strip(): continue
        r = json.loads(l); p = pk.get(r["id"], {})
        if p.get("pre_escalated"):
            item = (p.get("item") or {}).get("event_id") or r["id"]
            esc_items.add(item)
            if r["genuine_owner_decision"] == "y": genuine_items.add(item)
out = {"as_of": AS_OF, "window_days": 28, "needs_decision_entries": nd, "legacy_posts": posts, "reminders_lower_bound": rem,
       "owner_pages_28d": total, "owner_pages_per_week": round(total / 4, 1),
       "golden_escalated_items": len(esc_items), "golden_genuine_items": len(genuine_items),
       "genuine_escalation_share": round(len(genuine_items) / len(esc_items), 3) if esc_items else None}
json.dump(out, open(os.path.join(HERE, "owner_pages.out.json"), "w"), indent=1)
print(json.dumps(out))
