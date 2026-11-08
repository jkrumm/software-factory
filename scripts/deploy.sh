#!/bin/bash
# software-factory deploy (`make deploy`): releases, not an in-place clone. The pattern is agent-workflows' own.
#
#   ~/.software-factory/repo               the clone; fetch only, nothing runs from it
#   ~/.software-factory/releases/<sha>     one immutable export of a commit with its own node_modules
#   ~/.software-factory/current            symlink to the live release (the CLI link goes through it)
#   ~/.software-factory/data/{deployed,previous}-sha
#
# The live release is never written to: a new release is exported and installed beside it, the LaunchAgent is
# switched to it, and /health must report its sha. If it never does, the previous release is booted again (rollback)
# and the deploy exits 1. The plist points at the release path, not at `current`: the plist is then the single
# statement of what runs, and a swap of the symlink can never change a running server's code underneath it.
#
# The factory door (apps/door, its own LaunchAgent) is installed and restarted from the same release directory once the
# server is healthy. It never fails the deploy: a door that cannot start (no tokens file yet) is a warning here and a failed
# line in `make verify`, and the server it files into is untouched.
#
# `make rollback` (`deploy.sh rollback`) swaps back to the previous release (data/previous-sha) with the same steps as a deploy's switch:
# the plist, the service, /health at the old sha, then `current`, the CLI link, deployed-sha, the door. The two shas trade places, so a
# second rollback swaps forward again. Nothing is fetched or built: the previous release is on disk or the rollback is refused.
#
# A release is either core: the new one (apps/server, apps/door, apps/cli) or the old one, whose source is gone from master: its
# built release stays pinned in data/keep-releases until the day-7 burn-in report, so `make rollback` still returns to it. Every step asks
# the release which core it is, so one script deploys the new core and rolls back onto the old.
#
# DRY_RUN=1 prints the plan and the rendered plist and touches nothing (no fetch, no launchd, no ~/.local/bin).
#
# Everything lives inside `main`, called on the last line when the file is run (not when it is sourced): this file is
# tracked in the repo the deploy exports. After the release is built `main` re-executes that release's copy once
# (pinned to the same sha), so the orchestration that runs matches the code being deployed.

set -u

LABEL="com.jkrumm.software-factory"
PORT=7793
DOOR_LABEL="com.jkrumm.factory-door"
DOOR_PORT=8796
# The Console is the server's second loopback listener (FACTORY_CONSOLE_PORT, default 7795); dotfiles-private's serve row publishes it on the tailnet, not this script.
DOOR_PLIST="$HOME/Library/LaunchAgents/$DOOR_LABEL.plist"
# The door answers within a second or two when it can start at all.
DOOR_WAIT_SECS="${DOOR_WAIT_SECS:-20}"
# The branch to deploy: master, or another branch to prove a change live before it is merged (FACTORY_REF=<branch>).
REF="${FACTORY_REF:-master}"
[[ "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || { echo "FACTORY_REF is not a plain branch name: $REF" >&2; exit 1; }
ROOT="${FACTORY_ROOT:-$HOME/.software-factory}"
REPO_DIR="$ROOT/repo"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
DATA_DIR="$ROOT/data"
SHA_FILE="$DATA_DIR/deployed-sha"
PREV_FILE="$DATA_DIR/previous-sha"
# Releases never pruned, one sha per line: the cutover pins the old core's release here, so the way back always has it.
KEEP_FILE="$DATA_DIR/keep-releases"
KEEP_RELEASES=3
BIN_DIR="$HOME/.local/bin"
CLI_LINK="$BIN_DIR/factory"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HEALTH_URL="http://127.0.0.1:$PORT/health"
# A cold start migrates the schema first: 60 s is generous.
HEALTH_WAIT_SECS="${HEALTH_WAIT_SECS:-60}"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SELF_DIR="$(dirname "$SELF")"
LOCK="$DATA_DIR/deploy.lock"
DRY_RUN="${DRY_RUN:-}"
# Set once this deploy has written the plist, so a rollback removes only what it wrote.
RENDERED_SHA=""

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

log() { echo "[deploy] $*"; }
die() { echo "[deploy] ERROR: $*" >&2; exit 1; }

# Print an action in a dry run, run it otherwise.
act() {
  if [[ -n "$DRY_RUN" ]]; then echo "[dry-run] would run: $*"; return 0; fi
  "$@"
}

read_sha() { [[ -f "$1" ]] && tr -d '[:space:]' < "$1"; }

# Atomic: a reader must never see a partial file.
write_atomic() { # $1 path, $2 content
  local tmp="$1.tmp.$$"
  printf '%s\n' "$2" > "$tmp" && mv -f "$tmp" "$1"
}

# The dotfiles heartbeat pages on every restart of a KeepAlive job; one epoch line marks this one deliberate.
# Best-effort: a failed write costs a false page, never a deploy.
mark_deliberate_restart() { # $1 label (default: the server's)
  local dir="$HOME/.local/state/devhost/deliberate-restart"
  { mkdir -p "$dir" && date +%s >> "$dir/${1:-$LABEL}"; } 2>/dev/null || true
}

render_plist() { # $1 template, $2 release dir, $3 sha -> stdout
  /usr/bin/sed -e "s|__HOME__|$HOME|g" -e "s|__RELEASE_DIR__|$2|g" -e "s|__SHA__|$3|g" "$1"
}

template_of() { echo "$1/deploy/$LABEL.plist.template"; } # $1 release dir
door_template_of() { echo "$1/deploy/$DOOR_LABEL.plist.template"; } # $1 release dir

# Which core a release holds, and where its CLI is (the new core's is apps/cli, the old one's packages/cli).
core_of() { if [[ -f "$1/apps/server/src/main.ts" ]]; then echo "new core (apps/server)"; else echo "old core"; fi; } # $1 release dir
cli_of() { if [[ -f "$1/apps/cli/bin/factory.ts" ]]; then echo "apps/cli/bin/factory.ts"; else echo "packages/cli/bin/factory.ts"; fi; } # $1 release dir

# Which door a release holds, and what its launcher needs. A door is the release's own: the new core's (apps/door) posts to the
# server's HTTP API with FACTORY_DOOR_TOKEN, resolved from the release's .env.door.tpl; the old core's posts to the
# server's hook socket and holds no secret. Both read the tokens file of their sources. The 401 of an unauthenticated POST is the
# same from either, so it proves a door is up, never which one: `door_runs_from` reads that from launchd.
door_of() { if [[ -f "$1/apps/door/src/main.ts" ]]; then echo "new door (apps/door)"; else echo "old door"; fi; } # $1 release dir
door_needs_secret() { grep -qs '\.env\.door\.tpl' "$1/scripts/launch-door.sh"; } # $1 release dir: does its launcher resolve a template
door_credentials() { # $1 release dir
  if door_needs_secret "$1"; then echo "FACTORY_DOOR_TOKEN from its .env.door.tpl, and the tokens file"; else echo "none (the tokens file only)"; fi
}
door_plan() { # $1 release dir, $2 sha: the one line that says which door starts
  log "door: $(door_of "$1") from ${2:0:12}, launcher $1/scripts/launch-door.sh, credentials: $(door_credentials "$1")"
}
# The launcher the loaded door job runs ("" = not loaded).
door_runs_from() {
  launchctl print "gui/$(id -u)/$DOOR_LABEL" 2>/dev/null | awk '/arguments = \{/ { f = 1; next } f && /launch-door\.sh/ { print $1; exit }'
}

tail_logs() {
  local f
  for f in "$HOME/Library/Logs/software-factory.err.log" "$HOME/Library/Logs/software-factory.out.log"; do
    if [[ -f "$f" ]]; then echo "--- tail -n 40 $f" >&2; tail -n 40 "$f" >&2; fi
  done
}

loaded() { launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }

# SIGTERM shutdown may take up to the plist's ExitTimeOut before launchd kills the process: wait that long and a bit.
unload_wait_secs() { # $1 plist or template
  local t
  t=$(plutil -extract ExitTimeOut raw -o - "$1" 2>/dev/null)
  echo $(( ${t:-120} + 10 ))
}

# The pid launchd runs for the service and everything below it ("" = not running). launchd runs the secrets-run wrapper and
# the server is its child: the wrapper can end (and launchd drop the job) while the server is still in its SIGTERM
# shutdown, holding the database lock.
service_pids() {
  local root child
  root=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }')
  [[ -n "$root" ]] || return 0
  echo "$root"
  for child in $(pgrep -P "$root" 2>/dev/null); do
    echo "$child"
    pgrep -P "$child" 2>/dev/null
  done
}

any_alive() { # $@ pids
  local p
  for p in "$@"; do kill -0 "$p" 2>/dev/null && return 0; done
  return 1
}

# Waits until the service is unloaded AND every process it ran is gone, so the next server finds the lock free.
stop_service() { # $1 max seconds to wait
  local pids i=0
  loaded || return 0
  # shellcheck disable=SC2207
  pids=($(service_pids))
  mark_deliberate_restart
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  while (( i < $1 )); do
    if ! loaded && ! any_alive "${pids[@]:-}"; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

start_service() { # $1 release dir, $2 sha
  local tmp="$PLIST.tmp.$$"
  if ! { render_plist "$(template_of "$1")" "$1" "$2" > "$tmp" && plutil -lint "$tmp" >/dev/null; }; then
    echo "[deploy] ERROR: rendering the plist failed ($tmp)" >&2
    return 1
  fi
  mv -f "$tmp" "$PLIST" || return 1
  RENDERED_SHA="$2"
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
}

# The server answers /health with its version (FACTORY_VERSION = the sha it was started for); only that counts.
is_healthy() { # $1 sha
  local body
  body=$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null) \
    && [[ "$(printf '%s' "$body" | jq -r '.status + " " + .version' 2>/dev/null)" == "ok $1" ]]
}

wait_healthy() { # $1 sha
  local i=0
  while (( i < HEALTH_WAIT_SECS )); do
    is_healthy "$1" && return 0
    sleep 1; i=$((i + 1))
  done
  echo "[deploy] not healthy at ${1:0:12}" >&2
  return 1
}

is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

# The only place a release is deleted: the name must be a full sha, and both path parts are guarded against empty.
remove_release() { # $1 sha
  is_sha "$1" || die "refusing to remove '$1': not a 40-hex sha"
  rm -rf "${RELEASES:?}/${1:?}"
}

# Exports a commit and installs its dependencies beside the live release. A release with a `.complete` marker is
# reused untouched (a redeploy, a rollback target); anything else is a leftover of a failed build and is exported
# again from nothing. The marker is written last, so a half-built release can never be started.
build_release() { # $1 sha
  is_sha "$1" || die "'$1' is not a 40-hex sha"
  local dir="$RELEASES/$1"
  if [[ -f "$dir/.complete" ]]; then touch "$dir"; return 0; fi
  if [[ -e "$dir" ]]; then remove_release "$1"; fi
  mkdir -p "$dir"
  git -C "$REPO_DIR" archive --format=tar "$1" | tar -x -C "$dir" || { remove_release "$1"; die "exporting $1 failed"; }
  (cd "$dir" && bun install --frozen-lockfile) || { remove_release "$1"; die "bun install failed; the live release is untouched"; }
  build_console "$1" || { remove_release "$1"; die "the Console build failed; the live release is untouched"; }
  chmod +x "$dir"/scripts/*.sh "$dir/$(cli_of "$dir")"
  touch "$dir/.complete"
}

# Builds the Console (apps/console) inside a release. A release without the app has nothing to build; a build that is there
# already is kept. Returns 1 when the build fails: the caller decides what that removes.
build_console() { # $1 sha
  local dir="$RELEASES/$1"
  [[ -f "$dir/apps/console/package.json" ]] || return 0
  [[ -f "$dir/apps/console/dist/index.html" ]] && return 0
  log "building the Console of ${1:0:12}"
  (cd "$dir" && bun run --cwd apps/console build)
}

# Keeps the newest $KEEP_RELEASES completed releases plus the ones named in the arguments; removes older ones.
# Only entries named like a sha are considered (anything else in releases/ is left alone).
prune_releases() { # $@ shas never to remove
  local n=0 d keep k
  while IFS= read -r d; do
    is_sha "$d" || continue
    [[ -f "$RELEASES/$d/.complete" ]] || continue
    n=$((n + 1))
    (( n <= KEEP_RELEASES )) && continue
    keep=""
    for k in "$@"; do [[ "$k" == "$d" ]] && keep=1; done
    [[ -n "$keep" ]] && continue
    log "pruning release ${d:0:12}"
    remove_release "$d"
  done < <(ls -1t "$RELEASES" 2>/dev/null)
}

# A service left booted out must not come back at the next login (RunAtLoad) on a release that failed: the plist goes,
# but only one this deploy rendered for that failed sha.
remove_failed_plist() { # $1 failed sha
  [[ "$RENDERED_SHA" == "$1" ]] || return 0
  rm -f "$PLIST" && echo "[deploy] removed $PLIST (the service stays down)" >&2
}

# The new build never became healthy: say so with the log tails, then put the previous release back.
roll_back() { # $1 failed sha, $2 previous sha ("" = none), $3 unload wait, $4 live sha ("" = none)
  echo "[deploy] ERROR: ${1:0:12} did not become healthy within ${HEALTH_WAIT_SECS}s" >&2
  tail_logs
  if ! stop_service "$3"; then echo "[deploy] WARNING: could not unload the service" >&2; fi
  if [[ -z "$2" ]]; then
    if [[ -n "$4" && "$4" == "$1" ]]; then
      # A redeploy of the live sha: same release, so the plist on disk is the live one. Start it once more.
      echo "[deploy] redeploy of the live sha ${1:0:12}: starting again from its plist" >&2
      [[ -f "$PLIST" ]] && launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null
      if wait_healthy "$1" >/dev/null 2>&1; then
        echo "[deploy] ${1:0:12} is up again. deployed-sha unchanged." >&2
      else
        echo "[deploy] ${1:0:12} is still not healthy. deployed-sha unchanged." >&2
      fi
      return 0
    fi
    remove_failed_plist "$1"
    echo "[deploy] no previous release (first deploy): left booted out so KeepAlive does not loop a failing launch. deployed-sha unchanged." >&2
    return 0
  fi
  echo "[deploy] rolling back to ${2:0:12}" >&2
  if [[ ! -f "$(template_of "$RELEASES/$2")" ]]; then
    echo "[deploy] ${2:0:12} has no plist template: left booted out" >&2
    remove_failed_plist "$1"
    return 0
  fi
  if start_service "$RELEASES/$2" "$2" && wait_healthy "$2"; then
    echo "[deploy] rollback OK: ${2:0:12} is healthy again. deployed-sha unchanged." >&2
  else
    stop_service "$3"
    # The plist on disk is the one of whichever release was rendered last; with RunAtLoad it would start that release at
    # the next login. Remove it (each call matches only a plist this deploy rendered).
    remove_failed_plist "$2"
    remove_failed_plist "$1"
    echo "[deploy] ROLLBACK FAILED: ${2:0:12} did not become healthy either; left booted out, plist removed." >&2
  fi
}

# The door's health is its 401: an unauthenticated POST is refused by a door that is up, whatever its tokens are.
door_answers() {
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 -X POST -H 'x-factory-probe: 1' -H 'content-type: application/json' -d '{}' \
    "http://127.0.0.1:$DOOR_PORT/alert/kuma" 2>/dev/null)" == "401" ]]
}

# Installs the door from the release and restarts it. Never fails the deploy: it says why the door is not up and goes on.
deploy_door() { # $1 release dir, $2 sha
  local template tmp i=0
  template=$(door_template_of "$1")
  if [[ ! -f "$template" ]]; then log "WARNING: $template missing: the door is left as it is"; return 0; fi
  door_plan "$1" "$2"
  if door_needs_secret "$1"; then
    if [[ ! -f "$1/.env.door.tpl" ]]; then
      log "WARNING: $1/.env.door.tpl is missing: the door cannot start"
    else
      local key ref
      while IFS='=' read -r key ref; do
        secrets-run read "$ref" >/dev/null 2>&1 || log "WARNING: the door's $key ($ref) does not resolve through secrets-run: the door will not start"
      done < <(grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=op://[^[:space:]]+' "$1/.env.door.tpl")
    fi
  fi
  tmp="$DOOR_PLIST.tmp.$$"
  if ! { render_plist "$template" "$1" "$2" > "$tmp" && plutil -lint "$tmp" >/dev/null; }; then
    rm -f "$tmp"; log "WARNING: rendering the door's plist failed: the door is left as it is"; return 0
  fi
  if launchctl print "gui/$(id -u)/$DOOR_LABEL" >/dev/null 2>&1; then
    mark_deliberate_restart "$DOOR_LABEL"
    launchctl bootout "gui/$(id -u)/$DOOR_LABEL" 2>/dev/null
    while (( i < 15 )) && launchctl print "gui/$(id -u)/$DOOR_LABEL" >/dev/null 2>&1; do sleep 1; i=$((i + 1)); done
  fi
  mv -f "$tmp" "$DOOR_PLIST" || { log "WARNING: cannot write $DOOR_PLIST"; return 0; }
  launchctl bootstrap "gui/$(id -u)" "$DOOR_PLIST" || { log "WARNING: launchctl bootstrap of the door failed"; return 0; }
  i=0
  while (( i < DOOR_WAIT_SECS )); do
    if door_answers; then
      if [[ "$(door_runs_from)" == "$1/scripts/launch-door.sh" ]]; then
        log "door OK: the $(door_of "$1") of ${2:0:12} answers on 127.0.0.1:$DOOR_PORT (401 to an unauthenticated POST)"
      else
        log "WARNING: a door answers on 127.0.0.1:$DOOR_PORT but launchd runs '$(door_runs_from)', not $1/scripts/launch-door.sh: read launchctl print gui/$(id -u)/$DOOR_LABEL"
      fi
      return 0
    fi
    sleep 1; i=$((i + 1))
  done
  log "WARNING: the door does not answer on 127.0.0.1:$DOOR_PORT after ${DOOR_WAIT_SECS}s (make verify fails until it does; create its tokens with: factory door token new <source>)"
  local f="$HOME/Library/Logs/factory-door.err.log"
  if [[ -f "$f" ]]; then echo "--- tail -n 5 $f" >&2; tail -n 5 "$f" >&2; fi
  return 0
}

# Every ref of .env.tpl must resolve before anything is stopped: a missing secret refuses the deploy, never a rollback.
# The refs of .env.server.tpl are optional: an unresolved one is a warning.
check_refs() { # $1 release dir
  local key ref missing=""
  while IFS='=' read -r key ref; do
    secrets-run read "$ref" >/dev/null 2>&1 || missing="$missing $key($ref)"
  done < <(grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=op://[^[:space:]]+' "$1/.env.tpl")
  if [[ -f "$1/.env.server.tpl" ]]; then
    while IFS='=' read -r key ref; do
      secrets-run read "$ref" >/dev/null 2>&1 || log "WARNING: optional $key ($ref) does not resolve: the server starts without it"
    done < <(grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=op://[^[:space:]]+' "$1/.env.server.tpl")
  fi
  [[ -z "$missing" ]] || die "cannot read${missing} through secrets-run (seed them: make secrets-seed on the MacBook); nothing was changed"
}

# The settings file (~/.config/factory/env) must be accepted by the release about to start: each release's launcher refuses a key its
# own allow-list lacks (exit 78), and a refused start loops under KeepAlive. Checked before anything is stopped.
env_file_ok() { # $1 release dir
  local file="${FACTORY_ENV_FILE:-$HOME/.config/factory/env}" out
  [[ -f "$1/scripts/env-file.sh" ]] || return 0
  out=$( (source "$1/scripts/env-file.sh" && load_env_file "$file") 2>&1 ) && return 0
  echo "$out" >&2
  return 1
}

# The lock is a symlink whose target is the holder's pid: `ln -s` creates it atomically with the pid in place, so there is
# no window in which the lock exists without a holder. FAIL CLOSED: a lock that cannot be read or created refuses the
# deploy; only a lock whose holder is a dead pid is reclaimed, and one reclaimer at a time (`$LOCK.reclaim`).
# A directory lock with a `pid` file (the previous version's) is read the same way.
lock_holder() {
  if [[ -L "$LOCK" ]]; then readlink "$LOCK" 2>/dev/null
  elif [[ -d "$LOCK" ]]; then cat "$LOCK/pid" 2>/dev/null
  fi
  return 0
}

release_lock() {
  [[ "$(lock_holder)" == "$$" ]] || return 0
  rm -rf "$LOCK"
}

# Exits through `die` unless this process holds the lock when it returns.
take_lock() {
  local holder
  if ln -s "$$" "$LOCK" 2>/dev/null; then
    if [[ -L "$LOCK" && "$(readlink "$LOCK")" == "$$" ]]; then trap release_lock EXIT; return 0; fi
    # $LOCK is a legacy directory: ln put the link inside it. Take that back and treat the lock as held.
    [[ -d "$LOCK" && ! -L "$LOCK" ]] && rm -f "$LOCK/$$"
  fi
  [[ -e "$LOCK" || -L "$LOCK" ]] || die "cannot create the deploy lock $LOCK"
  holder=$(lock_holder)
  [[ "$holder" =~ ^[0-9]+$ ]] || die "the deploy lock $LOCK cannot be read (holder: '${holder}'); not reclaiming it. Check that no deploy runs, then remove it"
  if kill -0 "$holder" 2>/dev/null; then die "another deploy is running (pid $holder)"; fi
  mkdir "$LOCK.reclaim" 2>/dev/null || die "$LOCK.reclaim exists: another deploy is reclaiming the lock, or a crashed reclaim left it; remove it by hand if no deploy runs"
  holder=$(lock_holder)
  if [[ -e "$LOCK" || -L "$LOCK" ]]; then
    if ! [[ "$holder" =~ ^[0-9]+$ ]]; then rmdir "$LOCK.reclaim"; die "the deploy lock $LOCK cannot be read (holder: '${holder}'); not reclaiming it"; fi
    if kill -0 "$holder" 2>/dev/null; then rmdir "$LOCK.reclaim"; die "another deploy is running (pid $holder)"; fi
    rm -rf "$LOCK"
  fi
  if ! ln -s "$$" "$LOCK" 2>/dev/null || [[ "$(readlink "$LOCK" 2>/dev/null)" != "$$" ]]; then
    rmdir "$LOCK.reclaim"; die "cannot take the deploy lock $LOCK"
  fi
  rmdir "$LOCK.reclaim"
  trap release_lock EXIT
}

# The release before the live one, back. Refuses (one line, exit 1) without a complete previous release on disk.
rollback() {
  local live prev release unload_secs tool
  live=$(read_sha "$SHA_FILE")
  prev=$(read_sha "$PREV_FILE")
  [[ -n "$prev" ]] || die "no previous release recorded ($PREV_FILE is missing or empty); nothing to roll back to"
  is_sha "$prev" || die "$PREV_FILE does not hold a 40-hex sha"
  release="$RELEASES/$prev"
  [[ -f "$release/.complete" ]] || die "the previous release ${prev:0:12} is not on disk ($release); nothing to roll back to"
  [[ -f "$(template_of "$release")" ]] || die "$(template_of "$release") missing: ${prev:0:12} cannot be started"
  [[ "$prev" != "$live" ]] || die "the previous release is the live one (${prev:0:12}); nothing to roll back to"
  unload_secs=$(unload_wait_secs "$(template_of "$release")")
  env_file_ok "$release" || die "the settings file is refused by ${prev:0:12}'s launcher (remove the keys it names, then roll back); nothing was changed"

  if [[ -n "$DRY_RUN" ]]; then
    log "DRY RUN: nothing is stopped, started or written"
    log "the settings file is accepted by ${prev:0:12}'s launcher"
    log "would roll back ${live:-none} ($( [[ -n "$live" && -d "$RELEASES/$live" ]] && core_of "$RELEASES/$live" || echo "release not on disk")) -> ${prev:0:12} ($(core_of "$release")), release $release"
    log "rendered $PLIST (points at the release, not at current):"
    render_plist "$(template_of "$release")" "$release" "$prev"
    act "launchctl bootout $LABEL, wait up to ${unload_secs}s for the unload"
    act launchctl bootstrap "gui/$(id -u)" "$PLIST"
    act "wait up to ${HEALTH_WAIT_SECS}s for $HEALTH_URL = ok, version $prev"
    act "on failure: boot ${live:-none} again, exit 1"
    act ln -sfn "$release" "$CURRENT"
    act ln -sf "$CURRENT/$(cli_of "$release")" "$CLI_LINK"
    act "write $SHA_FILE ($prev) and $PREV_FILE (${live:-none}): the two trade places"
    log "rendered $DOOR_PLIST (the door of the $(core_of "$release"), from the previous release):"
    render_plist "$(door_template_of "$release")" "$release" "$prev"
    door_plan "$release" "$prev"
    act "launchctl bootout $DOOR_LABEL if loaded, then bootstrap it from $release (the door of the $(core_of "$release"))"
    return 0
  fi

  for tool in curl jq launchctl plutil; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
  done
  if [[ -e "$CLI_LINK" && ! -L "$CLI_LINK" ]]; then die "$CLI_LINK is a regular file; refusing to replace it"; fi
  if [[ -e "$CURRENT" && ! -L "$CURRENT" ]]; then die "$CURRENT exists and is not a symlink; remove it, then roll back again"; fi

  # one deploy or rollback at a time
  mkdir -p "$DATA_DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$BIN_DIR"
  take_lock

  log "rolling back ${live:-none} -> ${prev:0:12} ($(core_of "$release")), stopping the service"
  stop_service "$unload_secs" || die "still loaded ${unload_secs}s after bootout; not bootstrapping over it. Retry the rollback."
  if start_service "$release" "$prev" && wait_healthy "$prev"; then
    ln -sfn "$release" "$CURRENT" || die "updating $CURRENT failed"
    ln -sf "$CURRENT/$(cli_of "$release")" "$CLI_LINK" || die "linking $CLI_LINK failed"
    [[ -z "$live" ]] || write_atomic "$PREV_FILE" "$live"
    write_atomic "$SHA_FILE" "$prev" || die "writing $SHA_FILE failed"
    deploy_door "$release" "$prev"
    log "rollback OK: ${prev:0:12} ($(core_of "$release")) healthy; factory -> $CLI_LINK"
    return 0
  fi
  echo "[deploy] ERROR: ${prev:0:12} did not become healthy within ${HEALTH_WAIT_SECS}s" >&2
  tail_logs
  stop_service "$unload_secs" || echo "[deploy] WARNING: could not unload the service" >&2
  if [[ -n "$live" && -f "$(template_of "$RELEASES/$live")" ]] && start_service "$RELEASES/$live" "$live" && wait_healthy "$live"; then
    echo "[deploy] ROLLBACK FAILED: ${live:0:12} is running again. deployed-sha unchanged." >&2
  else
    stop_service "$unload_secs" || true
    remove_failed_plist "$prev"
    [[ -z "$live" ]] || remove_failed_plist "$live"
    echo "[deploy] ROLLBACK FAILED: neither ${prev:0:12} nor the live release became healthy; left booted out, plist removed." >&2
  fi
  return 1
}

main() {
  if [[ "${1:-}" == "rollback" ]]; then rollback; return; fi
  local repo_url sha old prev="" release unload_secs tool

  # --- preflight: everything that can refuse does so before anything is built, stopped or written
  for tool in git bun curl jq secrets-run launchctl plutil tar; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
  done
  if [[ -e "$CLI_LINK" && ! -L "$CLI_LINK" ]]; then
    die "$CLI_LINK is a regular file; refusing to replace it (remove it, then deploy again)"
  fi
  if [[ -e "$CURRENT" && ! -L "$CURRENT" ]]; then
    die "$CURRENT exists and is not a symlink; remove it, then deploy again"
  fi
  repo_url="${FACTORY_REPO_URL:-$(git -C "$SELF_DIR" remote get-url origin 2>/dev/null)}"

  if [[ -n "$DRY_RUN" ]]; then
    old=$(read_sha "$SHA_FILE")
    sha=$(git -C "$SELF_DIR" rev-parse "origin/$REF" 2>/dev/null) || sha="<origin/$REF>"
    log "DRY RUN: nothing is fetched, stopped, started or written"
    log "would deploy ${sha:0:12} ($(core_of "$SELF_DIR/..")) (live: ${old:-none}$( [[ -n "$old" && -d "$RELEASES/$old" ]] && echo ", $(core_of "$RELEASES/$old")")) from ${repo_url:-<no origin url>}"
    act git -C "$REPO_DIR" fetch --prune origin "$REF"
    act "export $sha to $RELEASES/$sha and bun install --frozen-lockfile there"
    act "build the Console there (bun run --cwd apps/console build); a failed build removes the release and stops the deploy, the live release untouched"
    act "check every ref of .env.tpl through secrets-run (those of .env.server.tpl only warn)"
    if env_file_ok "$SELF_DIR/.."; then log "the settings file is accepted by the launcher of this tree"; else log "WARNING: the settings file is refused by the launcher of this tree (a real deploy stops before it changes anything)"; fi
    log "rendered $PLIST (points at the release, not at current):"
    render_plist "$(template_of "$SELF_DIR/..")" "$RELEASES/$sha" "$sha"
    act "launchctl bootout $LABEL, wait up to $(unload_wait_secs "$(template_of "$SELF_DIR/..")")s for the unload"
    act launchctl bootstrap "gui/$(id -u)" "$PLIST"
    act "wait up to ${HEALTH_WAIT_SECS}s for $HEALTH_URL = ok, version $sha"
    act "on failure: print the log tails, boot the previous release again (${old:-none}), exit 1"
    act ln -sfn "$RELEASES/$sha" "$CURRENT"
    act ln -sf "$CURRENT/$(cli_of "$SELF_DIR/..")" "$CLI_LINK"
    act "write $SHA_FILE ($sha) and $PREV_FILE (${old:-none})"
    log "rendered $DOOR_PLIST (the door of the $(core_of "$SELF_DIR/.."), from the same release):"
    render_plist "$(door_template_of "$SELF_DIR/..")" "$RELEASES/$sha" "$sha"
    door_plan "$SELF_DIR/.." "$sha"
    act "launchctl bootout $DOOR_LABEL if loaded, then launchctl bootstrap it"
    act "wait up to ${DOOR_WAIT_SECS}s for an unauthenticated POST to 127.0.0.1:$DOOR_PORT/alert/kuma to answer 401; a door that does not start (no tokens file) is a warning, never a failed deploy"
    act "prune releases beyond the newest $KEEP_RELEASES"
    return 0
  fi

  # --- one deploy at a time
  mkdir -p "$DATA_DIR" "$RELEASES" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$BIN_DIR"
  # The re-executed copy is the same process (exec keeps the pid), so it inherits the lock instead of taking it.
  if [[ -n "${FACTORY_DEPLOY_REEXEC:-}" && "$(lock_holder)" == "$$" ]]; then
    trap release_lock EXIT
  else
    take_lock
  fi

  # --- the release: exported and installed beside the live one
  if [[ -z "${FACTORY_DEPLOY_SHA:-}" ]]; then
    if [[ ! -d "$REPO_DIR/.git" ]]; then
      [[ -n "$repo_url" ]] || die "no origin url (set FACTORY_REPO_URL)"
      log "cloning the repository -> $REPO_DIR"
      git clone --quiet "$repo_url" "$REPO_DIR" || die "git clone failed"
    fi
    git -C "$REPO_DIR" fetch --quiet --prune origin "$REF" || die "git fetch origin $REF failed (network or credential helper)"
    sha=$(git -C "$REPO_DIR" rev-parse FETCH_HEAD)
  else
    sha="$FACTORY_DEPLOY_SHA"
  fi
  release="$RELEASES/$sha"
  log "building release ${sha:0:12}"
  build_release "$sha"

  # Continue with the release's own copy of this script, once.
  if [[ -z "${FACTORY_DEPLOY_REEXEC:-}" && "$SELF" != "$release/scripts/deploy.sh" ]]; then
    trap - EXIT
    FACTORY_DEPLOY_REEXEC=1 FACTORY_DEPLOY_SHA="$sha" exec /bin/bash "$release/scripts/deploy.sh"
  fi

  # The copy that built the release may predate the Console build (the first deploy that carries it): build it here, once. A
  # release that is live already is not removed on failure.
  if ! build_console "$sha"; then
    [[ "$(read_sha "$SHA_FILE")" == "$sha" ]] || remove_release "$sha"
    die "the Console build failed; the live release is untouched"
  fi
  [[ -f "$(template_of "$release")" ]] || die "$(template_of "$release") missing"
  check_refs "$release"
  env_file_ok "$release" || die "the settings file is refused by ${sha:0:12}'s launcher (remove or rename the keys it names); nothing was changed"
  unload_secs=$(unload_wait_secs "$(template_of "$release")")

  # The release that is live now is the rollback target, unless it is the one being deployed again.
  old=$(read_sha "$SHA_FILE")
  if [[ -n "$old" && "$old" != "$sha" && -f "$RELEASES/$old/.complete" ]]; then prev="$old"; fi

  # --- switch
  log "deploying ${sha:0:12} ($(core_of "$release")) (live: ${old:-none}), stopping the service"
  stop_service "$unload_secs" || die "still loaded ${unload_secs}s after bootout (ExitTimeOut + 10); not bootstrapping over it. It may still be shutting down: retry the deploy."
  if ! start_service "$release" "$sha"; then
    echo "[deploy] ERROR: launchctl bootstrap failed at ${sha:0:12}" >&2
    roll_back "$sha" "$prev" "$unload_secs" "$old"
    return 1
  fi
  log "waiting up to ${HEALTH_WAIT_SECS}s for $HEALTH_URL (version ${sha:0:12})"
  if ! wait_healthy "$sha"; then
    roll_back "$sha" "$prev" "$unload_secs" "$old"
    return 1
  fi

  # --- healthy: current, the CLI, then the marker ("deployed" means the CLI is usable too)
  ln -sfn "$release" "$CURRENT" || die "updating $CURRENT failed"
  if [[ -n "$old" && "$old" != "$sha" ]]; then write_atomic "$PREV_FILE" "$old"; fi
  ln -sf "$CURRENT/$(cli_of "$release")" "$CLI_LINK" || die "linking $CLI_LINK failed"
  write_atomic "$SHA_FILE" "$sha" || die "writing $SHA_FILE failed"
  deploy_door "$release" "$sha"
  local pinned=() k
  [[ -f "$KEEP_FILE" ]] && while IFS= read -r k; do is_sha "$k" && pinned+=("$k"); done <"$KEEP_FILE"
  prune_releases "$sha" "$(read_sha "$PREV_FILE")" ${pinned[@]+"${pinned[@]}"}
  log "deploy OK: ${sha:0:12} ($(core_of "$release")) healthy; factory -> $CLI_LINK"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
