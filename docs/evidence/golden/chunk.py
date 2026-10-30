#!/usr/bin/env python3
"""Golden set, step 2: split the label packets into time-ordered chunks for parallel labellers.

Question: how do ~950 packets become ~50-packet work units without cutting a co-firing
neighbourhood in two? A neighbourhood is a +-30 min window, so the unit that must stay
together is a BURST: a maximal run of packets whose consecutive first_seen gaps are all
<= 30 min. Bursts are packed in time order by dynamic programming: chunk sizes as close to
TARGET as the bursts allow (sum of squared deviations), never above SOFT_MAX unless a single
burst is bigger (then it is a chunk of its own, up to HARD_MAX). A burst larger than
HARD_MAX is cut at its largest internal gaps and flagged `split_burst`.

Chunks are numbered from 01. PREREGISTRATION.md fixes the backtest split by parity of the
chunk number: even = development, odd = held-out; index.json records it per chunk.

Input:  packets.jsonl (sample.py output, read-only).
Output: chunks/NN.jsonl (the packets of one chunk, `chunk` field filled in) and
        chunks/index.json (chunk -> time range, event/sampled/context/escalated counts, split).
Definition keys (DEFINITIONS.md): `escalated` (counted from the packets' pre_escalated).
Deterministic. Free text was redacted by sample.py; the gate is re-run over what is written here.

Run:  cd docs/evidence/golden && python3 -I sample.py && python3 -I chunk.py
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE.parent / "lib"))
from redact import redact as _redact  # noqa: E402

GAP_S = 30 * 60
TARGET, SOFT_MAX, HARD_MAX = 50, 55, 70


def ts(p: dict) -> dt.datetime:
    return dt.datetime.fromisoformat(p["first_seen"].replace("Z", "+00:00"))


def bursts(packets: list[dict]) -> list[list[dict]]:
    out: list[list[dict]] = []
    for p in packets:
        if out and (ts(p) - ts(out[-1][-1])).total_seconds() <= GAP_S:
            out[-1].append(p)
        else:
            out.append([p])
    return out


def cut_large(burst: list[dict]) -> list[list[dict]]:
    """Cut a burst bigger than HARD_MAX at its largest internal gaps until every part fits SOFT_MAX."""
    if len(burst) <= SOFT_MAX:
        return [burst]
    gaps = sorted(range(1, len(burst)), key=lambda i: -(ts(burst[i]) - ts(burst[i - 1])).total_seconds())
    for i in gaps:
        if SOFT_MAX // 4 <= i <= len(burst) - SOFT_MAX // 4:
            return cut_large(burst[:i]) + cut_large(burst[i:])
    mid = len(burst) // 2
    return cut_large(burst[:mid]) + cut_large(burst[mid:])


def pack(units: list[list[dict]]) -> list[list[dict]]:
    """Minimum sum of (size - TARGET)^2 over time-ordered partitions of the units into chunks;
    a chunk of several units never exceeds SOFT_MAX."""
    n = len(units)
    best = [float("inf")] * (n + 1)
    prev = [0] * (n + 1)
    best[0] = 0.0
    for i in range(1, n + 1):
        size = 0
        for j in range(i, 0, -1):
            size += len(units[j - 1])
            if i - j + 1 > 1 and size > SOFT_MAX:
                break
            cost = best[j - 1] + (size - TARGET) ** 2
            if cost < best[i]:
                best[i], prev[i] = cost, j - 1
    chunks: list[list[dict]] = []
    i = n
    while i > 0:
        chunks.append([p for u in units[prev[i]:i] for p in u])
        i = prev[i]
    return chunks[::-1]


def main() -> int:
    packets = [json.loads(line) for line in (HERE / "packets.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    packets.sort(key=lambda p: (p["first_seen"], p["id"]))

    units: list[list[dict]] = []
    split_ids: set[int] = set()
    for burst in bursts(packets):
        if len(burst) > HARD_MAX:
            parts = cut_large(burst)
            split_ids.update(p["id"] for part in parts for p in part)
            units.extend(parts)
        else:
            units.append(burst)
    chunks = pack(units)

    chunk_of = {p["id"]: i for i, c in enumerate(chunks, 1) for p in c}
    out_dir = HERE / "chunks"
    out_dir.mkdir(exist_ok=True)
    for old in list(out_dir.glob("*.jsonl")) + list(out_dir.glob("index.json")):
        old.unlink()

    index = []
    crossings = 0
    for i, c in enumerate(chunks, 1):
        name = f"{i:02d}"
        for p in c:
            p["chunk"] = name
        (out_dir / f"{name}.jsonl").write_text(
            "\n".join(json.dumps(p, ensure_ascii=False, separators=(",", ":")) for p in c) + "\n", encoding="utf-8")
        peers_elsewhere = sum(1 for p in c if any(chunk_of.get(x["id"], i) != i for x in p["entity"]["peers"]))
        nxt_gap = (ts(chunks[i][0]) - ts(c[-1])).total_seconds() / 60 if i < len(chunks) else None
        cut = nxt_gap is not None and nxt_gap * 60 <= GAP_S
        crossings += cut
        index.append({
            "chunk": name, "file": f"chunks/{name}.jsonl", "split": "dev" if i % 2 == 0 else "heldout",
            "from": c[0]["first_seen"], "to": c[-1]["first_seen"], "events": len(c),
            "sampled": sum(1 for p in c if not p["context"]), "context": sum(1 for p in c if p["context"]),
            "ledgered": sum(1 for p in c if p["item"]), "escalated": sum(1 for p in c if p["pre_escalated"]),
            "entity_peers_in_other_chunks": peers_elsewhere,
            "split_burst": any(p["id"] in split_ids for p in c) or cut,
            "gap_to_next_min": round(nxt_gap, 1) if nxt_gap is not None else None,
        })
    by_split = {s: {"chunks": sum(1 for x in index if x["split"] == s), "events": sum(x["events"] for x in index if x["split"] == s),
                    "sampled": sum(x["sampled"] for x in index if x["split"] == s),
                    "escalated": sum(x["escalated"] for x in index if x["split"] == s)} for s in ("dev", "heldout")}
    doc = {
        "script": "chunk.py", "source": "packets.jsonl", "packets": len(packets), "chunks": len(chunks),
        "params": {"target": TARGET, "soft_max": SOFT_MAX, "hard_max": HARD_MAX, "burst_gap_min": GAP_S // 60},
        "split_rule": "even chunk number = development, odd = held-out (PREREGISTRATION.md)",
        "neighbourhoods_cut_across_chunks": crossings, "by_split": by_split, "index": index,
    }
    (out_dir / "index.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    bad = 0
    for f in sorted(out_dir.glob("*")):
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if _redact(line) != line:
                bad += 1
                print(f"redaction gate: {f.name}:{n}", file=sys.stderr)
    sizes = [x["events"] for x in index]
    print(f"{len(chunks)} chunks, sizes {min(sizes)}-{max(sizes)} (median {sorted(sizes)[len(sizes) // 2]}), "
          f"neighbourhoods cut {crossings}, split bursts {sum(1 for x in index if x['split_burst'])}, "
          f"dev {by_split['dev']['events']} / held-out {by_split['heldout']['events']} packets, "
          f"escalated dev {by_split['dev']['escalated']} / held-out {by_split['heldout']['escalated']}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
