#!/usr/bin/env bash
# F2 gameday 2 (docs/design.md §13): a seeded bug passes CI but breaks production. The scratch repo ships a small program, `make check`
# is green, `make deploy` copies it outside the repo and `make verify` runs the deployed copy; the production config carries a fault
# only the deployed copy reads. The ask is one harmless change. The run files the Issue and reads the database, nothing more.
# Pass: the lead ships with evidence and the Issue is watching; the bug is caught either by the lead's own production check or by
# `make verify` after the hold (back to working, a note to the same lead, notify:regression); the fix ships, the second hold is green,
# the Issue closes, finalize runs once, the transcript is archived. Evidence: docs/evidence/f2-gate/seeded-bug/<run>/.
# Usage: seeded-bug.sh [run-id]     (exit 0: every pass line passed)
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

run=${1:-b$(date -u +%d%H%M)}
gameday=seeded-bug
name=factory-gameday-bug
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
rm -rf "${deployed:?}" # a previous run's production, under the gameday's own directory
scratch_up "$name" "$F2_DIR/templates/bug"
log "make check on the scratch repo: $(make -s -C "$repo" check | tail -1)"

ask="Add a --longest flag to wordstat: with it the output line gets longest=<word> appended, the first of the longest words. Add a test for it."
facts=$(jq -cn --arg ask "$ask" '{ask: $ask, gameday: "f2 seeded bug"}')
issue=$(fx issue new --repo "$repo" --title "$ask" --facts - --key "f2-bug-$run" --format json <<<"$facts" | jq -r '.id // .issue.id')
[[ $issue =~ ^[0-9]+$ ]] || { log "no Issue id from issue new"; exit 1; }
log "issue $issue filed (source_key f2-bug-$run)"
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
# Done: closed and finalized. Stuck: parked for something only the owner could answer, and still so 120 s later.
stuck_since=""
finished() {
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
ships=$(sqlq "SELECT count(*) FROM factory.issue_events WHERE issue_id = $issue AND kind = 'ship' AND to_state = 'watching'")
regressions=$(ev regression)
fix_commits=$(git --git-dir="$remote" log --format=%H master -- deploy/limits.conf | wc -l | tr -d ' ')
git --git-dir="$remote" log --format='%h %ad %s' --date=format:%H:%M:%S master | scrub >"$out/remote-log.txt"
log "ships $ships, regressions $regressions, commits touching deploy/limits.conf $fix_commits"

# ---- the pass lines ---------------------------------------------------------------------------------------------------------------
check "the Issue ran to its close without the owner (not stuck, not idle)" 1 "$((waited && !stuck))"
check "Issue after the run: closed/done, attempt 1" "closed|done|1" "$(sqlq "SELECT state||'|'||outcome||'|'||attempt FROM factory.issues WHERE id = $issue")"
check_ge "ships (watching entered)" 1 "$ships"
check_ge "evidence rows by the lead (not the factory) before the first ship" 1 "$(sqlq "SELECT count(*) FROM factory.evidence e WHERE e.issue_id = $issue AND e.author <> 'factory' AND e.kind <> 'transcript' AND e.at <= (SELECT min(at) FROM factory.issue_events WHERE issue_id = $issue AND kind = 'ship' AND to_state = 'watching')")"
check_ge "the Issue was watching (hold_over events)" 1 "$(ev hold_over)"

if ((regressions > 0)); then
  note_line "the bug was caught by make verify after the hold (regression), not by the lead's own production check"
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
  note_line "the lead's own production check caught the bug before the ship (no regression)"
  check "ships" 1 "$ships"
  check "verified holds" "verified:$issue:1" "$(sqlq "SELECT string_agg(key, ',' ORDER BY id) FROM factory.issue_events WHERE issue_id = $issue AND kind = 'verified'")"
  check_ge "commits that touched deploy/limits.conf (the initial one and the fix)" 2 "$fix_commits"
fi

check "production now: the deployed copy's self test" "selftest: ok words=9 lines=2" "$("$deployed/bin/wordstat" --self-test 2>&1 || true)"
check "the change is on origin/master (--longest in bin/wordstat)" yes "$(git --git-dir="$remote" show master:bin/wordstat | grep -q -- '--longest' && echo yes || echo no)"
check "the fix is on origin/master (MAX_WORDS no longer 3)" yes "$(git --git-dir="$remote" show master:deploy/limits.conf | grep -qx 'MAX_WORDS=3' && echo no || echo yes)"
wt=$repo/.claude/worktrees/factory-$issue-$attempt
terminals=$(terminals_of "$lead")
echo "$terminals" | scrub >"$out/hc-terminals.json"
archive=${FACTORY_ARCHIVE_DIR:-$HOME/.local/share/factory/archive}/$issue/$attempt
find "$archive" -maxdepth 1 -name '*.jsonl' 2>/dev/null | sed -E 's|.*/[0-9a-f-]{36}\.jsonl|<claude session>.jsonl|' >"$out/archive.txt" || true
check "finalize ran once (issue_finalized events)" 1 "$(ev issue_finalized)"
check "claim rows after finalize" 0 "$(sqlq "SELECT count(*) FROM factory.claims WHERE issue_id = $issue")"
check "live terminals of the lead after finalize (tab closed)" 0 "$(jq '[.[] | select(.state == "live")] | length' <<<"$terminals")"
check "the lead's worktree directory after finalize" no "$([[ -d $wt ]] && echo yes || echo no)"
check_ge "transcripts in the archive for the attempt" 1 "$(wc -l <"$out/archive.txt" | tr -d ' ')"
check_ge "evidence rows of kind transcript" 1 "$(sqlq "SELECT count(*) FROM factory.evidence WHERE issue_id = $issue AND kind = 'transcript'")"

# ---- teardown and report ---------------------------------------------------------------------------------------------------------
rm -rf "${deployed:?}"
scratch_down "$name" | tee -a "$TIMELINE" >/dev/null || true
log "run $gameday/$run: $CHECKS_FAILED failed lines, wall $((SECONDS - started)) s"
write_report "$gameday" "$run" "$out" "$issue" "$lead" "$started" "F2 gameday: a bug only production shows"
((CHECKS_FAILED == 0))
