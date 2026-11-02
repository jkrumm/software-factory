#!/bin/bash
# software-factory version (`make version`): the commit of the release that is deployed, one line. The file `make deploy` writes and
# `make verify` compares against origin/master. Read-only.

set -u

ROOT="${FACTORY_ROOT:-$HOME/.software-factory}"
SHA_FILE="$ROOT/data/deployed-sha"

sha=$(cat "$SHA_FILE" 2>/dev/null) || { echo "version: $SHA_FILE missing: nothing was deployed" >&2; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{7,64}$ ]] || { echo "version: $SHA_FILE does not hold a commit sha" >&2; exit 1; }
echo "$sha"
