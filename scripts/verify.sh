#!/bin/bash
# software-factory verify (`make verify`): exit 0 only if the deployed server is healthy, is the commit that was
# deployed, that commit is origin/master, and the installed `factory` CLI reaches the server.

set -u

ROOT="${FACTORY_ROOT:-$HOME/.software-factory}"
REPO_DIR="$ROOT/repo"
SHA_FILE="$ROOT/data/deployed-sha"
PORT=7793
HEALTH_URL="http://127.0.0.1:$PORT/health"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

fail() { echo "verify: FAIL: $*" >&2; exit 1; }
ok() { echo "verify: ok: $*"; }

for tool in git curl jq factory secrets-run; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool not found on PATH"
done

# 1. health
health=$(curl -fsS --max-time 5 "$HEALTH_URL") || fail "no answer from $HEALTH_URL"
[[ "$(echo "$health" | jq -r '.status')" == "ok" ]] || fail "/health is not ok: $health"
version=$(echo "$health" | jq -r '.version')
ok "/health ok (version ${version:0:12})"

# 2. the deployed build is origin/master, and it is the one serving
deployed=$(cat "$SHA_FILE" 2>/dev/null) || fail "$SHA_FILE missing: nothing was deployed"
remote=$(git -C "$REPO_DIR" ls-remote origin refs/heads/master | awk '{print $1}')
[[ -n "$remote" ]] || fail "cannot read origin/master from $REPO_DIR (run make deploy first)"
[[ "$deployed" == "$remote" ]] || fail "deployed ${deployed:0:12} is not origin/master ${remote:0:12}"
[[ "$version" == "$deployed" ]] || fail "the running server reports ${version:0:12}, deployed is ${deployed:0:12}"
ok "deployed sha is origin/master (${deployed:0:12})"

# 3. the API refuses a caller without the token
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/spawns")
[[ "$code" == "401" ]] || fail "GET /spawns without a token answered $code, expected 401"
ok "GET /spawns without a token is 401"

# 4. the installed CLI reaches it with the token, which secrets-run resolves from the deployed release's .env.tpl
export FACTORY_URL="http://127.0.0.1:$PORT"
factory health >/dev/null || fail "factory health failed"
secrets-run run --env-file="$ROOT/current/.env.tpl" -- factory spawn list >/dev/null || fail "factory spawn list failed"
ok "factory health and factory spawn list"


echo "verify: all checks passed"
