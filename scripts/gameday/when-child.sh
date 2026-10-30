#!/usr/bin/env bash
# Wait (bounded) until the server process has a child whose command line matches a pattern, then run a command at once.
# The server calls herdr as child processes, so this is how a kill lands inside one of the Runner's steps.
# Usage: when-child.sh <pattern> <seconds> -- <command…>
#   when-child.sh 'herdr agent start' 120 -- kill-server.sh claimed key    # the tab exists, the agent is coming up
#   when-child.sh 'herdr agent prompt' 120 -- kill-server.sh prompt key    # the first prompt is being submitted
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

pattern=${1:?pattern} bound=${2:?seconds}
[[ ${3:-} == -- && -n ${4:-} ]] || { echo "usage: when-child.sh <pattern> <seconds> -- <command…>" >&2; exit 2; }
shift 3
pid=$(server_pid) || { echo "when-child: no server process" >&2; exit 1; }
export GAMEDAY_EXPECT_PID=$pid
end=$((SECONDS + bound))
while ((SECONDS < end)); do
  # The run that armed this watcher is gone (even by SIGKILL): disarm.
  kill -0 "$PPID" 2>/dev/null || { echo "when-child: the run that armed this is gone" >&2; exit 1; }
  if pgrep -P "$pid" -f "$pattern" >/dev/null 2>&1; then
    cmd=$1
    shift
    exec "$GAMEDAY_DIR/$cmd" "$@"
  fi
  sleep 0.02
done
echo "when-child: no child matching '$pattern' within ${bound}s" >&2
exit 1
