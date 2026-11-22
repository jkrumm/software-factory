#!/bin/bash
# Sourced by launch.sh: the factory's own settings that are not secrets and not in the repo.
# ~/.config/factory/env (FACTORY_ENV_FILE) when it exists: KEY=VALUE lines only (blank lines and # comments allowed), the file mode
# 0600 and owned by the user, and only the keys below. Nothing in it is evaluated: a line is split at the first = and exported as it
# is. The whole file is checked before anything is exported. A wrong mode or owner, a line that is not KEY=VALUE, a key that is not
# listed (a secret, PATH, the port, a program the server would run, a typo) or a symlink refuses the start (exit 78): a setting that is silently ignored is worse than
# a launch that says why it will not run. Secrets stay in .env.tpl. Read at launch only: an edit takes a LaunchAgent restart.
#
# Never listed, on purpose: the tokens and DATABASE_URL (secrets), PORT and FACTORY_VERSION (the plist's), HC_BIN (the plist's) and
# FACTORY_TEST_MODE / FACTORY_TEST_CLOCK_OFFSET_MS (scenarios only; the server refuses them outside a test). The programs and paths the
# server runs and reads (FACTORY_CLAUDE_BIN, FACTORY_PRETRUST_BIN, FACTORY_SYSCTL_BIN, FACTORY_AGW_BIN, the hook
# socket and spool, the roles file, the archive; the accounts' own files are `packages/accounts`' to resolve: CLAUDE_ACCOUNTS_REGISTRY and its siblings) are listed because the reports of the rewrite name them; the file is the
# user's own, mode 0600, like the plist. A unit test (scripts/test/env-file.test.ts) fails when the server reads a setting that is on
# neither list.

EF_ALLOWED=" \
  FACTORY_AGW_BIN FACTORY_API_DETECT_MS FACTORY_API_PROBE_MS FACTORY_API_RESUME_MS FACTORY_ARCHIVE_DIR FACTORY_ARCHIVE_RETENTION_DAYS \
  FACTORY_CHECKPOINT_RECHECK_MS \
  FACTORY_CLAUDE_BIN FACTORY_CONSOLE_DIR FACTORY_CONSOLE_IMAGE_HOSTS FACTORY_CONSOLE_PORT FACTORY_CONSOLE_URL FACTORY_DATA_DIR \
  FACTORY_FORCE_NOTE_MS FACTORY_GITHUB_API_URL FACTORY_GITHUB_BACKLOG FACTORY_GITHUB_POLL FACTORY_GRACE_MS FACTORY_HOME_REPO FACTORY_HYGIENE_EVERY_MS FACTORY_HYGIENE_RETRY_MS FACTORY_INCIDENT_WINDOW_MIN \
  FACTORY_INFRA_FILE FACTORY_INTAKE_PROJECTS_FILE FACTORY_LAUNCHD_POLL FACTORY_LEADS_PER_ACCOUNT FACTORY_ACCOUNT_LEADS FACTORY_LOAD_PER_CORE FACTORY_PROCESS_CAP FACTORY_PROJECT_GROUPS_FILE FACTORY_LOCK_WAIT_MS FACTORY_LONG_WAIT_MS \
  FACTORY_HEARTBEAT_STALE_MS FACTORY_LOOP_CI_LEDGER_MS FACTORY_GH_CONFIG_DIR_WORK FACTORY_ASK_HUMAN_BIN FACTORY_ASK_HUMAN_HOST FACTORY_LOOP_HOST_MS FACTORY_LOOP_HYGIENE_MS FACTORY_LOOP_LEADS_MS FACTORY_LOOP_PLANNING_MS FACTORY_LOOP_SELFWATCH_MS FACTORY_LOOP_STEWARD_MS FACTORY_LOOP_THROUGHPUT_MS FACTORY_LOOP_TRIAGE_MS \
  FACTORY_LAUNCHCTL_BIN FACTORY_LSOF_BIN FACTORY_MEMORY_SAMPLE_MS FACTORY_NTFY_TOPIC FACTORY_OTEL_EVERY_MS FACTORY_NTFY_URL FACTORY_QUIESCE_AFTER_MS FACTORY_PRETRUST_BIN FACTORY_PS_BIN \
  FACTORY_REPO_ALLOW FACTORY_REPO_ROOTS FACTORY_ROLES_FILE FACTORY_SELFWATCH_GRACE_MS FACTORY_SETTLE_POLL \
  FACTORY_SETTLE_TIMEOUT_MS FACTORY_SLOT_EXTRA_LOAD FACTORY_SLOTS FACTORY_SLOTS_MAX FACTORY_SOCKET FACTORY_SOURCE_ROOT FACTORY_SPOOL_DIR FACTORY_STEP_REMOTE_PROJECTS FACTORY_STEP_REMOTE_TARGET FACTORY_STEWARD_IDLE_BACKGROUND_MS FACTORY_STEWARD_IDLE_MS FACTORY_STEWARD_MIN_STALL_MS FACTORY_SEATS_MAX_BONUS \
  FACTORY_QUEUE_GAP_MS FACTORY_STREAM_POLL_MS FACTORY_SYSCTL_BIN FACTORY_THROUGHPUT_FILE FACTORY_TICK_MS FACTORY_TOP_BIN FACTORY_TYPE_GAP_MS FACTORY_UPTIME_EVERY_MS FACTORY_UPTIME_URL \
  FACTORY_VERIFY_RECHECK_MS FACTORY_VERIFY_RETRY_MS FACTORY_VERIFY_SETTLE_MS FACTORY_VM_STAT_BIN FACTORY_VM_VOLUME FACTORY_WATCH_WINDOW_MS \
"

# Retired settings (the load rule and the slot aim are always on): a file that still sets one is accepted, the line is dropped with a
# warning on stderr and the server never sees it. Delete the names from this list one release after the file lost them.
EF_RETIRED=" FACTORY_LOAD_CEILING FACTORY_LOAD_RULE FACTORY_SLOT_AIM FACTORY_SELFWATCH_BRANCH "

# ef_err <message>: a line on stderr that starts with an ISO time, like every line of the server's own log.
ef_err() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# load_env_file <path>: returns 0 (an absent file included) or prints one line to stderr and returns 78.
load_env_file() {
  local ef_file="$1" ef_mode ef_owner ef_line ef_key ef_n=0
  local -a ef_keys=() ef_values=()
  # A dangling symlink is not an absent file.
  [[ -e "$ef_file" || -L "$ef_file" ]] || return 0
  if [[ ! -f "$ef_file" || -L "$ef_file" ]]; then
    ef_err "software-factory: $ef_file is not a regular file; refusing to start."
    return 78
  fi
  # GNU stat first (BSD stat has no -c and fails, and GNU's -f is something else), then BSD.
  read -r ef_mode ef_owner < <(stat -c '%a %u' "$ef_file" 2>/dev/null || stat -f '%Lp %u' "$ef_file" 2>/dev/null)
  if [[ "$ef_mode" != "600" || "$ef_owner" != "$(id -u)" ]]; then
    ef_err "software-factory: $ef_file must be mode 0600 and owned by the user; refusing to start."
    return 78
  fi
  while IFS= read -r ef_line || [[ -n "$ef_line" ]]; do
    ef_n=$((ef_n + 1))
    [[ -z "${ef_line//[[:space:]]/}" || "$ef_line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$ef_line" == *$'\r'* ]]; then
      ef_err "software-factory: $ef_file line $ef_n has a carriage return (a CRLF file); refusing to start."
      return 78
    fi
    if [[ ! "$ef_line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      ef_err "software-factory: $ef_file line $ef_n is not KEY=VALUE; refusing to start."
      return 78
    fi
    ef_key="${ef_line%%=*}"
    if [[ "$EF_RETIRED" == *" $ef_key "* ]]; then
      ef_err "software-factory: $ef_file line $ef_n sets $ef_key, which is retired and ignored; delete the line."
      continue
    fi
    if [[ "$EF_ALLOWED" != *" $ef_key "* ]]; then
      ef_err "software-factory: $ef_file line $ef_n sets $ef_key, which this file does not take; refusing to start."
      return 78
    fi
    ef_keys+=("$ef_key")
    ef_values+=("${ef_line#*=}")
  done <"$ef_file"
  # A counter, not "${!ef_keys[@]}": an empty array under `set -u` is an error in macOS bash 3.2 (an env file of comments only is valid).
  for ((ef_n = 0; ef_n < ${#ef_keys[@]}; ef_n++)); do
    export "${ef_keys[$ef_n]}=${ef_values[$ef_n]}"
  done
  return 0
}
