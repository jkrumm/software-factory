#!/usr/bin/env bash
# Shared by the gameday scripts. Sourced, not run.
# shellcheck disable=SC2034
set -euo pipefail

GAMEDAY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$GAMEDAY_DIR/../.." && pwd)
SOURCE_ROOT=${GAMEDAY_SOURCE_ROOT:-$HOME/SourceRoot}
REMOTES=${GAMEDAY_REMOTES:-$HOME/.local/share/factory/gameday-remotes}
EVIDENCE=${GAMEDAY_EVIDENCE:-$ROOT/docs/evidence/f1-gamedays}
REPO_NAME=${GAMEDAY_REPO:-factory-gameday}
LABEL=com.jkrumm.software-factory
LOG_FILE=${GAMEDAY_SERVER_LOG:-$HOME/Library/Logs/software-factory.out.log}

# The factory CLI with the token resolved at run time (never in a tracked file).
fx() { secrets-run run --env-file="$ROOT/.env.tpl" -- factory "$@"; }

# A read-only query against the factory schema, rows as `|`-separated text. The password never leaves the child.
# shellcheck disable=SC2016 # the child script is single-quoted on purpose
db() { secrets-run run --env-file="$ROOT/.env.tpl" -- sh -c 'PGPASSWORD=$FACTORY_DB_PASSWORD exec psql -h 127.0.0.1 -U factory -d shared -At -F "|" -c "$1"' sh "$1"; }

now_utc() { perl -MTime::HiRes=time -MPOSIX=strftime -e '$t = time; printf "%s.%03dZ\n", strftime("%Y-%m-%dT%H:%M:%S", gmtime($t)), ($t - int($t)) * 1000'; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }

# Evidence carries no home directory, host name or address.
scrub() { sed -E -e "s|$HOME|~|g" -e "s|$(hostname -s)|<host>|g" -e 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/<ip>/g'; }

# `log <line>` appends to the run's timeline (TIMELINE, else the shared log) and prints it.
log() { printf '%s %s\n' "$(now_utc)" "$*" | scrub | tee -a "${TIMELINE:-$EVIDENCE/log.txt}"; }

# The LaunchAgent's own process and the server it runs: bash (secrets-run) is the job, `bun .../main.ts` its child.
job_pid() { launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3 }'; }
server_pid() {
  local job
  job=$(job_pid)
  [[ -n $job ]] || return 1
  pgrep -P "$job" -f '^bun packages/server/src/main.ts' | head -1
}

healthy() { curl -fsS --max-time 2 http://127.0.0.1:7793/health 2>/dev/null | jq -e '.status == "ok"' >/dev/null; }

# herdr's agent name for a spawn key: the key itself when it is a valid name (lowercase, [a-z0-9-], at most 32 characters).
agent_name() { printf '%s' "$1"; }
