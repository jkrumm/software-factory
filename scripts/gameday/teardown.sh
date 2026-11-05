#!/usr/bin/env bash
# End what the gameday started, then remove the scratch repo and its bare remote. A spawn nobody claimed (queued, waiting) is
# cancelled with `factory spawn cancel`; a started one has its terminal (label factory.key=<key>) killed and removed with `hc kill`
# and `hc rm`. Only what setup.sh made (the marker file in .git and in the remote), and not while a spawn is starting.
# Usage: teardown.sh   (after the evidence is written)
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

repo=$(realpath "${SOURCE_ROOT:?}")/$REPO_NAME remote=${REMOTES:?}/$REPO_NAME.git
# Only the spawns that ran in this scratch repo, whatever their key.
keys=$(db "SELECT key FROM factory.spawns WHERE repo = '${repo//\'/\'\'}'")
while IFS='|' read -r key; do
  [[ -n $key ]] || continue
  status=$(db "SELECT status FROM factory.spawns WHERE key = '$key'")
  case $status in starting) echo "teardown: spawn $key is starting; it would start in a removed repo" >&2; exit 1 ;; esac
done <<<"$keys"
if [[ ! -e $repo/.git/factory-gameday || ! -e $remote/factory-gameday ]]; then
  echo "teardown: no gameday marker, leaving it alone" >&2
  exit 0
fi
while IFS= read -r key; do
  [[ -n $key ]] || continue
  status=$(db "SELECT status FROM factory.spawns WHERE key = '$key'")
  case $status in queued | waiting) fx spawn cancel "$key" 2>&1 | head -1 | scrub | sed "s/^/teardown: $key: /" || true ;; esac
  # A cancelled or never-started spawn has no terminal; a finished one only needs `rm`.
  terminals=$(hc ls --all --json --label "factory.key=$key") || { echo "teardown: hc ls failed, removed nothing" >&2; exit 1; }
  while IFS= read -r address; do
    [[ -n $address ]] || continue
    hc kill "$address" >/dev/null 2>&1 || true
    hc rm "$address" 2>&1 | head -1 | scrub | sed "s/^/teardown: $key: /" || true
  done < <(jq -r '.terminals[].address' <<<"$terminals")
  if [[ $(jq '.terminals | length' < <(hc ls --all --json --label "factory.key=$key")) != 0 ]]; then
    echo "teardown: a terminal of $key is still listed; removed nothing" >&2
    exit 1
  fi
done <<<"$keys"
rm -rf "$repo" "$remote"
rmdir "$REMOTES" 2>/dev/null || true
echo "teardown: $REPO_NAME removed"
