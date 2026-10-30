#!/usr/bin/env bash
# One line for the evidence log: time, each gate session's derived state, notes pending, queue state, accounts.
# Usage: snapshot.sh   (append to log.txt; the run does it every 15 minutes)
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

status=$(fx status --format json)
queues=""
for name in "${CHAINS[@]}"; do
  queues+=" ${name#factory-gate-}=$(fx queue get --project "$SOURCE_ROOT/$name" --format json | jq -r .effective)"
done
# One get per possible key: the list is capped at the newest 200 rows.
spawns=""
for name in "${CHAINS[@]}"; do
  for n in 1 2 3 4 5; do
    spawns+=$(fx spawn get "$name-w$n" --format json 2>/dev/null | jq -r '" \(.key)=\(.status)\(if .hold then "(" + .hold + ")" else "" end)"' 2>/dev/null || true)
  done
done
line=$(jq -r --arg queues "$queues" --arg spawns "$spawns" --argjson names "$(printf '%s\n' "${CHAINS[@]}" | jq -R . | jq -sc .)" '
  "sessions: " + ([.sessions[] | select(.id | sub("-w[0-9]+$"; "") | IN($names[])) | "\(.id)=\(.state)(\(.account // "-"),t\(.turn))"] | join(" "))
  + " | spawns: " + $spawns
  + " | notes pending: \((.notes | length) + .notesMore)"
  + " | queue:\($queues) global=\(.queue.effective)"
  + " | accounts: " + ([.accounts[] | "\(.account) 5h=\(.fiveHourUsed // "-")% wk=\(.weeklyUsed // "-")%"] | join(", "))' <<<"$status")
log "snapshot: $line"
