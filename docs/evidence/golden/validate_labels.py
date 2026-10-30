#!/usr/bin/env python3
"""Golden set, step 3: validate a labeller's output against its chunk.

Question: is labels/NN.jsonl a complete, well-formed answer for chunks/NN.jsonl, so that the
merge and the backtest can read it without guessing? Schema and rules: LABELS.md section 6.

Checks (errors, exit 1): the file name gives the chunk NN; every packet id of chunks/NN.jsonl
appears exactly once and nothing else does; the key set is exactly the schema; value domains;
`incident_group` is cNN-gMM with the file's own NN; one `group_summary` per group;
`root_cause` <= 15 words; `known_fix_ref` iff `known_fix` is y; `why_uncertain` iff `uncertain`;
`na` is not allowed on an escalated event; every free-text field survives lib/redact.py.
Warnings (exit 0): a `y` on a non-escalated event, a known_fix y with no prior-fix evidence in
the packet, a very large group, a high uncertain share.

Inputs: chunks/NN.jsonl (read-only) and the label files named on the command line.
Run:  cd docs/evidence/golden && python3 -I validate_labels.py labels/03.jsonl [labels/04.jsonl ...]
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE.parent / "lib"))
from redact import redact  # noqa: E402

REQUIRED = {"id", "incident_group", "group_summary", "root_cause", "genuine_owner_decision", "known_fix",
            "known_fix_ref", "uncertain", "why_uncertain"}
OPTIONAL = {"evidence"}
GROUP_RE = re.compile(r"^c(\d{2})-g(\d{2,3})$")
REF_RE = re.compile(r"^(item:\d+|[A-Za-z0-9._-]+@[0-9a-f]{7,40})(;\s*(item:\d+|[A-Za-z0-9._-]+@[0-9a-f]{7,40}))*$")
LIMITS = {"group_summary": 140, "root_cause_words": 15, "why_uncertain": 120, "evidence": 160}


def check_file(path: Path) -> tuple[list[str], list[str], Counter]:
    errors: list[str] = []
    warns: list[str] = []
    stats: Counter = Counter()
    m = re.fullmatch(r"(\d{2})\.jsonl", path.name)
    if not m:
        return [f"{path}: file name must be NN.jsonl"], warns, stats
    nn = m.group(1)
    chunk_file = HERE / "chunks" / f"{nn}.jsonl"
    if not chunk_file.exists():
        return [f"{path}: no chunks/{nn}.jsonl"], warns, stats
    packets = {}
    for line in chunk_file.read_text(encoding="utf-8").splitlines():
        if line.strip():
            p = json.loads(line)
            packets[p["id"]] = p

    seen: Counter = Counter()
    summaries: dict[str, set[str]] = defaultdict(set)
    group_size: Counter = Counter()
    rows = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        where = f"{path.name}:{n}"
        if redact(line) != line:
            errors.append(f"{where}: free text matches a redaction pattern (host, address, token, path); rewrite it")
        try:
            r = json.loads(line)
        except ValueError as e:
            errors.append(f"{where}: not JSON ({e})")
            continue
        keys = set(r)
        if keys - REQUIRED - OPTIONAL or REQUIRED - keys:
            errors.append(f"{where}: keys must be {sorted(REQUIRED)} (+ optional {sorted(OPTIONAL)}); "
                          f"missing {sorted(REQUIRED - keys)}, unexpected {sorted(keys - REQUIRED - OPTIONAL)}")
            continue
        rid = r["id"]
        if not isinstance(rid, int) or rid not in packets:
            errors.append(f"{where}: id {rid!r} is not in chunks/{nn}.jsonl")
            continue
        seen[rid] += 1
        p = packets[rid]
        g = GROUP_RE.match(r["incident_group"]) if isinstance(r["incident_group"], str) else None
        if not g or g.group(1) != nn:
            errors.append(f"{where}: incident_group must look like c{nn}-g01")
        gs = r["group_summary"]
        if not isinstance(gs, str) or not gs.strip() or len(gs) > LIMITS["group_summary"]:
            errors.append(f"{where}: group_summary must be 1-{LIMITS['group_summary']} characters")
        else:
            summaries[r["incident_group"]].add(gs)
        group_size[r["incident_group"]] += 1
        rc = r["root_cause"]
        if not isinstance(rc, str) or not rc.strip() or len(rc.split()) > LIMITS["root_cause_words"]:
            errors.append(f"{where}: root_cause must be 1-{LIMITS['root_cause_words']} words")
        gd, kf = r["genuine_owner_decision"], r["known_fix"]
        if gd not in ("y", "n", "na"):
            errors.append(f"{where}: genuine_owner_decision must be y, n or na")
        if kf not in ("y", "n"):
            errors.append(f"{where}: known_fix must be y or n")
        ref = r["known_fix_ref"]
        if kf == "y" and not (isinstance(ref, str) and REF_RE.match(ref)):
            errors.append(f"{where}: known_fix y needs known_fix_ref like item:1234 or repo@abcdef1")
        if kf == "n" and ref is not None:
            errors.append(f"{where}: known_fix_ref must be null unless known_fix is y")
        if not isinstance(r["uncertain"], bool):
            errors.append(f"{where}: uncertain must be true or false")
        elif r["uncertain"] and not (isinstance(r["why_uncertain"], str) and r["why_uncertain"].strip()
                                     and len(r["why_uncertain"]) <= LIMITS["why_uncertain"]):
            errors.append(f"{where}: uncertain true needs why_uncertain (1-{LIMITS['why_uncertain']} characters)")
        elif r["uncertain"] is False and r["why_uncertain"] is not None:
            errors.append(f"{where}: why_uncertain must be null unless uncertain is true")
        if "evidence" in r and (not isinstance(r["evidence"], str) or len(r["evidence"]) > LIMITS["evidence"]):
            errors.append(f"{where}: evidence must be a string of at most {LIMITS['evidence']} characters")
        if gd == "na" and p["pre_escalated"]:
            errors.append(f"{where}: an escalated event cannot be na; label it y or n")
        if gd == "y" and not p["pre_escalated"]:
            warns.append(f"{where}: genuine y on a non-escalated event (a missed escalation); evidence should say why")
        if kf == "y" and not (p["pre_prior_same_signature"]["any_prior_fixed_by_change"]
                              or any(f.get("rel") == "before_episode" for f in p["fix_commits"])):
            warns.append(f"{where}: known_fix y with no prior-fix evidence in the packet; confirm it predates first_seen")
        rows.append(r)
        stats["lines"] += 1
        stats[f"genuine_{gd}"] += 1
        stats[f"known_fix_{kf}"] += 1
        stats["uncertain"] += bool(r["uncertain"])

    for rid in sorted(set(packets) - set(seen)):
        errors.append(f"{path.name}: packet {rid} has no label")
    for rid, c in seen.items():
        if c > 1:
            errors.append(f"{path.name}: packet {rid} labelled {c} times")
    for grp, texts in summaries.items():
        if len(texts) > 1:
            errors.append(f"{path.name}: {grp} has {len(texts)} different group_summary texts; use one")
    for grp, n in group_size.items():
        if n > 25:
            warns.append(f"{path.name}: {grp} has {n} events; check it is one incident")
    if rows and stats["uncertain"] / len(rows) > 0.35:
        warns.append(f"{path.name}: {stats['uncertain']} of {len(rows)} labels are uncertain; the backtest scores them both ways")
    stats["groups"] = len(group_size)
    return errors, warns, stats


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    failed = 0
    for arg in sys.argv[1:]:
        errors, warns, stats = check_file(Path(arg))
        for e in errors:
            print("ERROR", e)
        for w in warns:
            print("warn ", w)
        print(f"{arg}: {'FAIL' if errors else 'ok'} - {stats['lines']} labels, {stats['groups']} groups, "
              f"genuine y/n/na {stats['genuine_y']}/{stats['genuine_n']}/{stats['genuine_na']}, "
              f"known_fix y {stats['known_fix_y']}, uncertain {stats['uncertain']}")
        failed += bool(errors)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
