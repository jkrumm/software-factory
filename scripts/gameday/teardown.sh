#!/usr/bin/env bash
# End what the gameday started, then remove the scratch repo and its bare remote. An Issue of the scratch repo that is still
# open is cancelled (`factory issue cancel`); the leads' terminals are the factory's own to finalize. Only what setup.sh made
# (the marker file in .git and in the remote).
# Usage: teardown.sh   (after the evidence is written)
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

repo=$(realpath "${SOURCE_ROOT:?}")/$REPO_NAME remote=${REMOTES:?}/$REPO_NAME.git
if [[ ! -e $repo/.git/factory-gameday || ! -e $remote/factory-gameday ]]; then
  echo "teardown: no gameday marker, leaving it alone" >&2
  exit 0
fi
open=$(db "SELECT id FROM factory.issues WHERE repo = '${REPO_NAME//\'/\'\'}' AND state <> 'closed'")
while IFS= read -r id; do
  [[ -n $id ]] || continue
  fx issue cancel "$id" --reason "gameday teardown" --call "gd-teardown-$id" 2>&1 | head -1 | scrub | sed "s/^/teardown: $id: /" || true
done <<<"$open"
# A cancel finalizes the attempt on the next pass of the leads' loop: wait until no lead of the repo is left running.
for _ in $(seq 1 60); do
  left=$(db "SELECT count(*) FROM factory.lead_attempts a JOIN factory.issues i ON i.id = a.issue_id WHERE i.repo = '${REPO_NAME//\'/\'\'}' AND a.started_at IS NOT NULL AND a.gone_at IS NULL AND NOT EXISTS (SELECT 1 FROM factory.lead_finalizations f WHERE f.issue_id = a.issue_id AND f.attempt = a.attempt AND f.done_at IS NOT NULL)")
  [[ ${left:-0} == 0 ]] && break
  sleep 5
done
[[ ${left:-0} == 0 ]] || { echo "teardown: $left lead(s) of $REPO_NAME are still running; removed nothing" >&2; exit 1; }
rm -rf "$repo" "$remote"
rmdir "$REMOTES" 2>/dev/null || true
echo "teardown: $REPO_NAME removed"
