#!/bin/bash
# software-factory launcher: the ProgramArguments of the LaunchAgent. Never point launchd at a Homebrew binary
# directly (macOS BTM silently disallows it); this wrapper is the indirection, and it fails closed (exit 78) unless
# every ref in .env.tpl resolves. Runs from a release (~/.software-factory/releases/<sha>, the one the plist names),
# never the dev checkout. No secret is printed: refs are named, values never.

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || { echo "software-factory: cannot cd to $DIR" >&2; exit 78; }

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SECRETS_RUN="$HOME/.local/bin/secrets-run"
TPL="$DIR/.env.tpl"

[[ -x "$SECRETS_RUN" ]] || { echo "software-factory: $SECRETS_RUN missing" >&2; exit 78; }
[[ -f "$TPL" ]] || { echo "software-factory: $TPL missing" >&2; exit 78; }
command -v bun >/dev/null 2>&1 || { echo "software-factory: bun not on PATH" >&2; exit 78; }

# A hung secrets-run must not hang the launch; `timeout` is a Homebrew coreutils binary, so it is optional.
# macOS /bin/bash is 3.2: under `set -u` an empty array must be expanded as ${limit[@]+"${limit[@]}"}.
limit=()
if command -v timeout >/dev/null 2>&1; then limit=(timeout 20); elif command -v gtimeout >/dev/null 2>&1; then limit=(gtimeout 20); fi

# Every ref must resolve BEFORE the hand-off: an unresolved ref would otherwise reach the process as nothing at all.
rendered=$(${limit[@]+"${limit[@]}"} "$SECRETS_RUN" export --env-file="$TPL" 2>/dev/null | grep -c '^export ')
want=$(grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=' "$TPL" | sort -u | wc -l | tr -d ' ')
if [[ -z "$rendered" || "$rendered" -lt "$want" ]]; then
  echo "software-factory: only ${rendered:-0}/$want refs of .env.tpl resolved; refusing to start." >&2
  grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=op://[^[:space:]]+' "$TPL" | while IFS='=' read -r key ref; do
    ${limit[@]+"${limit[@]}"} "$SECRETS_RUN" read "$ref" >/dev/null 2>&1 || echo "  unresolved: $key ($ref)" >&2
  done
  exit 78
fi

# A ref can resolve to an empty value; that is as unusable as a missing one. Checked inside the child, where the
# values exist: the key is named, the value never printed.
keys=$(grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=' "$TPL" | tr -d =)
# shellcheck disable=SC2016,SC2086 # the child script is single-quoted on purpose; the keys are plain identifiers
exec "$SECRETS_RUN" run --env-file="$TPL" -- /bin/sh -c '
  for key in "$@"; do
    eval "value=\${$key-}"
    [ -n "$value" ] || { echo "software-factory: $key resolved to an empty value; refusing to start." >&2; exit 78; }
  done
  exec bun packages/server/src/main.ts
' sh $keys
