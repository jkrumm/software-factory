#!/usr/bin/env bash
# Start both chains the way an owner does: `rd wave` per repo, the factory path. Prints each spawn's account and role.
# Usage: start.sh
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

for name in "${CHAINS[@]}"; do
  log "start: rd wave $name (Wave 1)"
  rd wave "$name" 'Read docs/waves/PLAN.md. Execute the active wave (Wave 1). Follow the /wave skill.' 2>&1 | scrub | tee -a "$EVIDENCE/log.txt"
  fx spawn get "$name-w1" --format json | jq -c '{key,status,account,role,tier,effort,hold,pane,tab,workspace}' | scrub | tee -a "$EVIDENCE/log.txt"
done
