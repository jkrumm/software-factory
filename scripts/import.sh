#!/bin/bash
# The cutover's import as a window runs it (docs/rewrite/cutover-runbook.md): the importer from the deployed release, with the
# database credential resolved the way launch.sh does and the same settings file (FACTORY_DATA_DIR decides where the Decisions'
# forms are written, as it does for the server). Arguments go to the importer: none imports, --compare compares, --help says more.
# Usage: bash ~/.software-factory/current/scripts/import.sh [--compare] [--legacy-schema factory_legacy]

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || { echo "import: cannot cd to $DIR" >&2; exit 78; }

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SECRETS_RUN="$HOME/.local/bin/secrets-run"
[[ -x "$SECRETS_RUN" ]] || { echo "import: $SECRETS_RUN missing" >&2; exit 78; }
command -v bun >/dev/null 2>&1 || { echo "import: bun not on PATH" >&2; exit 78; }

# shellcheck source=scripts/env-file.sh
source "$DIR/scripts/env-file.sh"
load_env_file "${FACTORY_ENV_FILE:-$HOME/.config/factory/env}" || exit 78

TPL="$DIR/.env.tpl"

# shellcheck disable=SC2016 # the child script is single-quoted on purpose
exec "$SECRETS_RUN" run --env-file="$TPL" -- /bin/sh -c '
  case "${FACTORY_DB_PASSWORD:-}" in
    "" | *[!0-9a-f]*) echo "import: FACTORY_DB_PASSWORD is empty or not hex; refusing to run." >&2; exit 78 ;;
  esac
  export DATABASE_URL="postgres://factory:${FACTORY_DB_PASSWORD}@${FACTORY_DB_ADDR:-127.0.0.1:5432}/shared"
  unset FACTORY_DB_PASSWORD
  exec bun apps/server/scripts/import-legacy.ts "$@"
' sh "$@"
