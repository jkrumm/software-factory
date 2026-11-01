#!/usr/bin/env bash
# Wait (bounded) until the server process has a child whose command line matches a pattern, and the spawn's terminal exists, then
# run a command at once. The server calls hc as child processes, one `hc connect` per JSON-RPC call (the method travels on its
# stdin, so a command line cannot tell a `terminal.run` from a `terminal.get`); this is how a kill lands inside the Runner's start.
# The key is bound by the terminal's label `factory.key=<key>`: another session's call can be the child that fires it, so the
# kill-server log line "spawn row ... right after" says whether the kill hit this spawn's claim (`starting`).
# Usage: when-child.sh <pattern> <label k=v, or - for none> <seconds> -- <command…>
#   when-child.sh 'hc connect' factory.key=<key> 180 -- kill-server.sh claimed <key>   # the terminal exists, the Runner is not done
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

pattern=${1:?pattern} label=${2:?label k=v or -} bound=${3:?seconds}
[[ ${4:-} == -- && -n ${5:-} ]] || { echo "usage: when-child.sh <pattern> <label k=v|-> <seconds> -- <command…>" >&2; exit 2; }
shift 4
pid=$(server_pid) || { echo "when-child: no server process" >&2; exit 1; }
export GAMEDAY_EXPECT_PID=$pid
has_terminal() { [[ $label == - ]] || [[ $(hc ls --all --json --label "$label" 2>/dev/null | jq -r '.terminals | length' 2>/dev/null) -ge 1 ]]; }
end=$((SECONDS + bound))
while ((SECONDS < end)); do
  # The run that armed this watcher is gone (even by SIGKILL): disarm.
  kill -0 "$PPID" 2>/dev/null || { echo "when-child: the run that armed this is gone" >&2; exit 1; }
  if pgrep -P "$pid" -f "$pattern" >/dev/null 2>&1 && has_terminal; then
    cmd=$1
    shift
    exec "$GAMEDAY_DIR/$cmd" "$@"
  fi
  sleep 0.02
done
echo "when-child: no child matching '$pattern' with a terminal labelled '$label' within ${bound}s" >&2
exit 1
