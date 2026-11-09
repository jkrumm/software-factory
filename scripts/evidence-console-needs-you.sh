#!/usr/bin/env bash
# Copies the Needs-you screenshots `make e2e` wrote (tests/e2e/out/screenshots/console-needs-you, from since-band.e2e.ts)
# into the Issue's evidence folder. Run it after `make e2e`; commit what it copies.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
from="$root/tests/e2e/out/screenshots/console-needs-you"
to="$root/docs/evidence/console-needs-you"
[ -d "$from" ] || { echo "no screenshots in $from: run make e2e first" >&2; exit 1; }
mkdir -p "$to"
cp "$from"/*.png "$to"/
find "$to" -name '*.png' | wc -l | xargs echo "screenshots in docs/evidence/console-needs-you:"
