#!/usr/bin/env bash
# F2 gameday 2 (docs/design.md §13): a seeded bug passes CI but breaks production. The scratch repo ships a small program, `make check`
# is green, `make deploy` copies it outside the repo and `make verify` runs the deployed copy; the production config carries a fault
# only the deployed copy reads. The ask is one harmless change. The run files the Issue and reads the database, nothing more.
# Pass: the lead ships with evidence and the Issue is watching; the bug is caught either by the lead's own production check or by
# `make verify` after the hold (back to working, a note to the same lead, notify:regression); the fix ships, the second hold is green,
# the Issue closes, finalize runs once, the transcript is archived. Evidence: docs/evidence/f2-gate/seeded-bug/<run>/.
#
# Mode `regress` (seeded-bug-regress, one live proof of the regression branch): no seed in the repo. Once the Issue is `watching`, the script
# breaks the deployed copy from outside, the deployed config only (a production fault that arrives after the ship), so `make verify` after
# the 1 m hold is red for certain. Pass: hold red, the Issue back to working with a note to the same session and attempt, notify:regression
# sent once, the lead fixes production (the repo's `make deploy` keeps an existing production config, so the fix is a change in the repo or
# a removed config), ships again, the second hold is green, closed, finalized once. Evidence: docs/evidence/f2-gate/seeded-bug-regress/<run>/.
# Usage: seeded-bug.sh [run-id] [seed|regress]     (exit 0: every pass line passed)
# shellcheck disable=SC1091,SC2034 # SCRATCH and FINISHED are read by lib.sh's on_exit
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

run=${1:-b$(date -u +%d%H%M)} mode=${2:-seed}
case $mode in
  seed) gameday=seeded-bug name=factory-gameday-bug template=bug ;;
  regress) gameday=seeded-bug-regress name=factory-gameday-regress template=regress ;;
  *) echo "usage: seeded-bug.sh [run-id] [seed|regress]" >&2; exit 2 ;;
esac
mkdir -p "$EVIDENCE"
TIMELINE=$EVIDENCE/quota-checks.txt quota_gate || exit 3
claim_run "$gameday" "$run" || exit 2
out=$EVIDENCE/$gameday/$run
export TIMELINE=$out/timeline.txt RESULT=$out/result.txt
: >"$RESULT"
started=$SECONDS
repo=$SOURCE_ROOT/$name remote=$REMOTES/$name.git
deployed=$HOME/.local/share/factory/gameday-deploys/$name
healthy || { echo "seeded-bug: the factory is not healthy" >&2; exit 1; }

log "run $gameday/$run: release $(fx health --format json | jq -r .version | cut -c1-12), base commit $(git -C "$ROOT" rev-parse --short HEAD)"
# A previous run's production, under the gameday's own directory; anything else at that path is not ours to delete.
[[ ! -e $deployed || -e $deployed/REVISION ]] || { log "$deployed exists and is no gameday deployment; leaving it"; exit 1; }
extra_cleanup() { rm -rf "${deployed:?}" && [[ ! -e $deployed ]]; }
scratch_up "$name" "$F2_DIR/templates/$template"
extra_cleanup # scratch_up has refused anything that is not ours, so a previous production is this gameday's leftover
check_out=$(make -s -C "$repo" check 2>&1) || { log "make check FAILED on the scratch repo: $(tail -3 <<<"$check_out" | tr '\n' ' ')"; exit 1; }
log "make check on the scratch repo: $(tail -1 <<<"$check_out")"
if [[ $mode == seed ]]; then
  # The seed is armed before the Issue is filed: the CR is in origin/master's production config, `make check` is green, and the deployed
  # copy's self test fails. A run whose seed is not armed would test nothing.
  cr=$(git --git-dir="$remote" show master:deploy/limits.conf | grep -c $'\r' || true)
  [[ $cr -eq 1 ]] || { log "seed NOT armed: deploy/limits.conf on origin/master has $cr CR lines"; exit 1; }
  make -s -C "$repo" deploy >/dev/null
  armed=$("$deployed/bin/wordstat" --self-test 2>&1 || true)
  rm -rf "${deployed:?}"
  log "seed armed: the deployed copy before the Issue says: $(tr '\n' ' ' <<<"$armed")"
  [[ $armed == *"is not a number"* ]] || { log "seed NOT armed"; exit 1; }
else
  # No seed anywhere in the repo: its production is healthy until the script breaks it from outside.
  make -s -C "$repo" deploy >/dev/null
  healthy_copy=$("$deployed/bin/wordstat" --self-test 2>&1 || true)
  rm -rf "${deployed:?}"
  log "no seed: the deployed copy before the Issue says: $healthy_copy"
  [[ $healthy_copy == "selftest: ok words=9 lines=2" ]] || { log "the scratch repo's own production is not healthy"; exit 1; }
fi

ask="Add a --longest flag to wordstat: with it the output line gets longest=<word> appended, the first of the longest words. Add a test for it."
SOURCE_KEY=f2-$gameday-$run
facts=$(jq -cn --arg ask "$ask" '{ask: $ask, gameday: "f2 seeded bug"}')
filed=$(fx issue new --repo "$repo" --title "$ask" --facts - --key "$SOURCE_KEY" --format json <<<"$facts" | jq -r '.id // .issue.id')
[[ $filed =~ ^[0-9]+$ ]] || { log "no Issue id from issue new"; exit 1; }
issue=$filed
log "issue $issue filed (source_key $SOURCE_KEY)"
attempt=1
lead=$(lead_key "$issue" "$attempt")

state() { issue_col "$issue" "state || '/' || coalesce(reason, '')"; }
seen=""
log_change() {
  local now
  now=$(state)
  if [[ $now != "$seen" ]]; then
    log "issue $issue: $now (attempt $(issue_col "$issue" attempt), hold $(issue_col "$issue" hold)) | lead: $(fx session get "$lead" --format json 2>/dev/null | jq -r '"\(.state) turn=\(.turn)"' 2>/dev/null || echo none)"
    seen=$now
  fi
}
# Mode regress: the first time the Issue is `watching`, break the deployed config from outside (the repo is untouched). The fault is
# in production only, and it arrives after the ship.
broke_ms=""
break_production() {
  [[ $mode == regress && -z $broke_ms && $(state) == watching/* ]] || return 0
  if [[ ! -e $deployed/config/limits.conf ]]; then
    broke_ms=none
    log "production break: no deployed config to break (the lead did not deploy)"
    return 0
  fi
  printf 'MAX_WORDS=3\n' >"$deployed/config/limits.conf"
  broke_ms=$(now_ms)
  log "production break: the deployed config now says MAX_WORDS=3 (outside the repo, Issue $issue watching, hold $(issue_col "$issue" hold)); deployed self test: $("$deployed/bin/wordstat" --self-test 2>&1 | tr '\n' ' ')"
}
# Done: closed and finalized. Stuck: parked for something only the owner could answer, and still so 120 s later.
stuck_since=""
finished() {
  break_production
  log_change
  local now
  now=$(state)
  if [[ $now == closed/* ]] && is_finalized "$issue"; then return 0; fi
  case $now in
    waiting/blocked | waiting/decision | waiting/unreported | waiting/lead_gone | waiting/parked)
      [[ -n $stuck_since ]] || stuck_since=$SECONDS
      ((SECONDS - stuck_since > 120)) && return 0
      ;;
    *) stuck_since="" ;;
  esac
  return 1
}
export PROGRESS_CMD="progress_line $issue $lead"
if wait_for "issue $issue closed and finalized" finished; then waited=1; else waited=0; fi
stuck=0
[[ -n $stuck_since ]] && stuck=1
if ((stuck || !waited)); then
  log "issue $issue did not run to its close ($(state)); stopping it so nothing is left running"
  for _ in 1 2 3 4 5; do
    fx issue stop "$issue" --reason "gameday run ended without a close" --id "gd-$run" --format json >/dev/null 2>&1 && break
    sleep 5
  done
  wait_for "issue $issue finalized after stop" is_finalized "$issue" || true
fi
sleep 5
dump_issue "$issue" "$out"

# ---- what happened ----------------------------------------------------------------------------------------------------------------
ev() { sqlq "SELECT count(*) FROM factory.issue_events WHERE issue_id = $issue AND kind = '$1'"; }
archive=${FACTORY_ARCHIVE_DIR:-$HOME/.local/share/factory/archive}/$issue/$attempt
# The bug bit the lead's own production check: a tool result in its transcript that begins a line with the deployed copy's verify failure,
# recorded before the first ship. (The Makefile's own source text, `cat` by the lead, has `$$out` there, not the program's message.)
first_ship=$(sqlq "SELECT to_char(min(at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM factory.issue_events WHERE issue_id = $issue AND kind = 'ship' AND to_state = 'watching'")
bitten=0
for t in "$archive"/*.jsonl; do
  [[ -f $t ]] || continue
  bitten=$((bitten + $(jq -r --arg ship "${first_ship:-9999}" 'select(.type == "user" and (.timestamp // "9999") < $ship) | .message.content | if type == "array" then .[] else empty end | select(.type == "tool_result") | (.content | if type == "string" then . else map(.text // "") | join(" ") end) | select(test("(^|\n)verify: FAIL the deployed copy: wordstat: MAX_WORDS")) | 1' "$t" | wc -l | tr -d ' ')))
done
ships=$(sqlq "SELECT count(*) FROM factory.issue_events WHERE issue_id = $issue AND kind = 'ship' AND to_state = 'watching'")
regressions=$(ev regression)
git --git-dir="$remote" log --format='%h %ad %s' --date=format:%H:%M:%S master | scrub >"$out/remote-log.txt"
log "ships $ships, regressions $regressions, production check failures seen by the lead $bitten"

# ---- the pass lines ---------------------------------------------------------------------------------------------------------------
check "the Issue ran to its close without the owner (not stuck, not idle)" 1 "$((waited && !stuck))"
check "Issue after the run: closed/done, attempt 1" "closed|done|1" "$(sqlq "SELECT state||'|'||outcome||'|'||attempt FROM factory.issues WHERE id = $issue")"
check_ge "ships (watching entered)" 1 "$ships"
check_ge "evidence rows by the lead (not the factory) before the first ship" 1 "$(sqlq "SELECT count(*) FROM factory.evidence e WHERE e.issue_id = $issue AND e.author <> 'factory' AND e.kind <> 'transcript' AND e.at <= (SELECT min(at) FROM factory.issue_events WHERE issue_id = $issue AND kind = 'ship' AND to_state = 'watching')")"
check_ge "the Issue was watching (hold_over events)" 1 "$(ev hold_over)"

if ((regressions > 0)) || [[ $mode == regress ]]; then
  note_line "the fault was caught by make verify after the hold (regression), not by the lead's own production check"
  if [[ $mode == regress ]]; then
    hold_ms=$(sqlq "SELECT coalesce((extract(epoch FROM min(at)) * 1000)::bigint, 0) FROM factory.issue_events WHERE issue_id = $issue AND kind = 'hold_over'")
    check "the production break landed while the Issue was watching, before the hold ended" 1 "$([[ $broke_ms =~ ^[0-9]+$ ]] && ((broke_ms < hold_ms)) && echo 1 || echo 0)"
    notify_sent() { [[ $(sqlq "SELECT count(*) FROM factory.notifications WHERE key = 'notify:regression:$issue:1' AND sent_at IS NOT NULL") -eq 1 ]]; }
    check "notify:regression:$issue:1 sent, once (within 60 s)" yes "$(wait_secs 60 notify_sent && echo yes || echo no)"
    check "no other regression filed (only the first hold's)" 1 "$regressions"
    check "repo untouched by the break: deploy/limits.conf on origin/master is not the fault" yes "$(git --git-dir="$remote" show master:deploy/limits.conf | grep -qx 'MAX_WORDS=3' && echo no || echo yes)"
  fi
  check "regression events (one: the first hold)" 1 "$regressions"
  check "regression key and move" "regression:$issue:1|watching|working" "$(sqlq "SELECT key||'|'||from_state||'|'||to_state FROM factory.issue_events WHERE issue_id = $issue AND kind = 'regression' ORDER BY id LIMIT 1")"
  check "the regression came after hold_over" 1 "$(sqlq "SELECT (SELECT min(id) FROM factory.issue_events WHERE issue_id = $issue AND kind = 'hold_over') < (SELECT min(id) FROM factory.issue_events WHERE issue_id = $issue AND kind = 'regression')" | sed 's/t/1/;s/f/0/')"
  check "regression note to the same lead (prompt row, session)" "issue:$issue:regression:1|$lead" "$(sqlq "SELECT id||'|'||session FROM factory.prompts WHERE id = 'issue:$issue:regression:1'")"
  check "notify:regression rows" 1 "$(sqlq "SELECT count(*) FROM factory.notifications WHERE issue_id = $issue AND key = 'notify:regression:$issue:1'")"
  check "one lead session, one lead worktree for the Issue across the regression" "1|1|1" \
    "$(sqlq "SELECT (SELECT count(*) FROM factory.sessions WHERE issue_id = $issue)||'|'||(SELECT count(*) FROM factory.lead_worktrees WHERE issue_id = $issue)||'|'||(SELECT count(*) FROM factory.spawns WHERE issue_id = $issue)")"
  check_ge "turns the lead started after the regression (it acted on the note)" 1 "$(sqlq "SELECT count(*) FROM factory.events e WHERE e.session = '$lead' AND e.kind = 'turn_started' AND e.at > (SELECT at FROM factory.issue_events WHERE issue_id = $issue AND kind = 'regression' ORDER BY id LIMIT 1)")"
  check "ships after the fix (the second hold)" 2 "$ships"
  check "verified holds: the second hold only" "verified:$issue:2" "$(sqlq "SELECT string_agg(key, ',' ORDER BY id) FROM factory.issue_events WHERE issue_id = $issue AND kind = 'verified'")"
  check "regression detail names the deployed config" yes "$(sqlq "SELECT payload::text FROM factory.issue_events WHERE issue_id = $issue AND kind = 'regression' ORDER BY id LIMIT 1" | grep -q 'MAX_WORDS' && echo yes || echo no)"
else
  note_line "no regression: the bug has to have bitten the lead's own production check before the ship, or the gameday did not happen"
  check "ships" 1 "$ships"
  check "verified holds" "verified:$issue:1" "$(sqlq "SELECT string_agg(key, ',' ORDER BY id) FROM factory.issue_events WHERE issue_id = $issue AND kind = 'verified'")"
  check_ge "tool results in the lead's transcript, before the first ship, with the deployed copy's verify failure" 1 "$bitten"
fi

check "production now: the deployed copy's self test" "selftest: ok words=9 lines=2" "$("$deployed/bin/wordstat" --self-test 2>&1 || true)"
check "the shipped program: --longest on the sample names the longest word (the deployed copy)" yes \
  "$(printf 'the quick brown fox\njumps over the lazy dog\n' | "$deployed/bin/wordstat" --longest 2>&1 | grep -q 'words=9 lines=2.*longest=quick' && echo yes || echo no)"
# The requested test: master's own test/run.sh passes and has an expectation that runs --longest (a comment would not count).
tree=$(mktemp -d)
git --git-dir="$remote" archive master | tar -x -C "$tree"
tests_rc=0
tests_out=$(cd "$tree" && bash test/run.sh 2>&1) || tests_rc=$?
check "origin/master's test/run.sh passes (exit status and last line)" "0|check: ok" "$tests_rc|$(tail -1 <<<"$tests_out")"
check_ge "uncommented lines in test/run.sh that run bin/wordstat --longest" 1 "$(grep -v '^[[:space:]]*#' "$tree/test/run.sh" | grep -c 'wordstat --longest' || true)"
rm -rf "${tree:?}"
wt=$repo/.claude/worktrees/factory-$issue-$attempt
terminals=$(terminals_of "$lead")
echo "$terminals" | scrub >"$out/hc-terminals.json"
find "$archive" -maxdepth 1 -name '*.jsonl' 2>/dev/null | sed -E 's|.*/[0-9a-f-]{36}\.jsonl|<claude session>.jsonl|' >"$out/archive.txt" || true
check "finalize ran once (issue_finalized events)" 1 "$(ev issue_finalized)"
check "claim rows after finalize" 0 "$(sqlq "SELECT count(*) FROM factory.claims WHERE issue_id = $issue")"
check "live terminals of the lead after finalize (tab closed)" 0 "$(jq '[.[] | select(.state == "live")] | length' <<<"$terminals")"
check "the lead's worktree directory after finalize" no "$([[ -d $wt ]] && echo yes || echo no)"
check_ge "transcripts in the archive for the attempt" 1 "$(wc -l <"$out/archive.txt" | tr -d ' ')"
check_ge "evidence rows of kind transcript" 1 "$(sqlq "SELECT count(*) FROM factory.evidence WHERE issue_id = $issue AND kind = 'transcript'")"

# ---- teardown and report ---------------------------------------------------------------------------------------------------------
# Production and the scratch repo go only after finalize; a repo left behind is a failed line, not a quiet leftover.
removed=yes
finish_run "$name" "$issue" || removed=no
FINISHED=1
check "the scratch repo, its remote and the deployment were removed" yes "$removed"
log "run $gameday/$run: $CHECKS_FAILED failed lines, wall $((SECONDS - started)) s"
write_report "$gameday" "$run" "$out" "$issue" "$lead" "$started" "F2 gameday: a bug only production shows"
((CHECKS_FAILED == 0))
