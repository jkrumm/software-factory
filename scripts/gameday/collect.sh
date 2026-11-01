#!/usr/bin/env bash
# What exists for one spawn key, counted from herdr-core (`hc`), the factory and Claude Code's own transcript. Read-only.
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

terminals=$(terminals_of "$key")
echo "$terminals" | scrub >"$out/hc-terminals.json"
pane=$(jq -r '.[0].address // empty' <<<"$terminals")
# An agent is a live terminal running Claude Code; the first prompt is the last argument of the program it was run with.
agents=$(jq -c '[.[] | select(.state == "live" and .agent == "claude-code")]' <<<"$terminals")
echo "$agents" | scrub >"$out/hc-agents.json"
terminal='{}'
[[ -n $pane ]] && terminal=$(hc get "$pane" --json)
scrub <<<"$terminal" >"$out/hc-terminal.json"
fx spawn get "$key" --format json | scrub >"$out/spawn.json"
# The transcript path is read from the raw answer: the scrubbed copy no longer names a file.
session_raw=$(fx session get "$key" --format json)
scrub <<<"$session_raw" >"$out/session.json"
db "SELECT kind, key, to_char(at AT TIME ZONE 'UTC', 'HH24:MI:SS.MS') FROM factory.events WHERE session = '$key' ORDER BY at, id" | scrub >"$out/events.txt"
db "SELECT id, source, status, sent_count, failures FROM factory.prompts WHERE session = '$key' ORDER BY created_at" | scrub >"$out/prompts.txt"
db "SELECT key, status, attempts, account, session, tab, workspace, error FROM factory.spawns WHERE key = '$key'" | scrub >"$out/spawn-row.txt"
[[ -n $pane ]] && hc read "$pane" --lines 120 2>/dev/null | scrub >"$out/pane-tail.txt" || true

transcript=$(jq -r '.transcriptPath // empty' <<<"$session_raw")
users=0
if [[ -n $transcript && -f $transcript ]]; then
  # Prompts typed by the harness are user messages that carry the marker; Claude's echoes are assistant lines.
  users=$(jq -r --arg m "$marker" 'select(.type == "user" and ((.message.content | if type == "string" then . else map(.text // "") | join(" ") end) | contains($m))) | 1' "$transcript" | wc -l | tr -d ' ')
fi

check "terminals labelled factory.key=$key in hc" 1 "$(jq length <<<"$terminals")"
check "agents (live Claude Code terminals) among them" 1 "$(jq length <<<"$agents")"
check "spawn status" started "$(jq -r .status "$out/spawn.json")"
check "spawn pane is the terminal's address" "$pane" "$(jq -r '.pane // empty' "$out/spawn.json")"
check "session_started events" 1 "$(grep -c '^session_started|' "$out/events.txt" || true)"
check "turn_started events (one per prompt submitted)" 1 "$(grep -c '^turn_started|' "$out/events.txt" || true)"
check "terminals whose program ends with the prompt (the first prompt is its last argument)" 1 "$(jq -r --arg m "$marker" '[(.argv[-1] // "") | select(contains($m))] | length' <<<"$terminal")"
check "user messages carrying the prompt in Claude Code's transcript" 1 "$users"
check "prompt rows (the first prompt is the Runner's, not a row)" 0 "$(wc -l <"$out/prompts.txt" | tr -d ' ')"
check "commits for the key on the scratch remote" 1 "$(git --git-dir="$REMOTES/$REPO_NAME.git" log --oneline master | grep -c "gameday $key" || true)"
check "session state" idle "$(jq -r .state "$out/session.json")"
((failed == 0))
