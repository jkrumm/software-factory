#!/usr/bin/env bash
# Make the two scratch repos with their local bare remotes and the chain plans. Refuses to touch what exists.
# Usage: setup.sh
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mkdir -p "$REMOTES" "$EVIDENCE"
for name in "${CHAINS[@]}"; do
  repo=$SOURCE_ROOT/$name
  remote=$REMOTES/$name.git
  [[ ! -e $repo && ! -e $remote ]] || { echo "setup: $repo or $remote exists; run teardown.sh first" >&2; exit 1; }
  variant=${name##*-}

  git init --quiet --bare --initial-branch=master "$remote"
  git init --quiet --initial-branch=master "$repo"
  cp -R "$GATE_DIR/template/common/." "$repo/"
  mkdir -p "$repo/docs/waves" "$repo/src"
  cp "$GATE_DIR/template/$variant/PLAN.md" "$repo/docs/waves/PLAN.md"
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" add -A
  git -C "$repo" commit --quiet -m "chore: scratch repo for the factory gate run"
  git -C "$repo" push --quiet -u origin master
  echo "setup: $repo (remote $remote)" | scrub
done
