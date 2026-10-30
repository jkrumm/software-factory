#!/usr/bin/env bash
# One line for the evidence log: time, each gate session's derived state, notes pending, queue state, accounts.
# Usage: snapshot.sh   (append to log.txt; the run does it every 15 minutes)
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

status=$(fx status --format json)
queue_a=$(fx queue get --project "$SOURCE_ROOT/factory-gate-a" --format json | jq -r .effective)
queue_b=$(fx queue get --project "$SOURCE_ROOT/factory-gate-b" --format json | jq -r .effective)
spawns=$(fx spawn list --format json | jq -r '[.spawns[] | select(.key | startswith("factory-gate-")) | "\(.key)=\(.status)\(if .hold then "(" + .hold + ")" else "" end)"] | join(" ")')
line=$(jq -r --arg qa "$queue_a" --arg qb "$queue_b" --arg spawns "$spawns" '
  "sessions: " + ([.sessions[] | select(.id | startswith("factory-gate-")) | "\(.id)=\(.state)(\(.account // "-"),t\(.turn))"] | join(" "))
  + " | spawns: " + $spawns
  + " | notes pending: \((.notes | length) + .notesMore)"
  + " | queue: a=\($qa) b=\($qb) global=\(.queue.effective)"
  + " | accounts: " + ([.accounts[] | "\(.account) 5h=\(.fiveHourUsed // "-")% wk=\(.weeklyUsed // "-")%"] | join(", "))' <<<"$status")
log "snapshot: $line"
