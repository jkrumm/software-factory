#!/usr/bin/env bash
# The drill's green check, sourced by scratch.sh and by its test. Pure: it reads the Issue card (the JSON of `read issue`) and
# whether the run's commit is on the scratch remote, and says what the run was.
#
# Green is: closed `done`, and the commit on the scratch remote. How the Issue got there decides what else is checked:
# - The scratch repo has no deploy and its AGENTS.md says commit, push, end the turn, so the lead closes the Issue itself with
#   `close`. That is the normal shape; ship, watch and verify are not expected and not checked.
# - An Issue that did ship (a `shipped` event) must also have passed its watch (`watch_passed`), which is where verify runs.

# commit_on_remote <bare repo> <subject fragment>: yes or no. The log is read whole before it is searched: `git log | grep -q`
# under pipefail fails with 141 when grep stops at the first match and git is still writing (that missed a commit that was there).
commit_on_remote() {
  local log
  log=$(git --git-dir="$1" log --format=%s master 2>/dev/null) || { echo no; return; }
  if grep -qF -- "$2" <<<"$log"; then echo yes; else echo no; fi
}

# verdict <issue.json> <landed: yes|no>: one line on stdout, `GREEN: <how>` or `NOT GREEN: <why>`; exit 0 only for green.
verdict() {
  local card=$1 landed=$2 state outcome shipped passed
  state=$(jq -r '.state // "-"' "$card" 2>/dev/null) || state=-
  outcome=$(jq -r '.outcome // "-"' "$card" 2>/dev/null) || outcome=-
  if [[ $state != closed || $outcome != "done" ]]; then echo "NOT GREEN: ended $state/$outcome, not closed done"; return 1; fi
  if [[ $landed != yes ]]; then echo "NOT GREEN: closed done but the commit is not on the scratch remote"; return 1; fi
  shipped=$(jq -r '[.timeline[]? | select(.kind == "shipped")] | length' "$card")
  if ((shipped == 0)); then echo "GREEN: closed done by the lead's close, the commit on the scratch remote (no ship expected)"; return 0; fi
  passed=$(jq -r '[.timeline[]? | select(.kind == "watch_passed")] | length' "$card")
  if ((passed == 0)); then echo "NOT GREEN: shipped, but the watch (and verify) never passed"; return 1; fi
  echo "GREEN: shipped, watched, verified, closed done, the commit on the scratch remote"
}
