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
# server runs and reads (FACTORY_CLAUDE_BIN, FACTORY_PRETRUST_BIN, FACTORY_CLAUDE_ACCOUNT_BIN, FACTORY_SYSCTL_BIN, FACTORY_AGW_BIN, the hook
# socket and spool, the roles and accounts files, the archive) are listed because the reports of the rewrite name them; the file is the
# user's own, mode 0600, like the plist. A unit test (scripts/test/env-file.test.ts) fails when the server reads a setting that is on
# neither list.
#
# The old core's keys stay listed though the new core no longer reads them (FACTORY_PROBE_HOSTS, FACTORY_REAPER, FACTORY_REVIEW_*,
# FACTORY_VISIBLE_ROOTS, FACTORY_DIGEST_*, FACTORY_ALERT_*, FACTORY_ASK_JUDGE, FACTORY_NOTIFY_TARGET, FACTORY_ALERTS_TOPIC,
# FACTORY_CHECKPOINT_PASS_MS, FACTORY_CONSOLE_OWNER_LOGIN): an existing env file that sets them must still launch, and so must a rollback onto the old core.

EF_ALLOWED=" \
  FACTORY_ACCOUNTS_FILE FACTORY_AGW_BIN FACTORY_ALERTS_TOPIC FACTORY_ALERT_LEADS FACTORY_ALERT_PAGE_AFTER FACTORY_ARCHIVE_DIR FACTORY_ASK_JUDGE \
  FACTORY_BESZEL_POLL FACTORY_BESZEL_URL FACTORY_BLOCKED_CHECKS FACTORY_CHECKPOINT_PASS_MS FACTORY_CHECKPOINT_POLICY_FILE FACTORY_CHECKPOINT_RECHECK_MS FACTORY_CLAIM_STALL_MS FACTORY_CLAUDE_ACCOUNT_BIN \
  FACTORY_CLAUDE_BIN FACTORY_CONSOLE_DIR FACTORY_CONSOLE_OWNER_LOGIN FACTORY_CONSOLE_PORT FACTORY_CONSOLE_URL FACTORY_DATA_DIR FACTORY_DIGEST_AT FACTORY_DIGEST_EVERY FACTORY_DIGEST_TZ FACTORY_FINGERPRINT_WINDOW_MIN \
  FACTORY_FORCE_NOTE_MS FACTORY_GITHUB_API_URL FACTORY_GITHUB_BACKLOG FACTORY_GITHUB_POLL FACTORY_GIT_TIMEOUT_MS FACTORY_GRACE_MS FACTORY_HOME_REPO FACTORY_HYGIENE_EVERY_MS FACTORY_HYGIENE_REPOS FACTORY_HYGIENE_RETRY_MS FACTORY_INCIDENT_WINDOW_MIN \
  FACTORY_INFRA_FILE FACTORY_INTAKE_PROJECTS_FILE FACTORY_LAUNCHD_POLL FACTORY_LEADS_PER_ACCOUNT FACTORY_LOAD_CEILING FACTORY_LOCK_WAIT_MS FACTORY_LONG_WAIT_MS \
  FACTORY_HEARTBEAT_STALE_MS FACTORY_LOOP_FIX_CLASSES_MS FACTORY_LOOP_FRICTION_MS FACTORY_LOOP_HOST_MS FACTORY_LOOP_HYGIENE_MS FACTORY_LOOP_LEADS_MS FACTORY_LOOP_PLANNING_MS FACTORY_LOOP_QUEUE_MS FACTORY_LOOP_REAPER_MS FACTORY_LOOP_SCREEN_MS FACTORY_LOOP_SELFWATCH_MS FACTORY_LOOP_SEND_MS FACTORY_LOOP_SETTLE_MS FACTORY_LOOP_STEWARD_MS FACTORY_LOOP_TRIAGE_MS \
  FACTORY_LOOP_WATCH_MS FACTORY_LSOF_BIN FACTORY_MEMORY_SAMPLE_MS FACTORY_NOTIFY_TARGET FACTORY_NTFY_TOPIC FACTORY_NTFY_URL FACTORY_PRETRUST_BIN FACTORY_PROBE_HOSTS FACTORY_PS_BIN \
  FACTORY_REAPER FACTORY_REPO_ROOTS FACTORY_REVIEW_DEEP_CAP FACTORY_REVIEW_IDLE_MS FACTORY_REVIEW_SESSIONS FACTORY_ROLES_FILE FACTORY_SELFWATCH_BRANCH FACTORY_SELFWATCH_GRACE_MS FACTORY_SETTLE_POLL \
  FACTORY_SETTLE_TIMEOUT_MS FACTORY_SHUTDOWN_DEADLINE_MS FACTORY_SLOT_EXTRA_LOAD FACTORY_SLOTS FACTORY_SLOTS_MAX FACTORY_SOCKET FACTORY_SOURCE_ROOT FACTORY_SPOOL_DIR FACTORY_START_BUDGET_MS FACTORY_STEWARD_IDLE_BACKGROUND_MS FACTORY_STEWARD_IDLE_MS FACTORY_STEWARD_MIN_STALL_MS FACTORY_SEATS_MAX_BONUS FACTORY_REAPER_DRY FACTORY_REAPER_GRACE_MS \
  FACTORY_QUEUE_GAP_MS FACTORY_STEWARD_RETRY_MS FACTORY_STREAM_POLL_MS FACTORY_SWAPOUT_CEILING_MB FACTORY_SWAP_CEILING_PCT FACTORY_SYSCTL_BIN FACTORY_TICK_MS \
  FACTORY_VERIFY_RECHECK_MS FACTORY_VERIFY_RETRY_MS FACTORY_VERIFY_SETTLE_MS FACTORY_VISIBLE_ROOTS FACTORY_WATCH_WINDOW_MS \
"

# load_env_file <path>: returns 0 (an absent file included) or prints one line to stderr and returns 78.
load_env_file() {
  local ef_file="$1" ef_mode ef_owner ef_line ef_key ef_n=0
  local -a ef_keys=() ef_values=()
  # A dangling symlink is not an absent file.
  [[ -e "$ef_file" || -L "$ef_file" ]] || return 0
  if [[ ! -f "$ef_file" || -L "$ef_file" ]]; then
    echo "software-factory: $ef_file is not a regular file; refusing to start." >&2
    return 78
  fi
  # GNU stat first (BSD stat has no -c and fails, and GNU's -f is something else), then BSD.
  read -r ef_mode ef_owner < <(stat -c '%a %u' "$ef_file" 2>/dev/null || stat -f '%Lp %u' "$ef_file" 2>/dev/null)
  if [[ "$ef_mode" != "600" || "$ef_owner" != "$(id -u)" ]]; then
    echo "software-factory: $ef_file must be mode 0600 and owned by the user; refusing to start." >&2
    return 78
  fi
  while IFS= read -r ef_line || [[ -n "$ef_line" ]]; do
    ef_n=$((ef_n + 1))
    [[ -z "${ef_line//[[:space:]]/}" || "$ef_line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$ef_line" == *$'\r'* ]]; then
      echo "software-factory: $ef_file line $ef_n has a carriage return (a CRLF file); refusing to start." >&2
      return 78
    fi
    if [[ ! "$ef_line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      echo "software-factory: $ef_file line $ef_n is not KEY=VALUE; refusing to start." >&2
      return 78
    fi
    ef_key="${ef_line%%=*}"
    if [[ "$EF_ALLOWED" != *" $ef_key "* ]]; then
      echo "software-factory: $ef_file line $ef_n sets $ef_key, which this file does not take; refusing to start." >&2
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
