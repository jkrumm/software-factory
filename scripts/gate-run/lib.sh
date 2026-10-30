#!/usr/bin/env bash
# Shared by the gate-run scripts. Sourced, not run.
# shellcheck disable=SC2034
set -euo pipefail

GATE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$GATE_DIR/../.." && pwd)
SOURCE_ROOT=${GATE_SOURCE_ROOT:-$HOME/SourceRoot}
REMOTES=${GATE_REMOTES:-$HOME/.local/share/factory/gate-remotes}
EVIDENCE=${GATE_EVIDENCE:-$ROOT/docs/evidence/f1-gate-run}
CHAINS=(factory-gate-a factory-gate-b)

# The factory CLI with the token resolved at run time (never in a tracked file).
fx() { secrets-run run --env-file="$ROOT/.env.tpl" -- factory "$@"; }

# Absolute time, UTC, the way the factory stamps events.
now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Keep evidence free of the home directory.
scrub() { sed "s|$HOME|~|g"; }

log() { printf '%s %s\n' "$(now_utc)" "$*" | scrub | tee -a "$EVIDENCE/log.txt"; }
