#!/usr/bin/env bash
# Inject one limit wall into a session through the real hook path, then give its account a reading that names the reset.
# Usage: inject-wall.sh <session> <minutes-until-reset>
#   The hook runs as the pane would run it (FACTORY_SESSION set, a rate_limit StopFailure payload on stdin).
#   The reading is a TEST ROW (PUT /quota/accounts/<account>) unless the account's real 5-hour reset already falls
#   inside the run: the real reading carries a time too, but hours away, which the watchdog would wait for.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

session=${1:?session} minutes=${2:?minutes until reset}
account=$(fx session get "$session" --format json | jq -r '.account // empty')
[[ -n $account ]] || { echo "inject-wall: $session has no account" >&2; exit 1; }
real=$(fx quota get --format json | jq -c --arg a "$account" '.quota[] | select(.account == $a)')
log "wall: $session on $account, real reading before: $(jq -c '{fiveHourUsed,weeklyUsed,fiveHourResetsAt,exhaustedUntil}' <<<"$real")"

claude_session=$(fx session get "$session" --format json | jq -r '.claudeSessionId // "gate-run"')
payload=$(jq -nc --arg s "$claude_session" '{hook_event_name:"StopFailure",session_id:$s,error:"rate_limit",error_details:"injected by the F1 gate run"}')
reset=$(date -u -v+"${minutes}M" +%Y-%m-%dT%H:%M:%SZ)

hook_at=$(now_utc)
FACTORY_SESSION=$session factory hook stop-failure <<<"$payload"
# The test row right after the wall: the first reading at or after the wall that names an end is the one the watchdog uses.
body=$(jq -nc --arg r "$reset" --argjson five "$(jq '.fiveHourUsed // 0' <<<"$real")" --argjson wk "$(jq '.weeklyUsed // 0' <<<"$real")" \
  --arg wr "$(jq -r '.weeklyResetsAt // empty' <<<"$real")" \
  '{fiveHourUsed:100,weeklyUsed:$wk,fiveHourResetsAt:$r,weeklyResetsAt:(if $wr == "" then null else $wr end),exhaustedUntil:$r,ageS:0}')
# secrets-run redacts a secret it prints to a pipe, so the call runs inside it and the body travels in the environment.
# shellcheck disable=SC2016  # the inner shell expands them
GATE_BODY=$body GATE_URL="${FACTORY_URL:-http://127.0.0.1:7793}/quota/accounts/$account" \
  secrets-run run --env-file="$ROOT/.env.tpl" -- sh -c \
  'curl -fsS -X PUT "$GATE_URL" -H "Authorization: Bearer $FACTORY_TOKEN" -H "Content-Type: application/json" -d "$GATE_BODY"' |
  jq -c '{account,fiveHourUsed,fiveHourResetsAt,exhaustedUntil}' | scrub
log "wall: hook stop-failure rate_limit for $session at $hook_at; TEST ROW on $account, reset $reset (+${minutes} min), five-hour use 100 for the row"
