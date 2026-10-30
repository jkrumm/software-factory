#!/usr/bin/env bash
# Set or lift the drain on one scratch repo. Usage: drain.sh on|off <repo-name>
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode=${1:?on|off} name=${2:?repo name}
case $mode in on) state=drain ;; off) state=run ;; *) echo "usage: drain.sh on|off <repo-name>" >&2; exit 2 ;; esac
log "queue: set $state for $name"
fx queue set "$state" --project "$SOURCE_ROOT/$name" --format json | jq -c '{scope,state,effective,setAt}' | scrub | tee -a "$EVIDENCE/log.txt"
