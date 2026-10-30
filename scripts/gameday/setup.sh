#!/usr/bin/env bash
# Make the scratch repo and its local bare remote the kill runs spawn into. Refuses to touch what exists.
# Usage: setup.sh
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

repo=$SOURCE_ROOT/$REPO_NAME remote=$REMOTES/$REPO_NAME.git
[[ ! -e $repo && ! -e $remote ]] || { echo "setup: $repo or $remote exists; run teardown.sh first (only if it is a gameday repo)" >&2; exit 1; }
mkdir -p "$REMOTES" "$EVIDENCE"
git init --quiet --bare --initial-branch=master "$remote"
git init --quiet --initial-branch=master "$repo"
cp "$GAMEDAY_DIR/template/AGENTS.md" "$repo/AGENTS.md"
git -C "$repo" remote add origin "$remote"
git -C "$repo" add -A
git -C "$repo" commit --quiet -m "chore: scratch repo for the factory gamedays"
git -C "$repo" push --quiet -u origin master
: >"$repo/.git/factory-gameday" && : >"$remote/factory-gameday"
echo "setup: $repo (remote $remote)" | scrub
