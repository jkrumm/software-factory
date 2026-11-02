#!/usr/bin/env bash
# Shared by the F2 gameday scripts. Sourced, not run. Builds on F1's lib.sh (fx, db, log, scrub) and points its evidence at f2-gate.
# shellcheck disable=SC2034
F2_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export GAMEDAY_EVIDENCE=${GAMEDAY_EVIDENCE:-$F2_DIR/../../../docs/evidence/f2-gate}
# shellcheck disable=SC1091
source "$F2_DIR/../lib.sh"
EVIDENCE=$(cd "$GAMEDAY_EVIDENCE" 2>/dev/null && pwd || echo "$GAMEDAY_EVIDENCE")

# A lead that is wedged shows as no change at all: waits end on idleness, never on a total time (agent-limits).
IDLE_LIMIT=${GAMEDAY_IDLE_LIMIT:-900}
MAX_RUNS=3

# `sqlq <sql>` is a read-only query; strings are the caller's, never user input.
sqlq() { db "$1"; }

# The quota gate: stop before spending when me2 is past 60 % of its week or iu past 90 %. Fails closed: a reading that is missing or not a
# number stops the run. Prints the readings.
quota_gate() {
  local q me2 iu
  q=$(fx quota get --format json) || { log "quota: unreadable, stopping"; return 1; }
  me2=$(jq -r '[.quota[] | select(.account == "me2") | .weeklyUsed] | first | if type == "number" then . else "x" end' <<<"$q")
  iu=$(jq -r '[.quota[] | select(.account == "iu") | .weeklyUsed] | first | if type == "number" then . else "x" end' <<<"$q")
  if ! [[ $me2 =~ ^[0-9]+(\.[0-9]+)?$ && $iu =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    log "quota: me2 week '$me2', iu week '$iu' are no readings, stopping"
    return 1
  fi
  log "quota: me2 week ${me2}%, iu week ${iu}%"
  if awk -v a="$me2" -v b="$iu" 'BEGIN { exit !(a > 60 || b > 90) }'; then
    log "quota: me2 past 60 % of its week or iu past 90 %, stopping"
    return 1
  fi
}

# `claim_run <gameday> <run>`: the run's evidence directory. One gameday run at a time on this host (a lock directory outside the repo,
# released by on_exit); a run id is used once; a gameday has at most MAX_RUNS runs.
LOCK=${GAMEDAY_F2_LOCK:-$HOME/.local/share/factory/gameday-f2.lock}
claim_run() {
  local gameday=$1 run=$2
  [[ $run =~ ^[a-z0-9]{1,8}$ ]] || { echo "run id must be 1-8 characters of [a-z0-9]" >&2; return 2; }
  mkdir -p "$(dirname "$LOCK")"
  mkdir "$LOCK" 2>/dev/null || { echo "another F2 gameday run holds $LOCK (remove it only if no run is alive)" >&2; return 2; }
  HAVE_LOCK=1
  mkdir -p "$EVIDENCE/$gameday"
  local used
  used=$(find "$EVIDENCE/$gameday" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
  ((used < MAX_RUNS)) || { echo "$gameday has had $used runs; the limit is $MAX_RUNS" >&2; return 2; }
  mkdir "$EVIDENCE/$gameday/$run" 2>/dev/null || { echo "run $gameday/$run exists; a rerun needs a new run id" >&2; return 2; }
}

# `scratch_up <repo name> <template dir>`: a repo under SOURCE_ROOT with a local bare remote, the gameday marker, the template and a
# project.yaml v0 (deploy.mode make, hold 1m). Refuses to touch what exists. Then the factory reads the manifest.
scratch_up() {
  local name=$1 template=$2
  local repo=$SOURCE_ROOT/$name remote=$REMOTES/$name.git
  [[ ! -e $repo && ! -e $remote ]] || { echo "scratch: $repo or $remote exists; run teardown first" >&2; return 1; }
  mkdir -p "$REMOTES"
  # The marker goes in as each resource is made, so a setup that fails halfway can still be torn down.
  git init --quiet --bare --initial-branch=master "$remote" && : >"$remote/factory-gameday"
  git init --quiet --initial-branch=master "$repo" && : >"$repo/.git/factory-gameday"
  cp -R "$template"/. "$repo"/
  cat >"$repo/project.yaml" <<YAML
apiVersion: factory/v2
name: $name
deploy:
  mode: make
  targets:
    - { name: local, host: mini, verify: make verify }
  hold: 1m
ship:
  - { paths: ['**'], via: push }
leads: 1
YAML
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" config core.autocrlf false # a template may carry bytes (a CR) that the host's autocrlf=input would strip
  git -C "$repo" add -A
  git -C "$repo" -c user.name=gameday -c user.email=gameday@example.com commit --quiet -m "chore: scratch repo for the F2 gamedays"
  git -C "$repo" push --quiet -u origin master
  # The remote's HEAD names the default branch the way a clone's would; sync reads the manifest from origin/master.
  git -C "$repo" remote set-head origin master >/dev/null
  fx project sync --format json >/dev/null
  local project
  project=$(fx project show "$name" --format json | jq -c '{name, source, mode: .manifest.deploy.mode, hold: .manifest.deploy.hold, make: (.makeTargets | {check, deploy, verify})}')
  log "scratch: $name up; project $project"
  [[ $(jq -r .source <<<"$project") == manifest ]] || { log "scratch: the manifest was not read"; return 1; }
}

# `scratch_down <repo name>`: F1's teardown, which closes the repo's terminals and removes it only with its markers.
scratch_down() { GAMEDAY_REPO=$1 "$GAMEDAY_DIR/teardown.sh" 2>&1 | scrub; }

# `finish_run <repo name> [issue id]`: the end of a run, whatever way it ended. An Issue still open is stopped and its finalize awaited; the
# scratch repo goes only once the Issue is finalized (its lead may be working in it until then). Returns 1 when something was left behind.
finish_run() {
  local name=$1 issue=${2:-} i
  if [[ -n $issue ]]; then
    if [[ $(issue_col "$issue" state) != closed ]]; then
      for i in 1 2 3 4 5; do
        fx issue stop "$issue" --reason "gameday run ended" --id "gd-end-$i-$$" --format json >/dev/null 2>&1 && break
        sleep 5
      done
    fi
    if ! wait_for "issue $issue finalized" is_finalized "$issue"; then
      log "issue $issue is not finalized: leaving $name in place"
      return 1
    fi
  fi
  if declare -F extra_cleanup >/dev/null; then extra_cleanup; fi
  scratch_down "$name" | tee -a "${TIMELINE:-$EVIDENCE/log.txt}" >/dev/null
}

# The scripts set SCRATCH and `issue` as they make them and FINISHED=1 when their own end ran; an exit before that (an error under
# `set -e`, SIGINT, SIGTERM) stops the Issue and takes the scratch repo down, then the lock is released.
FINISHED=0 HAVE_LOCK=0 SCRATCH="" issue=""
on_exit() {
  local rc=$?
  trap - EXIT
  if ((FINISHED == 0)) && [[ -n $SCRATCH ]]; then
    log "run ended early (exit $rc): cleaning up"
    finish_run "$SCRATCH" "$issue" || true
  fi
  ((HAVE_LOCK == 0)) || rmdir "$LOCK" 2>/dev/null || true
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# `wait_for <what> <command…>`: poll every 3 s until the command succeeds. Ends on IDLE_LIMIT seconds with no change of the progress
# line (PROGRESS_CMD's output), never on total time.
wait_for() {
  local what=$1
  shift
  local last="" idle_since=$SECONDS now
  while true; do
    if "$@"; then return 0; fi
    now=$(${PROGRESS_CMD:-true} 2>/dev/null || true)
    if [[ $now != "$last" ]]; then
      last=$now
      idle_since=$SECONDS
    fi
    if ((SECONDS - idle_since > IDLE_LIMIT)); then
      log "wait: $what: no change for ${IDLE_LIMIT}s, giving up"
      return 1
    fi
    sleep 3
  done
}

# What moves while a lead works: the Issue's state, its last issue_events row, the lead's session state and turn, and its transcript's
# size (a lead in one long turn writes it, so a working lead is never idle).
progress_line() { # <issue id> <lead session>
  local session transcript size=0
  session=$(fx session get "$2" --format json 2>/dev/null || echo '{}')
  transcript=$(jq -r '.transcriptPath // empty' <<<"$session")
  [[ -n $transcript && -f $transcript ]] && size=$(stat -f %z "$transcript")
  printf '%s|%s|%s|%s' \
    "$(sqlq "SELECT state || '/' || coalesce(reason,'') FROM factory.issues WHERE id = $1")" \
    "$(sqlq "SELECT coalesce(max(id),0) FROM factory.issue_events WHERE issue_id = $1")" \
    "$(jq -r '"\(.state // "none") \(.turn // 0)"' <<<"$session")" "$size"
}

# --- Evidence and the report -------------------------------------------------------------------------------------------------------

# `check <name> <expected> <actual>`: one pass line. Every call is written to RESULT and counted.
CHECKS_FAILED=0
check() {
  local verdict=FAIL
  if [[ $2 == "$3" ]]; then verdict=PASS; else CHECKS_FAILED=$((CHECKS_FAILED + 1)); fi
  printf '%s\t%s\texpected %s\tgot %s\n' "$verdict" "$1" "$2" "$3" | scrub | tee -a "$RESULT"
}
# `check_ge <name> <least> <actual>`: a count that must be at least `least`.
check_ge() {
  local verdict=FAIL
  if (("$3" >= "$2")); then verdict=PASS; else CHECKS_FAILED=$((CHECKS_FAILED + 1)); fi
  printf '%s\t%s\texpected at least %s\tgot %s\n' "$verdict" "$1" "$2" "$3" | scrub | tee -a "$RESULT"
}
# `note_line <text>`: a result line that is no pass condition (an observation).
note_line() { printf 'NOTE\t%s\n' "$1" | scrub | tee -a "$RESULT"; }

# The Issue's timeline: issue_events, the inbox, the session's events, the effects, the prompts, the notifications.
dump_issue() { # <issue id> <out dir>
  local id=$1 out=$2
  sqlq "SELECT to_char(at AT TIME ZONE 'UTC','HH24:MI:SS.MS'), kind, coalesce(from_state,''), coalesce(to_state,''), key, left(coalesce(payload::text,''),240) FROM factory.issue_events WHERE issue_id = $id ORDER BY id" | scrub >"$out/issue_events.txt"
  sqlq "SELECT to_char(at AT TIME ZONE 'UTC','HH24:MI:SS.MS'), kind, coalesce(session,''), coalesce(result,'-'), coalesce(detail,''), key FROM factory.issue_inbox WHERE issue_id = $id ORDER BY id" | scrub >"$out/inbox.txt"
  sqlq "SELECT to_char(e.at AT TIME ZONE 'UTC','HH24:MI:SS.MS'), e.kind, e.session, e.key FROM factory.events e JOIN factory.sessions s ON s.id = e.session WHERE s.issue_id = $id ORDER BY e.at, e.id" | scrub >"$out/events.txt"
  sqlq "SELECT to_char(f.at AT TIME ZONE 'UTC','HH24:MI:SS.MS'), f.rule, f.session, f.key FROM factory.effects f JOIN factory.sessions s ON s.id = f.session WHERE s.issue_id = $id ORDER BY f.at" | scrub >"$out/effects.txt"
  sqlq "SELECT p.id, p.source, p.status, p.sent_count, to_char(p.created_at AT TIME ZONE 'UTC','HH24:MI:SS') FROM factory.prompts p JOIN factory.sessions s ON s.id = p.session WHERE s.issue_id = $id ORDER BY p.created_at" | scrub >"$out/prompts.txt"
  sqlq "SELECT to_char(created_at AT TIME ZONE 'UTC','HH24:MI:SS'), key, kind, CASE WHEN sent_at IS NULL THEN 'pending' ELSE 'sent' END, text FROM factory.notifications WHERE issue_id = $id ORDER BY created_at" | scrub >"$out/notifications.txt"
  sqlq "SELECT to_char(at AT TIME ZONE 'UTC','HH24:MI:SS'), kind, coalesce(author,''), attempt, coalesce(link,''), left(coalesce(payload::text,''),200) FROM factory.evidence WHERE issue_id = $id ORDER BY id" | scrub >"$out/evidence.txt"
  sqlq "SELECT key, held_at IS NOT NULL FROM factory.claims WHERE issue_id = $id" | scrub >"$out/claims.txt"
  fx issue show "$id" --format json | jq 'del(.facts)' | scrub >"$out/issue.json"
}

# The lead's tier, effort and account, for the report.
lead_facts() { # <issue id> <lead session>
  local tier effort account
  tier=$(sqlq "SELECT coalesce(lead_tier,'?') FROM factory.issues WHERE id = $1")
  effort=$(sqlq "SELECT coalesce(lead_effort,'?') FROM factory.issues WHERE id = $1")
  account=$(sqlq "SELECT coalesce(account,'?') FROM factory.spawns WHERE key = '$2'")
  printf '%s %s on %s' "$tier" "$effort" "$account"
}

# report.md: header, the pass lines from RESULT, wall time and the lead, then the timeline (issue_events, the inbox, the lead's events,
# the notifications).
write_report() { # <gameday> <run> <out dir> <issue id> <lead session> <started seconds> <title>
  local gameday=$1 run=$2 out=$3 id=$4 lead=$5 started=$6 title=$7
  local fence=$'\x60\x60\x60' tick=$'\x60' verdict=PASS wall=$((SECONDS - started))
  ((CHECKS_FAILED == 0)) || verdict=FAIL
  {
    printf '# %s, run %s: %s\n\n' "$title" "$run" "$verdict"
    printf -- '- Gameday %s; Issue %s, lead session %s%s%s\n' "$gameday" "$id" "$tick" "$lead" "$tick"
    printf -- '- Lead: %s\n' "$(lead_facts "$id" "$lead")"
    printf -- '- Wall time: %dm%02ds (setup to teardown)\n\n' $((wall / 60)) $((wall % 60))
    printf '## Pass conditions\n\n| Verdict | Line | Expected | Got |\n|-|-|-|-|\n'
    awk -F'\t' '$1 == "PASS" || $1 == "FAIL" { sub(/^expected /, "", $3); sub(/^got /, "", $4); for (i = 2; i <= 4; i++) gsub(/\|/, "\\|", $i); printf "| %s | %s | %s | %s |\n", $1, $2, $3, $4 }' "$RESULT"
    printf '\n'
    if grep -q '^NOTE' "$RESULT"; then
      printf '## Notes\n\n'
      awk -F'\t' '$1 == "NOTE" { printf "- %s\n", $2 }' "$RESULT"
      printf '\n'
    fi
    printf '## Timeline\n\nThe run script%ss own log is %stimeline.txt%s. The machine: %sissue_events%s (time, kind, from, to, key, payload).\n\n%s\n' "'" "$tick" "$tick" "$tick" "$tick" "$fence"
    cat "$out/issue_events.txt"
    printf '%s\n\nThe inbox (time, kind, session, result, detail, key):\n\n%s\n' "$fence" "$fence"
    cat "$out/inbox.txt"
    printf '%s\n\nSession events of the lead (time, kind, session, key):\n\n%s\n' "$fence" "$fence"
    cat "$out/events.txt"
    printf '%s\n\nNotifications (time, key, kind, status, text):\n\n%s\n' "$fence" "$fence"
    cat "$out/notifications.txt"
    printf '%s\n' "$fence"
  } | scrub >"$out/report.md"
}

# `lead_session <issue> <attempt>`: the lead's key, as the machine names it.
lead_key() { printf 'lead-%s-%s' "$1" "$2"; }

# Issue facts by column.
issue_col() { sqlq "SELECT coalesce($2::text,'') FROM factory.issues WHERE id = $1"; }

# Finalize ended the attempt: the `issue_finalized` event.
is_finalized() { [[ $(sqlq "SELECT count(*) FROM factory.issue_events WHERE issue_id = $1 AND kind = 'issue_finalized'") -ge 1 ]]; }

# `wait_secs <seconds> <command…>`: poll once a second, at most that long.
wait_secs() {
  local end=$((SECONDS + $1))
  shift
  while ((SECONDS < end)); do
    if "$@"; then return 0; fi
    sleep 1
  done
  "$@"
}
