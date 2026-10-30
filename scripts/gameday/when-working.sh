#!/usr/bin/env bash
# Wait (bounded, read-only) until a session works a turn, then run a command at once.
# Usage: when-working.sh <session> <seconds> -- <command…>
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

session=${1:?session} bound=${2:?seconds}
[[ ${3:-} == -- && -n ${4:-} ]] || { echo "usage: when-working.sh <session> <seconds> -- <command…>" >&2; exit 2; }
shift 3
GAMEDAY_EXPECT_PID=$(server_pid) || { echo "when-working: no server process" >&2; exit 1; }
export GAMEDAY_EXPECT_PID
end=$((SECONDS + bound))
while ((SECONDS < end)); do
  kill -0 "$PPID" 2>/dev/null || { echo "when-working: the run that armed this is gone" >&2; exit 1; }
  state=$(fx session get "$session" --format json 2>/dev/null | jq -r '.state // empty' || true)
  if [[ $state == working ]]; then
    cmd=$1
    shift
    exec "$GAMEDAY_DIR/$cmd" "$@"
  fi
  sleep 1
done
echo "when-working: $session never worked within ${bound}s" >&2
exit 1
