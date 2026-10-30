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
# DRY_RUN=1 prints the plan and the rendered plist and touches nothing (no fetch, no launchd, no ~/.local/bin).
#
# Everything lives inside `main`, called on the last line when the file is run (not when it is sourced): this file is
# tracked in the repo the deploy exports. After the release is built `main` re-executes that release's copy once
# (pinned to the same sha), so the orchestration that runs matches the code being deployed.

set -u

LABEL="com.jkrumm.software-factory"
PORT=7793
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
mark_deliberate_restart() {
  local dir="$HOME/.local/state/devhost/deliberate-restart"
  { mkdir -p "$dir" && date +%s >> "$dir/$LABEL"; } 2>/dev/null || true
}

render_plist() { # $1 template, $2 release dir, $3 sha -> stdout
  /usr/bin/sed -e "s|__HOME__|$HOME|g" -e "s|__RELEASE_DIR__|$2|g" -e "s|__SHA__|$3|g" "$1"
}

template_of() { echo "$1/deploy/$LABEL.plist.template"; } # $1 release dir

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

stop_service() { # $1 max seconds to wait for the unload
  loaded || return 0
  mark_deliberate_restart
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  local i=0
  while (( i < $1 )) && loaded; do sleep 1; i=$((i + 1)); done
  ! loaded
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
  chmod +x "$dir"/scripts/*.sh "$dir/packages/cli/bin/factory.ts"
  touch "$dir/.complete"
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

# Every ref of .env.tpl must resolve before anything is stopped: a missing secret refuses the deploy, never a rollback.
check_refs() { # $1 release dir
  local key ref missing=""
  while IFS='=' read -r key ref; do
    secrets-run read "$ref" >/dev/null 2>&1 || missing="$missing $key($ref)"
  done < <(grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=op://[^[:space:]]+' "$1/.env.tpl")
  [[ -z "$missing" ]] || die "cannot read${missing} through secrets-run (seed them: make secrets-seed on the MacBook); nothing was changed"
}

main() {
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
    log "would deploy ${sha:0:12} (live: ${old:-none}) from ${repo_url:-<no origin url>}"
    act git -C "$REPO_DIR" fetch --prune origin "$REF"
    act "export $sha to $RELEASES/$sha and bun install --frozen-lockfile there"
    act "check every ref of .env.tpl through secrets-run"
    log "rendered $PLIST (points at the release, not at current):"
    render_plist "$(template_of "$SELF_DIR/..")" "$RELEASES/$sha" "$sha"
    act "launchctl bootout $LABEL, wait up to $(unload_wait_secs "$(template_of "$SELF_DIR/..")")s for the unload"
    act launchctl bootstrap "gui/$(id -u)" "$PLIST"
    act "wait up to ${HEALTH_WAIT_SECS}s for $HEALTH_URL = ok, version $sha"
    act "on failure: print the log tails, boot the previous release again (${old:-none}), exit 1"
    act ln -sfn "$RELEASES/$sha" "$CURRENT"
    act ln -sf "$CURRENT/packages/cli/bin/factory.ts" "$CLI_LINK"
    act "write $SHA_FILE ($sha) and $PREV_FILE (${old:-none})"
    act "prune releases beyond the newest $KEEP_RELEASES"
    return 0
  fi

  # --- one deploy at a time
  mkdir -p "$DATA_DIR" "$RELEASES" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$BIN_DIR"
  # The re-executed copy is the same process (exec keeps the pid), so it inherits the lock instead of taking it.
  if [[ -n "${FACTORY_DEPLOY_REEXEC:-}" && "$(cat "$LOCK/pid" 2>/dev/null)" == "$$" ]]; then
    :
  elif ! mkdir "$LOCK" 2>/dev/null; then
    local holder
    holder=$(cat "$LOCK/pid" 2>/dev/null)
    if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then die "another deploy is running (pid $holder)"; fi
    rm -rf "$LOCK"; mkdir "$LOCK" || die "cannot take $LOCK"
  fi
  echo $$ > "$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT

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

  [[ -f "$(template_of "$release")" ]] || die "$(template_of "$release") missing"
  check_refs "$release"
  unload_secs=$(unload_wait_secs "$(template_of "$release")")

  # The release that is live now is the rollback target, unless it is the one being deployed again.
  old=$(read_sha "$SHA_FILE")
  if [[ -n "$old" && "$old" != "$sha" && -f "$RELEASES/$old/.complete" ]]; then prev="$old"; fi

  # --- switch
  log "deploying ${sha:0:12} (live: ${old:-none}), stopping the service"
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
  ln -sf "$CURRENT/packages/cli/bin/factory.ts" "$CLI_LINK" || die "linking $CLI_LINK failed"
  write_atomic "$SHA_FILE" "$sha" || die "writing $SHA_FILE failed"
  prune_releases "$sha" "$(read_sha "$PREV_FILE")"
  log "deploy OK: ${sha:0:12} healthy; factory -> $CLI_LINK"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
