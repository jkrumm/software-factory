#!/usr/bin/env bash
# One kill run: spawn a scratch session, `kill -9` the factory's server at a chosen moment, let the LaunchAgent bring it
# back, wait until the session's turn is over, then count what exists for the key. Writes docs/evidence/f1-gamedays/<key>/.
# Usage: run.sh <claimed|prompt|working> [run-id]
#   claimed  the Runner's `herdr agent start` is running: the spawn is claimed, its tab exists, the agent is not up yet
#   prompt   the Runner's `herdr agent prompt` is running: the agent is up, the first prompt is being submitted
#   working  the session is working its turn (a 50 s perl sleep in the prompt keeps it busy)
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

moment=${1:?claimed|prompt|working} run=${2:-$(date -u +%m%d%H%M)}
key=fgd-$run-$moment
repo=$SOURCE_ROOT/$REPO_NAME remote=$REMOTES/$REPO_NAME.git
out=$EVIDENCE/$key
mkdir -p "$out"
export TIMELINE=$out/timeline.txt
marker=PROMPTMARK-$key
prompt="Scratch gameday, key $key, marker $marker. Do exactly this and nothing else: 1) run \"perl -e 'sleep 50'\" in bash (the harness blocks a plain sleep); 2) write the file out/$key.txt with the single line $marker; 3) git add it, commit with the message 'chore: gameday $key' and run 'git push origin master'; 4) end your turn."

[[ -e $repo/.git/factory-gameday ]] || { echo "run: $repo is not a gameday repo; run setup.sh" >&2; exit 1; }
healthy || { echo "run: the factory is not healthy" >&2; exit 1; }
case $moment in
  # The pattern names the key, so another session's start or prompt (the host runs others) never triggers the kill.
  claimed) watcher=("$GAMEDAY_DIR/when-child.sh" "herdr agent start $key " 180 -- kill-server.sh claimed "$key") ;;
  prompt) watcher=("$GAMEDAY_DIR/when-child.sh" "herdr agent prompt .*$marker" 180 -- kill-server.sh prompt "$key") ;;
  working) watcher=("$GAMEDAY_DIR/when-working.sh" "$key" 300 -- kill-server.sh working "$key") ;;
  *) echo "usage: run.sh <claimed|prompt|working> [run-id]" >&2; exit 2 ;;
esac

log "run $key: release $(fx health --format json | jq -r .version | cut -c1-12), server pid $(server_pid), base commit $(git -C "$ROOT" rev-parse --short HEAD)"
"${watcher[@]}" >>"$out/kill.out" 2>&1 &
watcher_pid=$!
# A watcher left armed would kill the server later, whatever stopped this script.
trap 'kill "$watcher_pid" 2>/dev/null || true' EXIT
log "run $key: spawn create (role worker, repo $REPO_NAME), watcher $moment armed"
fx spawn create "$key" --repo "$repo" --prompt "$prompt" --role worker --format json | jq -c '{key,status,account,role,tier,effort}' | scrub | tee -a "$TIMELINE"
if ! wait "$watcher_pid"; then
  log "run $key: the kill did not land ($(tr '\n' ' ' <"$out/kill.out" | scrub))"
  exit 1
fi

# After the kill: follow the spawn and the session until the turn is over. Only changes are logged.
last=""
end=$((SECONDS + 900))
done_at=""
while ((SECONDS < end)); do
  spawn=$(fx spawn get "$key" --format json 2>/dev/null | jq -r '"\(.status) attempts=\(.attempts) pane=\(.pane // "-") hold=\(.hold // "-")"' 2>/dev/null || echo "server unreachable")
  session=$(fx session get "$key" --format json 2>/dev/null | jq -r '"\(.state) turn=\(.turn)"' 2>/dev/null || echo "-")
  now="spawn: $spawn | session: $session"
  if [[ $now != "$last" ]]; then
    log "run $key: $now"
    last=$now
  fi
  if [[ $spawn == started* && $session == idle* ]] && git --git-dir="$remote" log --oneline master 2>/dev/null | grep -q "gameday $key"; then
    done_at=$SECONDS
    break
  fi
  sleep 3
done
finished=0
[[ -n $done_at ]] && finished=1
((finished)) || log "run $key: the session did not finish within 15 minutes"
sleep 5 # the last hooks reach the spool and the server

# The evidence is collected either way; the exit status says whether every check passed.
"$GAMEDAY_DIR/collect.sh" "$key" "$marker" && ((finished))
