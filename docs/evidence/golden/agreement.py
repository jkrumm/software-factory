#!/usr/bin/env python3
"""Golden set: label totals and inter-labeller agreement.

Question: how much do the labels say, and how reliable are they? Totals over labels/NN.jsonl;
agreement between labels/ and the independent second labelling labels_b/ on the chunks both cover:
B-cubed precision/recall/F1 of one grouping against the other (symmetric: F1), and Cohen's kappa on
genuine_owner_decision and known_fix. Run: python3 -I agreement.py → agreement.out.json, .out.md
"""
import collections
import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def load(d):
    out = {}
    for f in sorted(glob.glob(os.path.join(HERE, d, "*.jsonl"))):
        nn = os.path.basename(f)[:2]
        out[nn] = {r["id"]: r for r in (json.loads(l) for l in open(f) if l.strip())}
    return out


A, B = load("labels"), load("labels_b")
allA = [r for c in A.values() for r in c.values()]
tot = {
    "labels": len(allA), "chunks": len(A),
    "groups": len({r["incident_group"] for r in allA}),
    "genuine": dict(collections.Counter(r["genuine_owner_decision"] for r in allA)),
    "known_fix_y": sum(r["known_fix"] == "y" for r in allA),
    "uncertain": sum(bool(r["uncertain"]) for r in allA),
}


def bcubed(gold, pred):
    """Per-element B-cubed of pred against gold (dict id -> group)."""
    ids = list(gold)
    gm, pm = collections.defaultdict(set), collections.defaultdict(set)
    for i in ids:
        gm[gold[i]].add(i)
        pm[pred[i]].add(i)
    p = sum(len(gm[gold[i]] & pm[pred[i]]) / len(pm[pred[i]]) for i in ids) / len(ids)
    r = sum(len(gm[gold[i]] & pm[pred[i]]) / len(gm[gold[i]]) for i in ids) / len(ids)
    return p, r, (2 * p * r / (p + r) if p + r else 0.0)


def kappa(a, b):
    n = len(a)
    cats = set(a) | set(b)
    po = sum(x == y for x, y in zip(a, b)) / n
    pe = sum((a.count(c) / n) * (b.count(c) / n) for c in cats)
    return (po - pe) / (1 - pe) if pe < 1 else 1.0, po


agree = {}
for nn in sorted(set(A) & set(B)):
    ids = sorted(set(A[nn]) & set(B[nn]))
    ga = {i: A[nn][i]["incident_group"] for i in ids}
    gb = {i: B[nn][i]["incident_group"] for i in ids}
    p, r, f = bcubed(ga, gb)
    kg, pog = kappa([A[nn][i]["genuine_owner_decision"] for i in ids], [B[nn][i]["genuine_owner_decision"] for i in ids])
    kk, pok = kappa([A[nn][i]["known_fix"] for i in ids], [B[nn][i]["known_fix"] for i in ids])
    agree[nn] = {"n": len(ids), "bcubed_p": round(p, 3), "bcubed_r": round(r, 3), "bcubed_f1": round(f, 3),
                 "genuine_kappa": round(kg, 3), "genuine_raw_agreement": round(pog, 3),
                 "known_fix_kappa": round(kk, 3), "known_fix_raw_agreement": round(pok, 3),
                 "groups_a": len(set(ga.values())), "groups_b": len(set(gb.values()))}
out = {"totals": tot, "agreement": agree}
json.dump(out, open(os.path.join(HERE, "agreement.out.json"), "w"), indent=1)
md = ["# Golden set — totals and agreement", "", f"Labels {tot['labels']} in {tot['chunks']} chunks, {tot['groups']} incident groups; genuine y/n/na {tot['genuine']}; known_fix y {tot['known_fix_y']}; uncertain {tot['uncertain']}.", "",
      "| Chunk | n | B³ P | B³ R | B³ F1 | groups A/B | genuine κ (raw) | known_fix κ (raw) |", "|-|-|-|-|-|-|-|-|"]
for nn, a in agree.items():
    md.append(f"| {nn} | {a['n']} | {a['bcubed_p']} | {a['bcubed_r']} | {a['bcubed_f1']} | {a['groups_a']}/{a['groups_b']} | {a['genuine_kappa']} ({a['genuine_raw_agreement']}) | {a['known_fix_kappa']} ({a['known_fix_raw_agreement']}) |")
open(os.path.join(HERE, "agreement.out.md"), "w").write("\n".join(md) + "\n")
print("\n".join(md))
