#!/usr/bin/env bash
# `kill -9` the factory's own server process, then wait until the LaunchAgent has it healthy again. Nothing else is killed:
# the pid is the `bun apps/server/src/main.ts` child of the LaunchAgent's job, checked by command and by release directory.
# Usage: kill-server.sh <moment> <issue>      (moment and issue only label the log line)
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

moment=${1:-manual} issue=${2:--}
pid=$(server_pid) || { echo "kill-server: no server process under the LaunchAgent" >&2; exit 1; }
[[ $(ps -o command= -p "$pid") == "bun apps/server/src/main.ts" ]] || { echo "kill-server: pid $pid is not the server" >&2; exit 1; }
lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -q '^n.*/\.software-factory/releases/' || { echo "kill-server: pid $pid does not run from a release" >&2; exit 1; }

# The dotfiles heartbeat pages on every restart of a KeepAlive job unless an epoch line marks it deliberate (deploy.sh does the same).
{ mkdir -p "$HOME/.local/state/devhost/deliberate-restart" && date +%s >>"$HOME/.local/state/devhost/deliberate-restart/$LABEL"; } 2>/dev/null || true
t0=$(now_ms)
kill -9 "$pid"
log "kill: -9 server pid $pid at moment '$moment' for Issue $issue"

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
