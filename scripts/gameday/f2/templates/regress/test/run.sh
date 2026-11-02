#!/usr/bin/env bash
# The tests: run bin/wordstat against test/limits.conf (never the production config).
set -euo pipefail
cd "$(dirname "$0")/.."
export WORDSTAT_CONF=$PWD/test/limits.conf
failed=0
expect() { # <name> <expected> <actual>
  if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: expected '$2', got '$3'"; failed=1; fi
}
expect "counts words and lines" "words=9 lines=2" "$(printf 'the quick brown fox\njumps over the lazy dog\n' | bin/wordstat)"
expect "an empty input" "words=0 lines=0" "$(printf '' | bin/wordstat)"
expect "the self test" "selftest: ok words=9 lines=2" "$(bin/wordstat --self-test)"
if ((failed == 0)); then echo "check: ok"; else echo "check: FAIL"; exit 1; fi
