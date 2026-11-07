#!/usr/bin/env bash
# Run by the cutover runbook through bash (`bash core-stop.sh core_stop 40`; sourced only by its test and by bash: the PID lists are
# word-split, which zsh, the mini's login shell, does not do): stop or restart the core's LaunchAgent without ever leaving it half dead.
#
# A stop sends SIGTERM and waits; the server ends itself within its shutdown deadline, but window 1 saw it twice not end
# (an orphan holding the database lock). So the PIDs are read from launchd BEFORE the stop, and after the grace a PID that
# still lives is killed by number, never by pattern (`pkill -f` has killed other people's processes). Said out loud each time.
#
#   core_pids                    the job's PID and its children's (the server is the child of the secrets-run wrapper), one per line
#   reap <grace-s> <pid>...      wait up to the grace for each PID to end; kill the ones that did not, and say so
#   core_stop <grace-s>          core_pids, launchctl bootout, reap
#   core_restart <grace-s>       core_pids, launchctl kickstart -k, reap the old PIDs (the new copy has new ones)
#
# The grace: 40 for the new core (its own deadline is 30 s); 250 for the old core (its plist's ExitTimeOut is 240).
# shellcheck disable=SC2155
CORE_LABEL=${CORE_LABEL:-com.jkrumm.software-factory}

core_pids() {
  local job child
  job=$(launchctl print "gui/$(id -u)/$CORE_LABEL" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }')
  [[ -n $job ]] || return 0
  echo "$job"
  for child in $(pgrep -P "$job" 2>/dev/null); do
    echo "$child"
    pgrep -P "$child" 2>/dev/null || true
  done
}

_alive() { kill -0 "$1" 2>/dev/null; }

reap() {
  local grace=$1 i=0 p left
  shift
  [[ $# -gt 0 ]] || { echo "reap: no PID was running before the stop"; return 0; }
  while ((i < grace)); do
    left=0
    for p in "$@"; do _alive "$p" && left=1; done
    ((left)) || { echo "reap: every PID ($*) ended on its own"; return 0; }
    sleep 1
    i=$((i + 1))
  done
  for p in "$@"; do
    _alive "$p" || continue
    echo "reap: PID $p is still alive after ${grace}s ($(ps -o command= -p "$p" 2>/dev/null | cut -c1-80)): kill $p"
    kill "$p" 2>/dev/null || true
    sleep 3
    if _alive "$p"; then echo "reap: PID $p ignored SIGTERM: kill -9 $p"; kill -9 "$p" 2>/dev/null || true; fi
  done
}

core_stop() {
  local pids
  pids=$(core_pids | tr '\n' ' ')
  echo "core_stop: PIDs before the stop: ${pids:-none}"
  launchctl bootout "gui/$(id -u)/$CORE_LABEL" 2>/dev/null || true
  # shellcheck disable=SC2086 # the PIDs are numbers, split on purpose
  reap "$1" $pids
}

core_restart() {
  local pids
  pids=$(core_pids | tr '\n' ' ')
  echo "core_restart: PIDs before the restart: ${pids:-none}"
  launchctl kickstart -k "gui/$(id -u)/$CORE_LABEL"
  # shellcheck disable=SC2086
  reap "$1" $pids
}

# `bash core-stop.sh <function> <args>` runs one of the functions above; sourced, it only defines them.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  case ${1:-} in
    core_pids | reap | core_stop | core_restart) "$@" ;;
    *) echo "usage: bash core-stop.sh core_pids | core_stop <grace-s> | core_restart <grace-s> | reap <grace-s> <pid>..." >&2; exit 2 ;;
  esac
fi
