#!/usr/bin/env bash
# Wait (bounded, read-only) until a session works, then run a command. A wave is done in about a minute, so an injection
# cannot be timed by hand. Usage: when-working.sh <session> <seconds-to-wait> -- <command…>
#   when-working.sh factory-gate-d-w2 500 -- inject-wall.sh factory-gate-d-w2 6
#   when-working.sh factory-gate-e-w2 500 -- drain.sh on factory-gate-e
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
    exec "$GATE_DIR/$cmd" "$@"
  fi
  sleep 2
done
echo "when-working: $session never worked within ${bound}s" >&2
exit 1
