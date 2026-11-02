# F2 gate: the two gamedays

Live against the deployed factory, with real leads, on scratch repos (`scripts/gameday/f2/`: `run.sh <silent-lead|seeded-bug|all> [run-id]`).
Each run files one Issue and reads the database; nobody types into a lead's pane. `<gameday>/<run>/report.md` is the verdict, the
pass line by line, with the timeline from `issue_events`, the inbox and the lead's events; `result.txt` is the same lines raw, `timeline.txt`
the script's own log. A run that fails a pass line is a finding and stays; a rerun takes a new run id (at most three per gameday).

| Gameday | Run | Result |
|-|-|-|
| silent-lead | s1 | inconclusive: the lead reported `drop` on its first turn (standing orders over the ask), nothing to observe |
| silent-lead | s2 | **pass**: sent back once, parked on the second stop, `notify:parked` sent, claim held, stop and finalize clean |
| seeded-bug | b1 | no result: the seed (`MAX_WORDS=3`) was readable and the lead fixed it in its first commit, no production check ever failed |
| seeded-bug | b2 | aborted by hand: git's `core.autocrlf=input` stripped the CR that arms the seed, caught on the timeline before the lead finished |
| seeded-bug | b3 | **pass**: the lead's own production check (`make verify` after `make deploy`) failed on the CRLF seed, the lead fixed forward, one ship, hold green, closed, finalized once, transcript archived |

`quota-checks.txt` is the quota reading before each run (`me2` week and `iu` week, in percent).

The `regression after the hold` branch of the seeded-bug pass condition (`make verify` after the hold moves the Issue back to `working`)
is coded in `seeded-bug.sh` and was not exercised: both seeded runs that reached a ship were caught by the lead before it.

## After the runs: review fixes

The scripts were tightened after s2 and b3 ran, from `/review`: the quota gate fails closed, result lines are scrubbed before they are
written, an early exit stops the Issue and tears the repo down, the scratch repo goes only after finalize and a leftover is a failed
line, a run lock, and in `seeded-bug.sh` the seed check now runs the shipped program (`--longest`, not a grep of its text) and counts
only verify failures that begin a line and precede the first ship. The runs used the earlier, looser checks. b3 re-read against the
stricter ones from its archived transcript: 1 tool results with the deployed copy's failure before the first ship, and the lead's
own run of `--longest` printed `words=4 lines=2 longest=xyz`. s2's notification was `sent` (see its report). The three-run
limit was used up for seeded-bug (b1, b2, b3) and silent-lead has one more.
