#!/usr/bin/env bash
# The live drill of a cutover window: one scratch Issue from filing to close on the running core, read only through the
# read API and the CLI. The Issue is admitted and built by a lead in the scratch repo; the
# run is green when the Issue closes `done` and its commit is on the scratch remote (verdict.sh: an Issue that shipped must
# also have passed its watch; one closed by the lead's `close`, the scratch repo's normal shape, is not asked to). With --kill-server the server is
# killed once the lead works, to show that the Issue goes on after the LaunchAgent brings the server back.
# Usage: scratch.sh [--kill-server|--kill-server=lead] [run-id]   (=lead: the kill waits until the lead's terminal runs)      (setup.sh first; teardown.sh after the evidence is written)
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck disable=SC1091
source "$GAMEDAY_DIR/verdict.sh"

kill_server=0
kill_at=working
if [[ ${1:-} == --kill-server || ${1:-} == --kill-server=lead ]]; then kill_server=1; [[ $1 == *=lead ]] && kill_at=lead; shift; fi
run=${1:-$(date -u +%m%d%H%M)}
[[ $run =~ ^[a-z0-9]{1,8}$ ]] || { echo "scratch: the run id must be 1-8 characters of [a-z0-9]" >&2; exit 2; }
repo=$SOURCE_ROOT/$REPO_NAME remote=$REMOTES/$REPO_NAME.git
key=gd-$run
out=$EVIDENCE/$key
mkdir -p "$out"
export TIMELINE=$out/timeline.txt
marker=MARK-$key
ask="Scratch gameday $key, marker $marker. Do exactly this and nothing else: write the file out/$key.txt with the single line $marker; git add it, commit with the message 'chore: gameday $key', run 'git push origin master', then close the Issue with 'factory issue close' as the standing orders say."

[[ -e $repo/.git/factory-gameday ]] || { echo "scratch: $repo is not a gameday repo; run setup.sh" >&2; exit 1; }
healthy || { echo "scratch: the factory is not healthy" >&2; exit 1; }
log "run $key: release $(fx health get --format json | jq -r .version | cut -c1-12), server pid $(server_pid || echo '?'), base commit $(git -C "$ROOT" rev-parse --short HEAD)"

filed=$(fx issue new --repo "$REPO_NAME" --title "Scratch: $key" --text "$ask" --key "$key" --format json)
issue=$(jq -r '.issue // .id' <<<"$filed")
number=${issue#issue_}
log "run $key: filed $issue"

killed=0 state="" last=""
for _ in $(seq 1 360); do
  sleep 5
  c=$(card "$number")
  [[ -n $c ]] || { log "run $key: the server is unreachable"; continue; }
  state=$(jq -r '.state' <<<"$c")
  now="$state/$(jq -r '.reason // .outcome // "-"' <<<"$c") phase=$(jq -r '.phase // "-"' <<<"$c") lead=$(jq -r '.lead // "-"' <<<"$c")"
  [[ $now == "$last" ]] || log "run $key: $now"
  last=$now
  lead_now=$(jq -r '.lead // "-"' <<<"$c")
  if ((kill_server && !killed)) && [[ $state == working ]] && [[ $kill_at == working || $lead_now != - ]]; then
    killed=1
    "$GAMEDAY_DIR/kill-server.sh" "$kill_at" "$issue" || { log "run $key: the server did not come back"; break; }
  fi
  [[ $state == closed ]] && break
  # Waiting on a person is an answer the drill cannot give: stop and say what it holds.
  if [[ $state == waiting ]]; then
    reason=$(jq -r '.reason // ""' <<<"$c")
    case $reason in decision | review | errand) log "run $key: waits on the owner ($reason); answer it or cancel the Issue" ; break ;; esac
  fi
done

fx read issue "$number" --format json | jq 'del(.about, .summary)' | scrub >"$out/issue.json" || true
landed=$(commit_on_remote "$remote" "gameday $key")
outcome=$(jq -r '.outcome // "-"' "$out/issue.json" 2>/dev/null || echo "-")
log "run $key: ended $state/$outcome, commit on the scratch remote: $landed"
if result=$(verdict "$out/issue.json" "$landed"); then
  log "run $key: $result"
  exit 0
fi
log "run $key: $result"
exit 1
