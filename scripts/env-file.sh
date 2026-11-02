#!/bin/bash
# Sourced by launch.sh: the factory's own settings that are not secrets and not in the repo (FACTORY_PROBE_HOSTS names machines).
# ~/.config/factory/env (FACTORY_ENV_FILE) when it exists: KEY=VALUE lines only (blank lines and # comments allowed), the file mode
# 0600 and owned by the user, and only the keys below. Nothing in it is evaluated: a line is split at the first = and exported as it
# is. The whole file is checked before anything is exported. A wrong mode or owner, a line that is not KEY=VALUE, a key that is not
# listed (a secret, PATH, the port, a program the server would run, a typo) or a symlink refuses the start (exit 78): a setting that is silently ignored is worse than
# a launch that says why it will not run. Secrets stay in .env.tpl. Read at launch only: an edit takes a LaunchAgent restart.

EF_ALLOWED=" FACTORY_PROBE_HOSTS FACTORY_VISIBLE_ROOTS FACTORY_DIGEST_EVERY FACTORY_ALERT_LEADS FACTORY_NOTIFY_TARGET FACTORY_DIGEST_AT FACTORY_DIGEST_TZ "

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
