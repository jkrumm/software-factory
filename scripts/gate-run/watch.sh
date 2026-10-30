#!/usr/bin/env bash
# Look at the gate sessions every 30 s until their states match a pattern or the bound passes. Only reads.
# Usage: watch.sh <egrep pattern over "id=state ..."> [seconds, default 520]
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

pattern=${1:?pattern} bound=${2:-520}
end=$((SECONDS + bound))
while ((SECONDS < end)); do
  line=$(fx session list --format json | jq -r '[.sessions[] | select(.id | startswith("factory-gate-")) | "\(.id)=\(.state)"] | join(" ")')
  echo "$(date -u +%T) $line"
  grep -Eq "$pattern" <<<"$line" && exit 0
  sleep 30
done
exit 1
