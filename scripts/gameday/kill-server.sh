#!/usr/bin/env bash
# `kill -9` the factory's own server process, then wait until the LaunchAgent has it healthy again. Nothing else is killed:
# the pid is the `bun packages/server/src/main.ts` child of the LaunchAgent's job, checked by command and by release directory.
# Usage: kill-server.sh <moment> <spawn key>      (moment and key only label the log line)
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

moment=${1:-manual} key=${2:--}
pid=$(server_pid) || { echo "kill-server: no server process under the LaunchAgent" >&2; exit 1; }
# The watcher saw this server do the thing the kill is timed by; a server that has restarted since is not that one.
[[ -z ${GAMEDAY_EXPECT_PID:-} || $GAMEDAY_EXPECT_PID == "$pid" ]] || { echo "kill-server: the server restarted since the watcher armed (pid $GAMEDAY_EXPECT_PID, now $pid)" >&2; exit 1; }
[[ $(ps -o command= -p "$pid") == "bun packages/server/src/main.ts" ]] || { echo "kill-server: pid $pid is not the server" >&2; exit 1; }
lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -q '^n.*/\.software-factory/releases/' || { echo "kill-server: pid $pid does not run from a release" >&2; exit 1; }

# The dotfiles heartbeat pages on every restart of a KeepAlive job unless an epoch line marks it deliberate (deploy.sh does the same).
{ mkdir -p "$HOME/.local/state/devhost/deliberate-restart" && date +%s >>"$HOME/.local/state/devhost/deliberate-restart/$LABEL"; } 2>/dev/null || true
# Only what each child is, never its arguments (another session's prompt, a path): `hc connect` for hc (the JSON-RPC call itself is
# on its stdin, not in its arguments), else the program's name.
children=$(pgrep -P "$pid" -fl 2>/dev/null | awk '{ n = split($2, p, "/"); if (p[n] == "hc") print "hc", $3; else print p[n] }' | paste -sd ';' - || true)
t0=$(now_ms)
kill -9 "$pid"
log "kill: -9 server pid $pid at moment '$moment' for $key; children at the kill: ${children:-none}"
# What the core and the database say of the spawn the instant after. The watcher binds to the key by the terminal's label, not by the
# call in flight, so this is what shows where the kill landed: a row still `starting` is a kill inside the claim.
if [[ $key != - ]]; then
  log "kill: hc terminal for $key right after: $(hc get "$(terminal_name "$key")" --json 2>/dev/null | jq -c '{address, state, status, reported, turn}' 2>/dev/null || echo 'no terminal')"
  log "kill: spawn row for $key right after: $(db "SELECT status, attempts, session FROM factory.spawns WHERE key = '$key'" 2>/dev/null || echo 'unreadable')"
fi

for _ in $(seq 1 240); do
  new=$(server_pid || true)
  if [[ -n $new && $new != "$pid" ]] && healthy; then
    log "kill: server back as pid $new, healthy $(($(now_ms) - t0)) ms after the kill (the LaunchAgent restarted it, KeepAlive)"
    exit 0
  fi
  sleep 0.5
done
log "kill: server NOT healthy 120 s after the kill"
exit 1
