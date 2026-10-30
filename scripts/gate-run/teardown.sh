#!/usr/bin/env bash
# Close the chains' tabs with `rd close`, then remove the scratch repos and their bare remotes.
# Usage: teardown.sh   (run after the evidence is written)
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

for name in "${CHAINS[@]}"; do
  for n in 1 2 3 4 5; do
    rd close "$name-w$n" 2>&1 | scrub | sed "s/^/teardown: $name-w$n: /" || true
  done
done
for name in "${CHAINS[@]}"; do
  rm -rf "${SOURCE_ROOT:?}/$name" "${REMOTES:?}/$name.git"
done
rmdir "$REMOTES" 2>/dev/null || true
echo "teardown: scratch repos and remotes removed"
