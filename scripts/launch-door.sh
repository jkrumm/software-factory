#!/bin/bash
# factory door launcher: the ProgramArguments of its LaunchAgent. It holds one secret, FACTORY_DOOR_TOKEN (the bearer the server
# accepts for alerts and reports), resolved from .env.door.tpl through secrets-run, and no database credential. The sources' own
# tokens are the door's tokens file (FACTORY_DOOR_TOKENS_FILE, default ~/.config/factory/door-tokens.json, mode 0600, made by
# `factory door token new`); the door refuses to start on a missing, loose or unparsable file, or without its bearer, with the
# reason on stderr. Runs from a release (~/.software-factory/releases/<sha>, the one the plist names), never the dev checkout.

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || { echo "factory-door: cannot cd to $DIR" >&2; exit 78; }

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SECRETS_RUN="$HOME/.local/bin/secrets-run"
TPL="$DIR/.env.door.tpl"

[[ -x "$SECRETS_RUN" ]] || { echo "factory-door: $SECRETS_RUN missing" >&2; exit 78; }
[[ -f "$TPL" ]] || { echo "factory-door: $TPL missing" >&2; exit 78; }
command -v bun >/dev/null 2>&1 || { echo "factory-door: bun not on PATH" >&2; exit 78; }

exec "$SECRETS_RUN" run --env-file="$TPL" -- bun apps/door/src/main.ts
