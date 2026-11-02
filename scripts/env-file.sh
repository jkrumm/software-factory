#!/bin/bash
# Sourced by launch.sh: the factory's own settings that are not secrets and not in the repo (FACTORY_PROBE_HOSTS names machines).
# ~/.config/factory/env (FACTORY_ENV_FILE) when it exists: KEY=VALUE lines only (blank lines and # comments allowed), the file mode
# 0600 and owned by the user, never a secret (those stay in .env.tpl). Nothing in it is evaluated: a line is split at the first =
# and exported as it is. Any other line, a wrong mode or owner, or a key .env.tpl owns refuses the start (exit 78): a setting that
# is silently ignored is worse than a launch that says why it will not run.

# load_env_file <path> <tpl>: returns 0 (absent file included) or prints one line to stderr and returns 78.
load_env_file() {
  local file="$1" tpl="$2" mode owner line key value reserved lineno=0
  [[ -e "$file" ]] || return 0
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "software-factory: $file is not a regular file; refusing to start." >&2
    return 78
  fi
  # BSD stat (macOS) first, GNU stat (CI) second.
  read -r mode owner < <(stat -f '%Lp %u' "$file" 2>/dev/null || stat -c '%a %u' "$file" 2>/dev/null)
  if [[ "$mode" != "600" || "$owner" != "$(id -u)" ]]; then
    echo "software-factory: $file must be mode 0600 and owned by the user; refusing to start." >&2
    return 78
  fi
  reserved=" DATABASE_URL FACTORY_DB_PASSWORD $(grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=' "$tpl" 2>/dev/null | tr -d '=' | tr '\n' ' ')"
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      echo "software-factory: $file line $lineno is not KEY=VALUE; refusing to start." >&2
      return 78
    fi
    key="${line%%=*}"
    value="${line#*=}"
    if [[ "$reserved" == *" $key "* ]]; then
      echo "software-factory: $file line $lineno sets $key, which is a secret or comes from .env.tpl; refusing to start." >&2
      return 78
    fi
    export "$key=$value"
  done <"$file"
  return 0
}
