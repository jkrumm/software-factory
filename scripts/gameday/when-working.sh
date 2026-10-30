#!/usr/bin/env bash
# Wait (bounded, read-only) until a session works a turn, then run a command at once.
# Usage: when-working.sh <session> <seconds> -- <command…>
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

session=${1:?session} bound=${2:?seconds}
[[ ${3:-} == -- && -n ${4:-} ]] || { echo "usage: when-working.sh <session> <seconds> -- <command…>" >&2; exit 2; }
shift 3
end=$((SECONDS + bound))
while ((SECONDS < end)); do
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
