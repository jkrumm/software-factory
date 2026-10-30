#!/usr/bin/env bash
# Close the gameday tabs with `rd close`, then remove the scratch repo and its bare remote. Only what setup.sh made (the
# marker file in .git and in the remote), and not while a gameday spawn is queued, waiting or starting.
# Usage: teardown.sh   (after the evidence is written)
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

repo=$(realpath "${SOURCE_ROOT:?}")/$REPO_NAME remote=${REMOTES:?}/$REPO_NAME.git
# Only the spawns that ran in this scratch repo, whatever their key.
keys=$(db "SELECT key FROM factory.spawns WHERE repo = '${repo//\'/\'\'}'")
while IFS='|' read -r key; do
  [[ -n $key ]] || continue
  status=$(db "SELECT status FROM factory.spawns WHERE key = '$key'")
  case $status in queued | waiting | starting) echo "teardown: spawn $key is $status; it would start in a removed repo" >&2; exit 1 ;; esac
done <<<"$keys"
if [[ ! -e $repo/.git/factory-gameday || ! -e $remote/factory-gameday ]]; then
  echo "teardown: no gameday marker, leaving it alone" >&2
  exit 0
fi
while IFS= read -r key; do
  [[ -n $key ]] || continue
  rd close "$key" 2>&1 | head -1 | scrub | sed "s/^/teardown: $key: /" || true
done <<<"$keys"
agents=$(rd agents 2>&1) || { echo "teardown: rd agents failed, removed nothing" >&2; exit 1; }
if grep -qF -f <(printf '%s\n' "$keys" | grep .) <<<"$agents"; then
  echo "teardown: a gameday agent is still listed (not clean, pushed or finished); removed nothing" >&2
  exit 1
fi
rm -rf "$repo" "$remote"
rmdir "$REMOTES" 2>/dev/null || true
echo "teardown: $REPO_NAME removed"
