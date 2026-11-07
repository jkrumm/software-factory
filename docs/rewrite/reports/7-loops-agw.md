# Package 7: Loops and agw, report

**Done: the factory's recurring work is one set of named loops on one runner, the Judge, the steward and triage ask agw through one port, and `factory-steward`, `factory-triage` and an extended `factory-ask` are deployed in agent-workflows; nothing stays `settling`.** Branch `rw/7-loops-agw` on `854bb9c`: commits listed under What changed, plus this report. agent-workflows: three commits on its `master`, deployed (`97dac43`), `make verify` PASS. `make check` is green here; there it fails on one test that already fails on master (open point 1).

## What changed

### software-factory

- **`kernel/agw.ts`, `adapters/agw/`**: `AgwPort.run({workflow, input, key, output})` returns `Result<output, PortError>`. `port.ts` runs `agw <workflow> --format json --idempotency-key <key>` with the input on stdin and reads the **run envelope** (`{runId, status, output}`) the real CLI prints (the thin `agwJudge` of package 6 parsed stdout as the verdict, which the real agw never prints). Exit 10 is pending: the run id comes from the envelope or the printed hint and `agw run wait <runId>` runs until it ends. One **30-minute hang guard** covers the whole call, pending waits included; it kills the process group and lets the pipes go after 500 ms. `AGW_PURPOSE` is `software-factory.<workflow>`. Adapters on top: `judge.ts` (`factory-ask`), `steward.ts` (`factory-steward`, and `factory-triage` in settle mode), `amend.ts` (intake's `TriageWorkflow`: `factory-triage` in amend mode, the Issue named must be one it was shown). `adapters/agw-ask/judge.ts` and `adapters/intake/triage.ts` (the stub) are deleted. `kernel/scrub.ts` is the credential scrubber, moved out of `domains/checkpoints/decision.ts` (which re-exports it) because two adapters need it.
- **`packages/contract/src/loops.ts`**: the wire shapes (`JudgeInputWire`, `StewardStall`/`StewardAnswer`/`StewardDecision`, `TriageRequest`/`TriageAnswer`) and the routes' `LoopView`, `LoopList`, `LoopRunReply`. **`packages/contract/fixtures/loops.json`** is the one fixture: this repo parses it with these schemas (`apps/server/test/loops/wire.test.ts`), agent-workflows parses the same bytes with the workflows' schemas (`packages/host/test/fixtures/software-factory-loops.json`).
- **`app/loops/`**:
  - `runner.ts`: a loop is `{name, intervalMs, onChange, maxPasses, run}`. Interval or a change kick; one pass at a time (leads: up to 4, as package 4 had it, because a worktree takes minutes); a kick during a pass runs one more after it; `changed(madeBy)` kicks every listening loop but the maker (**the loop guard**; dropped kicks are counted and shown); interval 0 is off, no kick starts it; `stop(grace)` gives a pass in an agw call a grace and no more.
  - `settings.ts`: `FACTORY_TICK_MS` (default 10 s) and one `FACTORY_LOOP_<NAME>_MS` per loop; `FACTORY_STEWARD_MIN_STALL_MS` (2 min), `FACTORY_STEWARD_RETRY_MS` (10 min), `FACTORY_SETTLE_TIMEOUT_MS` (15 min), `FACTORY_BLOCKED_CHECKS` (6).
  - `steward.ts`, `triage.ts`, `claim.ts` (claim and commit a round of an ask).
- **Loops on the runner** (`main.ts`): `leads` (spool, lost leads, outbox), `planning` (planning pass then admission), `watch`, `settle`, `send` (package 6's two timers), `steward`, `triage`. Their passes are unchanged; `compose-leads.ts` and `compose-planning.ts` lost their `setInterval` and expose `tick()`/`pass()`. `/health`'s `tickAt` is `runner.lastOkAt('leads')`. Intake's pollers and settle keep their own schedule (`adapters/intake/schedule.ts`, package 2). `FACTORY_CHECKPOINT_PASS_MS` is retired: the checkpoint passes are the `settle` and `send` loops. A unit test fails on any `setInterval` outside the runner and the listed helpers.
- **`domains/loops/`** (pure): `stall.ts` (`StallFacts`, `decideStall`, `checkAnswer`, `stallRequest`, `fallbackDecision`), `settle.ts` (`settleRule`, `checkSettle`, `settleRequest`), `calls.ts` (`planCall`), `ports.ts`. **`migrations/0700_loops.sql`**: `loop_calls` (one row per ask of a workflow: key, loop, Issue, subject, round, lease, outcome, answer). **`read/loops.ts`**: stalled Issues, settling Issues with their signal, the open Issues beside one, watches whose last N checks were all blocked.
- **`api/loops.ts`**: `loop list`, `loop run <name>` (one pass now, a running pass is waited for). Generated into the CLI.
- **`domains/work/table.ts`, `events.ts`, `app/checkpoints.ts`** (outside the folders `parallel.md` lists; the brief makes the shared files mine now): the steward may send `asked`, only from a stall and for the attempt there is; `askDecision` takes `by` and a `salt`. Without it a Decision could not be raised from a stall (the machine took `asked` from a lead only).
- **Tests**: `apps/server/test/loops/{port,runner,rules,wire,timers}.test.ts` (38), `tests/scenarios/loops/{loops,guard,support}.ts` (13 scenarios), fakes `agw-envelope.ts`, `agw-loops.ts` (the run envelope, `factory-steward`, `factory-triage`, `run wait`, a pending mode).

### How a stall and a settling Issue are handled

| Cause | Rules (no agw) | Else |
|-|-|-|
| `wall` | wake once the account's window is open or unknown | wait |
| any with a note the lead has not heard | wake (or requeue for `lead_gone`), the wake's `note_lead` delivers it | |
| `unreported` | wake, twice per attempt | ask |
| `blocked`, `regressed` | | ask `factory-steward` |
| `lead_gone` | requeue when a note arrived | ask; never a Decision (an answer cannot start a new attempt); left stalled after 3 unusable answers |

An ask is one row in `loop_calls` per round: claim and commit, call with no transaction open, record. An answered round is reused by a replayed pass; a failed or refused round is retried after 10 minutes, up to 3 rounds, then the factory raises a Decision of its own (not for `lead_gone`). An open call whose process stopped is retaken under its own key at the next boot (`lapseOpen`, `retakeCall`), so agw hands back the run it has. A `raise_decision` answer goes through `askDecision` (policy, Judge, default, owner), keyed by the wait it answers. A watch with 6 blocked checks in a row is told to its lead once, as a note (the machine has no stall for a watching Issue).

Triage settles every `settling` Issue: by rule when it is an incident, was filed from an alert, or nothing else is open in its repo; else `factory-triage` names the Issues it must wait for, checked against what it was shown and again by planning (cycle or closed blocker: settled with no edges). A refused or missing answer leaves it `settling` until the steward settles it with no edges after the timeout.

### agent-workflows (`master`, deployed `97dac43`)

- `factory-steward` and `factory-triage`: capability (prompt, fence, schema, guard), workflow, module, README, route on `EASY` (Haiku high), no eval set (RS13). The CLI reads the stall as the `stall` property and the triage request as `request`. Guards run after the step: `requeue` only for `lead_gone`, `wake` and a Decision never for it, a Decision's labels, recommendation and reversible default; triage names only Issues it was shown, no self edge, none twice.
- `factory-ask`: the input is `ask: today's shape | the new Decision`; the Decision becomes today's ask (options are the labels, the facts carry the form, the costs, reversibility and the precedents with worth-asking), so one seat judges both. The prompt knows an irreversible option is never the answer and how to read precedents; `guardJudge` holds the first in code; an assembled ask over the cap is refused whole, never cut. Today's shape is untouched: its tests are unchanged and green. **Route not changed**: `factory.ask` stays `FAST` (Haiku none); the architecture names Haiku high, a one-line change (`...EASY.call`), left because nothing measures that it helps (no eval set).
- Commits: `8c33284` (workflows), `cb89330` (review fixes), `97dac43` (no Decision for `lead_gone`).

## `make check`

software-factory (`rw/7-loops-agw`):

```
==> format (oxfmt --check)
All matched files use the correct format.
==> lint (oxlint --type-aware)
==> shellcheck
==> typecheck (tsc --noEmit)
==> boundaries (scripts/boundaries.ts)
boundaries hold
==> retired words (scripts/retired-words.ts)
no retired words
==> Issue diagram is current (apps/server/scripts/issue-diagram.ts --check)
==> generated CLI is current (apps/cli/scripts/generate.ts --check)
==> unit tests (bun test apps packages scripts)
 759 pass
 0 fail
 5039 expect() calls
Ran 759 tests across 56 files. [46.49s]
==> scenarios (bun test tests)
 98 pass
 0 fail
 563 expect() calls
Ran 98 tests across 22 files. [105.87s]
==> check passed
```

agent-workflows (full run before the last commit; the last commit's tests run alone, 11 pass in `factory-steward.test.ts`):

```
 4196 pass
 55 skip
 1 fail
Ran 4252 tests across 246 files. [419.70s]
(fail) review stats through the real flow > prepare, submit and dispose land in the numbers [244.35ms]
  Expected: >= 0   Received: -0.04     packages/host/test/review-stats.test.ts:319
```

`make deploy` and `make verify` there: `deploy OK: 97dac4385887 healthy (host audio)`, `verify: PASS`.

## Acceptance

Scenarios with the fake agw (`tests/scenarios/loops`), through `factory loop run <name>`, `signal file`, `checkpoint pass`, `capacity admit`:

- A stalled Issue whose cause is gone (`wall`, no window closed; and a note that arrived) is woken by the steward, **zero** `factory-steward` calls.
- A `blocked` Issue the rules do not read asks `factory-steward` once, acts on the answer (`noted` then `woken`, both by the steward, back to `working`); a replayed pass: still one call. An answer that ends nothing is a round spent: three passes, one call, Issue still stalled, row `rejected`.
- `raise_decision`: two Issues, the Judge settles one (no page), passes the other (one decision page); a second stall of the same Issue is a new Decision; a `lead_gone` Issue is refused a Decision.
- An unsure owner signal asks `factory-triage` (mode amend) and amends the Issue it names; an answer naming `issue_9999` is refused and the signal is filed anew.
- Nothing stays settling: an owner signal filed as a new Issue is settled by `loop run triage` and admitted by `capacity admit` without anyone calling `planning settle`; an Issue with nothing open beside it is settled with no agw call; triage names an edge (the Issue waits); a refused answer leaves it settling, a second pass inside the wait asks nothing, and after the timeout the steward settles it.
- A loop's own note never fires that loop again: with the steward on a one-hour clock, a pass that wakes an Issue ends with `runs 1, kicks 0, droppedKicks 1`; the same scenario runs the fake in pending mode (`exit 10`, then `agw run wait`).
- Every timer of packages 3 to 6 is a loop: `loop list` names seven, and a unit test fails on any other `setInterval`.

**Live, against the deployed agw, through this repo's adapters** (`/tmp` script importing `adapters/agw/*`; the first attempt failed with `x-agw-purpose must be 1-64 of [A-Za-z0-9_.-]`, fixed and tested; this is the run on the final code):

```
## factory-steward (blocked stall, a note says the cause is gone)
{
  "ok": true,
  "value": {
    "action": "wake",
    "note": "The staging database is back, as noted in the stall record. Confirm it is reachable, then resume the checkout total fix from where you stopped.",
    "reason": "Blocked on the staging database, which the stall notes say is back; first steward wake, no restarts or regressions, so a note can end the stall.",
    "decision": null
  }
}

## factory-steward (no rule, no note: a Decision?)
{
  "ok": true,
  "value": {
    "action": "raise_decision",
    "note": "",
    "reason": "Same blocked stall repeated (v9 and v11, legacy endpoint question) after one steward wake, so a wake would not fix it; the owner must choose how to handle the legacy endpoint.",
    "decision": {
      "question": "Should the checkout total fix keep the legacy endpoint?",
      "recommendation": "Keep both behind a flag",
      "checked": "The stall history shows the lead blocked twice on the same legacy endpoint question, and one steward wake did not resolve it. The stall detail gives no information on who calls the legacy endpoint or how much traffic it gets.",
      "options": [
        {
          "label": "Keep the legacy endpoint",
          "reversible": true,
          "cost": "The checkout total fix ships alongside the old endpoint, so the old code path and its maintenance cost remain."
        },
        {
          "label": "Remove the legacy endpoint",
          "reversible": false,
          "cost": "Any caller still using the endpoint breaks, and restoring it later means re-implementing it."
        },
        {
          "label": "Keep both behind a flag",
          "reversible": true,
          "cost": "The flag adds configuration and a small amount of code until the legacy path is retired."
        }
      ],
      "noAnswer": {
        "consequence": "The Issue stays stalled and the lead does not resume work on the checkout total fix.",
        "default": "Keep the legacy endpoint",
        "waitMinutes": 240
      }
    }
  }
}

## factory-ask, new shape (JudgeInput) through agwJudge
{
  "ok": true,
  "value": {
    "verdict": "answer",
    "answer": "pino",
    "reason": "Both options are reversible, the default is the lead's recommendation, and an owner-settled precedent in example-worker chose pino with the owner saying it need not have been asked.",
    "source": "precedent: [example-worker] Which logging library for the worker? -> pino (settled by owner; the owner said it need not have been asked)"
  }
}

## factory-ask, old shape (today’s ask) through the agw port
{
  "ok": true,
  "value": {
    "verdict": "answer",
    "answer": "make check",
    "reason": "Plan excerpt AGENTS.md states make check is the gate; a reversible engineering question with no owner-class concern.",
    "source": "plan: AGENTS.md: `make check` is the gate."
  }
}

## factory-triage settle through agwSettle
{
  "ok": true,
  "value": {
    "amend": null,
    "after": [],
    "kind": null,
    "size": null,
    "reason": "Issue_20 adds coupon display to the checkout summary; issue_12 (checkout total fix) may touch the same code, but the request has no body to confirm a dependency, and issue_15 (dark theme) is unrelated, so nothing is clearly required first."
  }
}

## factory-triage amend through agwAmend (intake’s port)
{
  "ok": true,
  "value": {
    "amend": "issue_12"
  }
}
```

## Ports declared and the stubs main.ts used

| Port | Where | Real one |
|-|-|-|
| `AgwPort` | `kernel/agw.ts` | `agwPort({bin})` in `main.ts` |
| `StewardWorkflow`, `SettleWorkflow` | `domains/loops/ports.ts` | `agwSteward`, `agwSettle` |
| `LoopStore`, `LoopReads` | `domains/loops/ports.ts` | `postgresLoopStore`, `loopReads` |
| `JudgePort`, `TriageWorkflow` (packages 6, 2) | their domains | `agwJudge`, `agwAmend`: the stubs are gone |

No stub is left in `main.ts` for this package. The steward uses capacity's `Seats` and `Windows` (package 3, already wired) and planning's `settleIssue` and the checkpoints' `askDecision` as use cases.

## Events recorded on Issues

| Event | From | Actor |
|-|-|-|
| `woken` (detail begins `steward: `, keyed by Issue and wait) | `stewardPass`: wake, requeue, deliver | steward |
| `noted` (keyed by Issue and wait) | the steward's wake with a note | steward |
| `noted` (keyed by watch) | a blocked checkout told to the lead | steward |
| `asked` | `raise` through `askDecision` | steward |
| `settled` | `triagePass`, the steward's timeout (planning's `settleIssue`) | factory |

## Review outcome

`/review` deep, thread `rw-7-loops-agw`.

- **agent-workflows** `b5c3116..8c33284` (`rv_xcjsm6lkhhbclbwhdios`): 1 important, 2 nits, all `fixed` in `cb89330` with tests: the Decision's facts were silently cut at the cap (now refused whole), `guardJudge` looked at the first of duplicate labels, the routes README omitted the `hermes.*` routes. The `lead_gone` guard (`97dac43`) came from the other review.
- **software-factory** `854bb9c..HEAD`, round 1 (`rv_o6okkymaapqutih5qboj`): 2 important, 2 nits.
  - A Decision for a `lead_gone` stall would put the Issue back to `working` with no lead and nothing to start one: fixed, a `lead_gone` stall is never given a Decision (here and in the workflow's guard and prompt).
  - A second identical stall was never put to the owner (`askDecision` replayed the first Decision): fixed, the Decision's key includes the wait it answers; the scenario failed before the fix.
  - Shutdown waited out an agw call: fixed, `runner.stop(10 s)`, and an open call is taken up again at boot under its own key (`lapseOpen`, `retakeCall`), so agw hands back the run it has (this follows `rules/agent-limits.md`: a redeploy never discards an episode).
  - The pass looks at the first 20 stalled Issues by id: `intentional`, widened to 100; a rotation needs a last-looked fact no table keeps.
- Round 2 (`rv_lnu2pe6pynmdtg6mm4fl`): **clean**, 0 important, 2 nits. The restart path (`retakeCall`, `lapseOpen`) had no test: fixed, `apps/server/test/loops/store.test.ts` on a real Postgres (claim, lapse at boot, retake once under the same key, then backoff). The exhausted `lead_gone` stall keeping its place among the first 100: `intentional`, as in round 1 (open point 9).

## Open points

1. **agent-workflows `make check` is red on master too.** `review-stats.test.ts:319` expects `wallS.p50 >= 0` and gets `-0.04`: the job's `created_at` is stamped by Postgres and `submitted_at` by the app, and the two clocks differ by about 40 ms here. Not touched; reproduced on a clean master checkout.
2. **Words without a place in `docs/language.md`**: *pass* (one run of a loop), *round* (the nth ask of a workflow about one subject), *retake*, *kick*, *settle timeout*. The loop names (`leads`, `planning`, `watch`, `settle`, `send`, `steward`, `triage`) are the ones `docs/architecture.md` has, plus the two passes of the checkpoints.
3. **Shared-file changes I made**: the machine (`asked` from the steward, from a stall only), `askDecision` (`by`, `salt`), `compose-leads.ts` and `compose-planning.ts` (their timers), `checkpoint-settings.ts` (`FACTORY_CHECKPOINT_PASS_MS` and `FACTORY_AGW_BIN` moved: the agw binary is `settings.agwBin`), `decision.ts` (`scrub` lives in the kernel). `docs/language.md`'s diagram is unchanged: its generator does not show the steward's `asked`.
4. **Settings for package 9's `scripts/env-file.sh`**: `FACTORY_LOOP_{LEADS,PLANNING,WATCH,SETTLE,SEND,STEWARD,TRIAGE}_MS`, `FACTORY_STEWARD_MIN_STALL_MS`, `FACTORY_STEWARD_RETRY_MS`, `FACTORY_SETTLE_TIMEOUT_MS`, `FACTORY_BLOCKED_CHECKS`. `FACTORY_CHECKPOINT_PASS_MS` is retired and an old file that sets it is ignored; `reports/6-checkpoints.md` and `learnings.md` still describe it.
5. **A blocked checkout can only be told, not stalled.** The machine has no path from `watching` to a stall, so the steward notes the lead once per watch. If the lead is gone nothing hears it; the note stands on the Issue. A `watching -> waiting(blocked)` cell would give the steward a real action.
6. **A steward Decision's answer reaches the lead as `your Decision <id> was answered`** (the note text is package 4's) though the lead did not ask it; the question and the answer are in the note. An answer "drop" is the lead's to act on (it closes with its verb); the owner's `cancel` is package 8's.
7. **The steward's rules do not re-check `blocked` or `regressed`** (no cause that code can test without running `make verify`, which never runs on a tick); they go to the workflow. A rule that reads the project's checks would turn some of these into wakes.
8. **Intake's pollers and settle pass keep `selfPaced`** (package 2's). Folding them into the runner is a change to package 2's composition; they are not in the brief's list.
9. **Stalls beyond 100** keep the first 100 by id; a rotation needs a last-looked column.
10. **Triage shows the Issues of the Issue's own repo only** (at most 40, newest first); an edge to another repo's Issue needs the cross-project chain, which the queue loop (after the cutover) is for.
