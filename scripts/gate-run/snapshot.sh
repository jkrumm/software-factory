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
spawns=$(fx spawn list --format json | jq -r --argjson names "$(printf '%s\n' "${CHAINS[@]}" | jq -R . | jq -sc .)" '[.spawns[] | select((.key | sub("-w[0-9]+$"; "")) as $c | $names | index($c)) | "\(.key)=\(.status)\(if .hold then "(" + .hold + ")" else "" end)"] | join(" ")')
line=$(jq -r --arg queues "$queues" --arg spawns "$spawns" --argjson names "$(printf '%s\n' "${CHAINS[@]}" | jq -R . | jq -sc .)" '
  "sessions: " + ([.sessions[] | select(.id | startswith("factory-gate-")) | select(.id | sub("-w[0-9]+$"; "") | IN($names[])) | "\(.id)=\(.state)(\(.account // "-"),t\(.turn))"] | join(" "))
  + " | spawns: " + $spawns
  + " | notes pending: \((.notes | length) + .notesMore)"
  + " | queue:\($queues) global=\(.queue.effective)"
  + " | accounts: " + ([.accounts[] | "\(.account) 5h=\(.fiveHourUsed // "-")% wk=\(.weeklyUsed // "-")%"] | join(", "))' <<<"$status")
log "snapshot: $line"
