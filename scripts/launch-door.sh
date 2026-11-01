#!/bin/bash
# factory door launcher: the ProgramArguments of its LaunchAgent. It holds no secret: the tokens file is the door's own
# (FACTORY_DOOR_TOKENS_FILE, default ~/.config/factory/door-tokens.json, mode 0600, made by `factory door token new`), and
# the door itself refuses to start on a missing, loose or unparsable file, with the reason on stderr. Runs from a release
# (~/.software-factory/releases/<sha>, the one the plist names), never the dev checkout.

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || { echo "factory-door: cannot cd to $DIR" >&2; exit 78; }

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

command -v bun >/dev/null 2>&1 || { echo "factory-door: bun not on PATH" >&2; exit 78; }

exec bun packages/door/src/main.ts
