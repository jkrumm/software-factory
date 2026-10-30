#!/usr/bin/env bash
# Close the chains' tabs with `rd close`, then remove the scratch repos and their bare remotes.
# Usage: teardown.sh   (run after the evidence is written and the chains are over)
#   Removes only what setup.sh made (the marker file in .git and in the remote), and refuses while a chain's agent is
#   still listed by `rd agents` or one of its spawns is queued, waiting or starting (it would start in a removed repo).
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Every spawn key a chain can have, asked one by one (the list is capped at 200 rows).
for name in "${CHAINS[@]}"; do
  for n in 1 2 3 4 5; do
    status=$(fx spawn get "$name-w$n" --format json 2>/dev/null | jq -r '.status // empty' || true)
    case $status in queued | waiting | starting)
      echo "teardown: spawn $name-w$n is $status; it would start in a removed repo" >&2
      exit 1
      ;;
    esac
  done
done

for name in "${CHAINS[@]}"; do
  repo=${SOURCE_ROOT:?}/$name remote=${REMOTES:?}/$name.git
  if [[ ! -e $repo/.git/factory-gate-run || ! -e $remote/factory-gate-run ]]; then
    echo "teardown: $name has no gate-run marker, leaving it alone" >&2
    continue
  fi
  for n in 1 2 3 4 5; do
    rd close "$name-w$n" 2>&1 | head -1 | scrub | sed "s/^/teardown: $name-w$n: /" || true
  done
  agents=$(rd agents 2>&1) || { echo "teardown: rd agents failed, removed nothing" >&2; exit 1; }
  if grep -Eq "(^|[[:space:]])$name([[:space:]]|$)|$name-w[0-9]" <<<"$agents"; then
    echo "teardown: $name still has an agent (not clean, pushed or finished); closed nothing more, removed nothing" >&2
    continue
  fi
  rm -rf "$repo" "$remote"
  echo "teardown: $name removed"
done
rmdir "$REMOTES" 2>/dev/null || true
