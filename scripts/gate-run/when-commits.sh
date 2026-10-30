#!/usr/bin/env bash
# Wait (bounded, read-only) until a scratch repo has at least N commits whose subject starts with a prefix, then run a
# command. Times an injection by how far a long wave is, not by the clock.
# Usage: when-commits.sh <repo-name> <prefix> <n> <seconds-to-wait> -- <command…>
#   when-commits.sh factory-gate-w 'feat: ' 3 900 -- inject-wall.sh factory-gate-w-w2 1
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

name=${1:?repo name} prefix=${2:?subject prefix} want=${3:?count} bound=${4:?seconds}
[[ ${5:-} == -- && -n ${6:-} ]] || { echo "usage: when-commits.sh <repo> <prefix> <n> <seconds> -- <command…>" >&2; exit 2; }
shift 5
end=$((SECONDS + bound))
while ((SECONDS < end)); do
  have=$(git -C "$SOURCE_ROOT/$name" log --format=%s 2>/dev/null | grep -c "^$prefix" || true)
  if ((have >= want)); then
    log "when-commits: $name has $have commits starting '$prefix' (wanted $want)"
    cmd=$1
    shift
    exec "$GATE_DIR/$cmd" "$@"
  fi
  sleep 3
done
echo "when-commits: $name never reached $want '$prefix' commits within ${bound}s" >&2
exit 1
