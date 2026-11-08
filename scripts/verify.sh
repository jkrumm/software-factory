#!/bin/bash
# software-factory verify (`make verify`): exit 0 only if the deployed server is healthy, is the commit that was
# deployed, that commit is origin/master (or only behind it by changes that need no deploy), and the installed `factory` CLI reaches the server.

set -u

ROOT="${FACTORY_ROOT:-$HOME/.software-factory}"
REPO_DIR="$ROOT/repo"
SHA_FILE="$ROOT/data/deployed-sha"
PORT=7793
DOOR_PORT=8796
DOOR_TOKENS_FILE="${FACTORY_DOOR_TOKENS_FILE:-$HOME/.config/factory/door-tokens.json}"
# Must be the ref `make deploy` was given (FACTORY_REF, default master).
REF="${FACTORY_REF:-master}"
[[ "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || { echo "FACTORY_REF is not a plain branch name: $REF" >&2; exit 1; }
HEALTH_URL="http://127.0.0.1:$PORT/health"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

fail() { echo "verify: FAIL: $*" >&2; exit 1; }
ok() { echo "verify: ok: $*"; }

# A path nothing deploys. Mirrors `isInert` in apps/server/src/domains/quality/evidence.ts (what the ship gate reads as no deploy): keep them equal.
inert_path() {
  case "$1" in
    docs/* | *.md | *.mdx | *.txt | LICENSE* | */LICENSE* | .gitignore | */.gitignore) return 0 ;;
    test/* | */test/* | tests/* | */tests/* | __tests__/* | */__tests__/*) return 0 ;;
    *.test.* | *.spec.*) return 0 ;;
  esac
  return 1
}

for tool in git curl jq factory secrets-run; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool not found on PATH"
done

# 1. health
health=$(curl -fsS --max-time 5 "$HEALTH_URL") || fail "no answer from $HEALTH_URL"
[[ "$(echo "$health" | jq -r '.status')" == "ok" ]] || fail "/health is not ok: $health"
version=$(echo "$health" | jq -r '.version')
ok "/health ok (version ${version:0:12})"

# 2. the deployed build is origin/$REF, and it is the one serving
deployed=$(cat "$SHA_FILE" 2>/dev/null) || fail "$SHA_FILE missing: nothing was deployed"
remote=$(git -C "$REPO_DIR" ls-remote origin "refs/heads/$REF" | awk '{print $1}')
[[ -n "$remote" ]] || fail "cannot read origin/$REF from $REPO_DIR (run make deploy first)"
[[ "$version" == "$deployed" ]] || fail "the running server reports ${version:0:12}, deployed is ${deployed:0:12}"
if [[ "$deployed" == "$remote" ]]; then
  ok "deployed sha is origin/$REF (${deployed:0:12})"
else
  # origin/$REF moved past the deploy. That is fine when every changed path needs no deploy (the factory's own `isInert` list,
  # apps/server/src/domains/quality/evidence.ts: docs, markdown, text, licences, tests); a deployable path not deployed still fails.
  git -C "$REPO_DIR" fetch --quiet origin "$REF" || fail "git fetch origin $REF failed in $REPO_DIR"
  git -C "$REPO_DIR" cat-file -e "$remote^{commit}" 2>/dev/null || fail "origin/$REF ${remote:0:12} is not in $REPO_DIR after a fetch"
  git -C "$REPO_DIR" merge-base --is-ancestor "$deployed" "$remote" 2>/dev/null \
    || fail "deployed ${deployed:0:12} is not an ancestor of origin/$REF ${remote:0:12}"
  changed=$(git -C "$REPO_DIR" diff --name-only "$deployed" "$remote") || fail "cannot diff ${deployed:0:12}..${remote:0:12}"
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    inert_path "$path" || fail "deployed ${deployed:0:12} is not origin/$REF ${remote:0:12}: $path changed and needs a deploy"
  done <<<"$changed"
  ok "deployed ${deployed:0:12} is behind origin/$REF ${remote:0:12} only by changes that need no deploy (docs, markdown, tests)"
fi

# 3. the API refuses a caller without the token: every route but GET /health needs a bearer
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/v1/overview")
[[ "$code" == "401" ]] || fail "GET /v1/overview without a token answered $code, expected 401"
ok "GET /v1/overview without a token is 401"

# 4. the installed CLI reaches it with the token, which secrets-run resolves from the deployed release's .env.tpl
export FACTORY_URL="http://127.0.0.1:$PORT"
factory health >/dev/null || fail "factory health failed"
secrets-run run --env-file="$ROOT/current/.env.tpl" -- factory capacity get >/dev/null || fail "factory capacity get failed"
ok "factory health and factory capacity get (with the owner's token)"

# 5. the door answers an unauthenticated POST with 401 (it has no health route: the 401 is the health check). When it does not,
#    the reason is the one its launcher left: most often the tokens file, which `make deploy` does not create.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'x-factory-probe: 1' -H 'content-type: application/json' -d '{}' \
  "http://127.0.0.1:$DOOR_PORT/alert/kuma")
if [[ "$code" != "401" ]]; then
  reason="POST /alert/kuma without a token answered $code, expected 401"
  if [[ ! -e "$DOOR_TOKENS_FILE" ]]; then
    reason="$reason: the tokens file $DOOR_TOKENS_FILE does not exist (factory door token new <source>)"
  elif [[ -f "$HOME/Library/Logs/factory-door.err.log" ]]; then
    reason="$reason: $(tail -n 1 "$HOME/Library/Logs/factory-door.err.log")"
  fi
  fail "the door on 127.0.0.1:$DOOR_PORT: $reason"
fi
ok "the door answers an unauthenticated POST /alert/kuma with 401"

# 6. the Console's listener: GET /health 200, GET / serves the app, POST /health 405; and, when a serve row publishes it on :8797, the tailnet name answers too
console_port=7795
if [[ -f "$ROOT/current/scripts/env-file.sh" ]]; then
  settings=$( # shellcheck source=scripts/env-file.sh
    source "$ROOT/current/scripts/env-file.sh" && load_env_file "${FACTORY_ENV_FILE:-$HOME/.config/factory/env}" 2>/dev/null || exit 0
    echo "${FACTORY_CONSOLE_PORT:-7795}")
  [[ -n "$settings" ]] && console_port="$settings"
fi
console_url="http://127.0.0.1:$console_port"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$console_url/health")
[[ "$code" == "200" ]] || fail "the Console on $console_url answered $code to GET /health, expected 200"
page=$(curl -s -w '\n%{http_code}' --max-time 5 "$console_url/")
[[ "${page##*$'\n'}" == "200" ]] || fail "the Console on $console_url answered ${page##*$'\n'} to GET /, expected 200"
[[ "$page" == *'<div id="root"'* ]] || fail "the Console on $console_url answered GET / without the app (no <div id=\"root\">)"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST "$console_url/health")
[[ "$code" == "405" ]] || fail "the Console on $console_url answered $code to POST /health, expected 405"
ok "the Console on $console_url answers 200 to GET /health, serves the app, and answers 405 to POST /health"

# The tailnet side is dotfiles-private's serve row (:8797 -> loopback): checked only when that row is there.
ts=(tailscale)
[[ -S /var/run/tailscaled.socket ]] && ts=(tailscale --socket=/var/run/tailscaled.socket)
if ! command -v tailscale >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  echo "verify: skipped: the Console's tailnet row is not checked (tailscale or jq is not on PATH)"
elif ! serve_status=$("${ts[@]}" serve status --json 2>/dev/null) || [[ "$serve_status" != *"\"$console_url\""* ]]; then
  echo "verify: skipped: no tailscale serve row publishes $console_url on :8797"
else
  dns=$("${ts[@]}" status --json 2>/dev/null | jq -r '.Self.DNSName // empty')
  dns="${dns%.}"
  if [[ -z "$dns" ]]; then
    echo "verify: skipped: this node's tailnet name is unknown"
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$dns:8797/health")
    [[ "$code" == "200" ]] || fail "the Console on https://$dns:8797 answered $code to GET /health, expected 200 (the serve row for $console_url)"
    ok "the Console answers 200 to GET /health on https://$dns:8797"
  fi
fi

echo "verify: all checks passed"
