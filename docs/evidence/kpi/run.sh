#!/usr/bin/env bash
# Re-run the warden-ledger KPI scripts and gate their outputs for the public repo.
#   baseline.py -> baseline.out.{json,md}   item, escalated, owner_touch, autonomy_rate, resolved,
#                                           time_to_resolve, reopen_rate, regression_rate, revert_rate
#   cost.py     -> cost.out.{json,md}       cost_per_resolved_item and the attribution coverage
# Both read the frozen snapshot (evidence/snapshot.sh) and share ledger.py, so they cannot disagree
# on what an item or a resolved item is. cost.py also reads agent-gateway's OpenCode v2 store live,
# read-only, rows before AS_OF (see its docstring).
# env: AS_OF (default 2026-10-22T08:00:00Z), FACTORY_SNAPSHOTS, AGW_OPENCODE_DB
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

AS_OF="${AS_OF:-2026-10-22T08:00:00Z}"
SNAP="${FACTORY_SNAPSHOTS:-$HOME/.local/share/factory/snapshots}/${AS_OF%%T*}"
[[ -f $SNAP/warden.db ]] || { echo "run.sh: no snapshot at $SNAP (AS_OF=$AS_OF; run ../snapshot.sh first)" >&2; exit 1; }

export AS_OF
python3 -I baseline.py
python3 -I cost.py
python3 -I ../lib/redact.py --check baseline.out.json baseline.out.md cost.out.json cost.out.md
echo "run.sh: outputs written and clean"
