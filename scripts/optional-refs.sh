#!/bin/bash
# Sourced by launch.sh and deploy.sh: the refs of .env.tpl that may be unresolved. The server starts without the token and the
# caller it names does not exist; every other ref must resolve, or the launch (exit 78) and the deploy (nothing changed) refuse.
# FACTORY_SIGNAL_TOKEN is Hermes' filing bearer: it is made at W14 of the cutover runbook, after the first deploy.
# shellcheck disable=SC2034 # read by the scripts that source this file
OPTIONAL_KEYS="FACTORY_SIGNAL_TOKEN"

# The template a caller should hand to secrets-run: $1 itself when every optional ref resolves, else a copy at $2 without
# the optional refs that do not (refs only, no secret). Prints the path to use.
effective_template() { # <tpl> <copy path>
  local out=$2 key ref src=$1
  for key in $OPTIONAL_KEYS; do
    ref=$(grep -hE "^${key}=" "$src" | head -1 | cut -d= -f2-)
    [[ -n "$ref" ]] || continue
    if ! "${SECRETS_RUN:-secrets-run}" read "$ref" >/dev/null 2>&1; then
      mkdir -p "$(dirname "$out")"
      grep -v "^${key}=" "$src" >"$out.next" && mv "$out.next" "$out"
      src=$out
    fi
  done
  printf '%s\n' "$src"
}
