#!/usr/bin/env bash
# Re-run the delivery and capacity half of the KPI baseline and gate the outputs for the public repo.
#   git_delivery.py  -> git_delivery.out.{json,md}   revert_rate, rework_share (+ the old fix-prefix proxy, agent signals)
#   dora.py          -> dora.out.{json,md}           dora.* (imports git_delivery.py; reads the warden snapshot,
#                                                    the research-gateway deploy log and, via gh, GitHub Actions)
#   quota.py         -> quota.out.{json,md}          max_headroom and the Max vs IU weekly split
#   herdr_hygiene.py -> herdr_hygiene.out.{json,md}  herdr_hygiene (LIVE measurement, not a replay of AS_OF)
# Dependency order: git_delivery.py first (dora.py imports its commit annotation), the other two are independent.
# Needs the frozen snapshot (../snapshot.sh) for warden.db and usage.db; git, gh and herdr are read-only here.
# env: AS_OF (default 2026-10-22T08:00:00Z), FACTORY_SNAPSHOTS, DORA_GH=0 to skip the GitHub Actions read
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

AS_OF="${AS_OF:-2026-10-22T08:00:00Z}"
SNAP="${FACTORY_SNAPSHOTS:-$HOME/.local/share/factory/snapshots}/${AS_OF%%T*}"
for f in warden.db usage.db; do
  [[ -f $SNAP/$f ]] || { echo "run-delivery.sh: no $f in $SNAP (AS_OF=$AS_OF; run ../snapshot.sh first)" >&2; exit 1; }
done

export AS_OF
python3 -I git_delivery.py
python3 -I dora.py
python3 -I quota.py
python3 -I herdr_hygiene.py
python3 -I ../lib/redact.py --check \
  git_delivery.out.json git_delivery.out.md dora.out.json dora.out.md \
  quota.out.json quota.out.md herdr_hygiene.out.json herdr_hygiene.out.md
echo "run-delivery.sh: outputs written and clean"
