#!/usr/bin/env bash
# Run one or both F2 gamedays live against the deployed factory; each writes report.md under docs/evidence/f2-gate/<gameday>/<run>/.
# A run that fails a pass line is a finding, not a retry: its evidence stays, and a rerun takes a new run id (at most three per gameday).
# Usage: run.sh <silent-lead|seeded-bug|all> [run-id]     (run-id: 1-8 characters of [a-z0-9]; with `all`, the id is used for both)
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

which=${1:?silent-lead|seeded-bug|all} run=${2:-}
args=()
[[ -z $run ]] || args=("$run")
rc=0
case $which in
  silent-lead) "$F2_DIR/silent-lead.sh" "${args[@]}" || rc=$? ;;
  seeded-bug) "$F2_DIR/seeded-bug.sh" "${args[@]}" || rc=$? ;;
  all)
    # One after the other: each holds the same account and the factory's tick.
    "$F2_DIR/silent-lead.sh" "${args[@]}" || rc=$?
    "$F2_DIR/seeded-bug.sh" "${args[@]}" || rc=$?
    ;;
  *) echo "usage: run.sh <silent-lead|seeded-bug|all> [run-id]" >&2; exit 2 ;;
esac
exit "$rc"
