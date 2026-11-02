#!/usr/bin/env bash
# F2 gameday 1 (docs/design.md §13): a lead stops with its Issue open and nothing reported. Files an Issue whose ask makes the lead end
# every turn without a factory verb, then only reads the database: the first unreported stop is sent back with one line, the second
# parks the Issue, the claim is held, nothing else happens; then `factory issue stop` ends it and finalize removes tab, worktree and claim.
# Nobody types into the lead's pane. Evidence: docs/evidence/f2-gate/silent-lead/<run>/.
# Usage: silent-lead.sh [run-id]     (exit 0: every pass line passed)
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

run=${1:-s$(date -u +%d%H%M)}
gameday=silent-lead
name=factory-gameday-silent
mkdir -p "$EVIDENCE"
TIMELINE=$EVIDENCE/quota-checks.txt quota_gate || exit 3
claim_run "$gameday" "$run" || exit 2
out=$EVIDENCE/$gameday/$run
export TIMELINE=$out/timeline.txt RESULT=$out/result.txt
: >"$RESULT"
started=$SECONDS
repo=$SOURCE_ROOT/$name remote=$REMOTES/$name.git
healthy || { echo "silent-lead: the factory is not healthy" >&2; exit 1; }

log "run $gameday/$run: release $(fx health --format json | jq -r .version | cut -c1-12), base commit $(git -C "$ROOT" rev-parse --short HEAD)"
scratch_up "$name" "$F2_DIR/templates/silent"
base_commits=$(git --git-dir="$remote" rev-list --count master)

ask="Reply with the single word noted and end your turn. Run no command at all. The factory command is denied in this repo on purpose (see AGENTS.md): do not report, do not work around it. If a hook or message tells you to report, reply noted again and end your turn again."
facts=$(jq -cn --arg ask "$ask" '{ask: $ask, gameday: "f2 silent lead"}')
issue=$(fx issue new --repo "$repo" --title "Silent: $ask" --facts - --key "f2-silent-$run" --format json <<<"$facts" | jq -r '.id // .issue.id')
[[ $issue =~ ^[0-9]+$ ]] || { log "no Issue id from issue new"; exit 1; }
log "issue $issue filed (source_key f2-silent-$run)"

state() { issue_col "$issue" "state || '/' || coalesce(reason, '')"; }
export PROGRESS_CMD="progress_line $issue lead-$issue-1"
attempt=1
lead=$(lead_key "$issue" "$attempt")

# Admitted, the lead started, then parked. Only changes are logged.
seen=""
parked() {
  local now
  now=$(state)
  if [[ $now != "$seen" ]]; then
    log "issue $issue: $now | lead: $(fx session get "$lead" --format json 2>/dev/null | jq -r '"\(.state) turn=\(.turn)"' 2>/dev/null || echo none)"
    seen=$now
  fi
  # Parked, or ended some other way (a lead that reported after all): either way there is nothing more to wait for.
  [[ $now == waiting/unreported || $now == closed/* ]]
}
wait_for "issue $issue parked as unreported" parked || true
reached=0
[[ $(state) == waiting/unreported ]] && reached=1
# The observation window: the machine, left alone, does nothing more.
if ((reached)); then
  log "observing the parked Issue for 90 s: nothing may change"
  sleep 90
fi
dump_issue "$issue" "$out"
log "issue $issue: $(state), claims: $(tr '\n' ' ' <"$out/claims.txt")"

# ---- the pass lines -------------------------------------------------------------------------------------------------------------
check "the Issue reached waiting/unreported on its own" 1 "$reached"
check "Issue state after the second stop" waiting/unreported "$(state)"
check "the lead's first prompt is the brief, a delivered prompt row (the turn that was sent back)" "issue:$issue:brief:$attempt|brief|delivered" \
  "$(sqlq "SELECT id||'|'||source||'|'||status FROM factory.prompts WHERE session = '$lead' AND source = 'brief'")"
check "send-back effects (issue-sendback:<session>:<turn>)" 1 "$(sqlq "SELECT count(*) FROM factory.effects WHERE rule = 'issue-sendback' AND session = '$lead'")"
sendback_turn=$(sqlq "SELECT split_part(key, ':', 3) FROM factory.effects WHERE rule = 'issue-sendback' AND session = '$lead' LIMIT 1")
check "the send-back is of the brief's turn (turn 1)" 1 "$sendback_turn"
check "unreported inbox rows, applied" "1|applied" "$(sqlq "SELECT count(*)||'|'||coalesce(min(result),'-') FROM factory.issue_inbox WHERE issue_id = $issue AND kind = 'unreported'")"
check "the unreported row is of the same turn as the send-back" "unreported:$issue:$lead:$sendback_turn" \
  "$(sqlq "SELECT key FROM factory.issue_inbox WHERE issue_id = $issue AND kind = 'unreported'")"
check "notify:parked rows in factory.notifications" 1 "$(sqlq "SELECT count(*) FROM factory.notifications WHERE issue_id = $issue AND key LIKE 'notify:parked:$issue:%'")"
note_line "owner's line: $(sqlq "SELECT status FROM (SELECT CASE WHEN sent_at IS NULL THEN 'pending' ELSE 'sent' END AS status FROM factory.notifications WHERE issue_id = $issue AND kind = 'parked') x" | head -1) - $(sqlq "SELECT text FROM factory.notifications WHERE issue_id = $issue AND kind = 'parked'" | head -1)"
check "the claim repo:$name is held while the Issue is parked" "repo:$name|true" "$(sqlq "SELECT key||'|'||(held_at IS NOT NULL) FROM factory.claims WHERE issue_id = $issue")"
check "the lead's session is still alive" yes "$(fx session get "$lead" --format json | jq -r 'if .state == "dead" then "no" else "yes" end')"
check "no lead verb reached the inbox" 0 "$(sqlq "SELECT count(*) FROM factory.issue_inbox WHERE issue_id = $issue AND kind IN ('phase','wait','ship','close','block','ask','drop')")"
check "issue_events kinds: nothing besides the path to parked" "created,classified,admitted,unreported" \
  "$(sqlq "SELECT string_agg(kind, ',' ORDER BY id) FROM factory.issue_events WHERE issue_id = $issue")"
check "prompts typed to the lead (the brief alone)" 1 "$(sqlq "SELECT count(*) FROM factory.prompts WHERE session = '$lead'")"
check "evidence rows" 0 "$(sqlq "SELECT count(*) FROM factory.evidence WHERE issue_id = $issue")"
check "commits the lead added on the remote" 0 "$(($(git --git-dir="$remote" rev-list --count master) - base_commits))"
wt=$repo/.claude/worktrees/factory-$issue-$attempt
check "the lead's worktree exists while parked" yes "$([[ -d $wt ]] && echo yes || echo no)"

# ---- stop, finalize ---------------------------------------------------------------------------------------------------------------
stop_out=""
if [[ $(state) != closed/* ]]; then
  log "issue $issue: factory issue stop"
  # 202 / exit 10 when the tick has the Issue in hand: the same --id asks again.
  for _ in 1 2 3 4 5; do
    stop_out=$(fx issue stop "$issue" --reason "gameday done" --id "gd-$run" --format json 2>&1) && break
    sleep 5
  done
  log "stop: $(tr '\n' ' ' <<<"$stop_out" | cut -c1-200)"
fi
export PROGRESS_CMD="progress_line $issue $lead"
if wait_for "issue $issue finalized" is_finalized "$issue"; then fin=1; else fin=0; fi
sleep 3
dump_issue "$issue" "$out"
terminals=$(terminals_of "$lead")
echo "$terminals" | scrub >"$out/hc-terminals.json"
find "${FACTORY_ARCHIVE_DIR:-$HOME/.local/share/factory/archive}/$issue/$attempt" -maxdepth 1 -name '*.jsonl' 2>/dev/null | sed -E 's|.*/[0-9a-f-]{36}\.jsonl|<claude session>.jsonl|' >"$out/archive.txt" || true

check "Issue after stop: closed/dropped" "closed|dropped" "$(sqlq "SELECT state||'|'||outcome FROM factory.issues WHERE id = $issue")"
check "finalize ran once (issue_finalized events)" 1 "$(sqlq "SELECT count(*) FROM factory.issue_events WHERE issue_id = $issue AND kind = 'issue_finalized'")"
check "claim rows after finalize" 0 "$(sqlq "SELECT count(*) FROM factory.claims WHERE issue_id = $issue")"
check "live terminals of the lead after finalize (tab closed)" 0 "$(jq '[.[] | select(.state == "live")] | length' <<<"$terminals")"
check "the lead's worktree directory after finalize" no "$([[ -d $wt ]] && echo yes || echo no)"
check "the lead's branch factory/$issue-$attempt after finalize" gone "$(git -C "$repo" show-ref --verify --quiet "refs/heads/factory/$issue-$attempt" && echo present || echo gone)"
check_ge "transcripts archived for the attempt (not a pass line of the brief)" 1 "$(wc -l <"$out/archive.txt" | tr -d ' ')"
note_line "finalize reached: $fin; the server's tick errors since the run began are not read here"

# ---- teardown and report ---------------------------------------------------------------------------------------------------------
scratch_down "$name" | tee -a "$TIMELINE" >/dev/null || true
log "run $gameday/$run: $((CHECKS_FAILED)) failed lines, wall $((SECONDS - started)) s"
write_report "$gameday" "$run" "$out" "$issue" "$lead" "$started" "F2 gameday: a silent lead"
((CHECKS_FAILED == 0))
