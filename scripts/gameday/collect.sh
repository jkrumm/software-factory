#!/usr/bin/env bash
# What exists for one spawn key, counted from herdr, the factory and Claude Code's own transcript. Read-only.
# Usage: collect.sh <spawn key> <prompt marker>     → docs/evidence/f1-gamedays/<key>/{result.txt,...}
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

key=${1:?key} marker=${2:?marker}
out=$EVIDENCE/$key
mkdir -p "$out"
result=$out/result.txt
: >"$result"
failed=0
check() { # <name> <expected> <actual>
  local verdict=FAIL
  [[ $2 == "$3" ]] && verdict=PASS || failed=1
  printf '%s\t%s\texpected %s\tgot %s\n' "$verdict" "$1" "$2" "$3" | tee -a "$result" | scrub
}

tabs=$(herdr tab list | jq -c --arg k "$key" '[.result.tabs[] | select(.label == $k)]')
echo "$tabs" | scrub >"$out/herdr-tabs.json"
tab_id=$(jq -r '.[0].tab_id // empty' <<<"$tabs")
pane=$(herdr pane list | jq -r --arg t "$tab_id" '[.result.panes[] | select(.tab_id == $t)][0].pane_id // empty')
agents=$(herdr agent list | jq -c --arg p "$pane" '[.result.agents[] | select(.pane_id == $p)]')
echo "$agents" | scrub >"$out/herdr-agents.json"
fx spawn get "$key" --format json | scrub >"$out/spawn.json"
# The transcript path is read from the raw answer: the scrubbed copy no longer names a file.
session_raw=$(fx session get "$key" --format json)
scrub <<<"$session_raw" >"$out/session.json"
db "SELECT kind, key, to_char(at AT TIME ZONE 'UTC', 'HH24:MI:SS.MS') FROM factory.events WHERE session = '$key' ORDER BY at, id" | scrub >"$out/events.txt"
db "SELECT id, source, status, sent_count, failures FROM factory.prompts WHERE session = '$key' ORDER BY created_at" | scrub >"$out/prompts.txt"
db "SELECT key, status, attempts, account, session, tab, workspace, error FROM factory.spawns WHERE key = '$key'" | scrub >"$out/spawn-row.txt"
[[ -n $pane ]] && herdr agent read "$pane" --lines 120 2>/dev/null | scrub >"$out/pane-tail.txt" || true

transcript=$(jq -r '.transcriptPath // empty' <<<"$session_raw")
users=0
if [[ -n $transcript && -f $transcript ]]; then
  # Prompts typed by the harness are user messages that carry the marker; Claude's echoes are assistant lines.
  users=$(jq -r --arg m "$marker" 'select(.type == "user" and ((.message.content | if type == "string" then . else map(.text // "") | join(" ") end) | contains($m))) | 1' "$transcript" | wc -l | tr -d ' ')
fi

check "tabs labelled $key in herdr" 1 "$(jq length <<<"$tabs")"
check "agents in that tab's pane" 1 "$(jq length <<<"$agents")"
check "spawn status" started "$(jq -r .status "$out/spawn.json")"
check "spawn pane is the tab's pane" "$pane" "$(jq -r '.pane // empty' "$out/spawn.json")"
check "session_started events" 1 "$(grep -c '^session_started|' "$out/events.txt" || true)"
check "turn_started events (one per prompt submitted)" 1 "$(grep -c '^turn_started|' "$out/events.txt" || true)"
check "user messages carrying the prompt in Claude Code's transcript" 1 "$users"
check "prompt rows (the first prompt is the Runner's, not a row)" 0 "$(wc -l <"$out/prompts.txt" | tr -d ' ')"
check "commits for the key on the scratch remote" 1 "$(git --git-dir="$REMOTES/$REPO_NAME.git" log --oneline master | grep -c "gameday $key" || true)"
check "session state" idle "$(jq -r .state "$out/session.json")"
((failed == 0))
