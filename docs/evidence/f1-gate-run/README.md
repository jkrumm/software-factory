# F1 gate run, 2026-10-30

**Verdict: fail against the claim as written.** The claim: two chains of waves in two repos run to their end with an
injected limit wall and one `drain` in the middle, and nobody types anything into any pane.

| Arm | Result |
|-|-|
| Chains with nothing injected (A after cleanup, B, C, D) | pass, once a bug the run found was fixed (below): 4 of 4 waves each, no input |
| Limit wall (chain D, Wave 2) | pass: one `continue` from the resume watchdog, the chain went on to Wave 4 |
| Drain at the factory (chain B) | pass: a held successor stayed held under `drain`, and started by itself 10 min 50 s after `run` |
| Drain as the claim states it (chain E): the next spawn prints `queued: drain` and starts by itself | **fail**: `rd wave` never reaches the factory, `wave-gate.py` refuses first; chain E stopped and nothing restarted it |

Owner inputs into gate panes: **0**. Anything typed into any pane came from the factory (one `continue`, plus the first
prompt of each spawn). Operator actions outside the panes are listed under "What the operator did". The run needed one
code fix (deployed mid-run) and exposed one design conflict that needs a decision.

## What broke

1. **A chain wave could never spawn its successor (fixed).** Both Wave 1s ended their turn, `rd wave` printed `queued:
   wave`, and the successors stayed held for 13 minutes. Admission's one-wave-per-repo rule counted the finished
   predecessor, which chain mode leaves open in its tab (a wave cannot close its own tab). Fix `5625f5f` (deployed as release `3ec1f17`): a `wave` session
   that is `idle` after a turn that ended in its current life no longer holds the repo (review round one: a resumed session
   that has not worked yet still holds it, `packages/server/src/sessions.ts`, tested); one mid-turn, `walled`, `blocked`, `starting` or
   `waiting` still does. The test fails on the old code. Deployed from the branch at 18:15:29Z; both held successors started
   30 s later with no input.
2. **`drain` stops a chain at the next boundary and nothing restarts it (open, needs a decision).** `rd wave` runs
   dotfiles `scripts/wave-gate.py` before it asks the factory. The gate exits 1 under a project `drain`, so the finishing
   wave writes `stopped: …` into Left behind and ends. After `queue set run` nothing starts the next wave. This matches FL1
   ("the chain stops at the boundary, enforced in `rd wave`'s gate") and contradicts the gate claim ("the queued spawn
   starts by itself"). Chain E shows it, `log.txt` has the keys. Proposed fix, in dotfiles (not an owned file here): drop
   the drain refusal from `wave-gate.py`, so the factory holds the spawn (`queued: drain`) and releases it on `run`; or keep
   FL1 as written and change the claim. The lead was told at 18:02Z through `factory session note` (the note is still
   pending, its session works).
3. **A wall whose reset is hours away holds the chain for hours (working as designed, operator error in the run).** My first
   two injections (chains A and C) sent the `PUT` for the test reading with a token `secrets-run` had redacted (HTTP 401). The
   watchdog then took the account's real 5-hour reset (about 3 h and 5 h away) from the next poll, so `a-w2` and `c-w2` stayed
   `walled` and their successors stayed held. Script fixed (`inject-wall.sh` calls `curl` inside `secrets-run`). Chain D is the
   clean injection. A and C were finished at the end by closing the two walled tabs, which freed the held successors.
4. Not investigated: `factory-gate-a-w3` took 2 start attempts (`spawns.json`).

## The wall (chain D, Wave 2)

The reset is a **test row**: the real 5-hour reset of the account (`iu`) was 23:00Z, outside the run. Right after the
hook, `PUT /quota/accounts/iu` stored a reading with `exhausted_until` 6 minutes ahead.

| Time (UTC) | Event |
|-|-|
| 18:20:32 | `factory-gate-d-w2` session_started (account iu) |
| 18:20:38.029 | `limit_stop` through `FACTORY_SESSION=… factory hook stop-failure` with a `rate_limit` payload; state `walled` |
| 18:20:38 | test row for `iu`: reset 18:26:38Z |
| 18:20:49 | the wave's own turn ended (it had spawned `d-w3`, held `wave` by the walled `d-w2`) |
| 18:31:41.609 | prompt `resume:factory-gate-d-w2:2026-10-30T18:26:38.000Z`, text `continue` (reset + 5 min 3 s) |
| 18:31:42.006 | typed (`sent_count` 1), `turn_started:2` at 18:31:42.051; delivered 18:31:52 |
| 18:31:45.9 | `turn_ended:2`; the wave found `d-w3` held and ended again (`d-w2-pane-tail.txt`) |
| 18:31:47.8 | `d-w3` admitted and started by itself, `d-w4` at 18:32:37, chain done at 18:32:57 |

One `continue`, one prompt row, no failures. **Limit of the proof:** the injected wall does not stop a live session, and
it landed 11 s before the wave ended its turn on its own, so the `continue` woke a finished wave. What it proves is the
watchdog's key, timing, delivery into an idle pane, and that the held successor starts once the wall ends. It does not
prove a wave that really stopped mid-work picks up its work after `continue` (that needs a real wall).

## The drain

Chain B (arm that passed), `factory queue set drain --project …/factory-gate-b`:

| Time (UTC) | Event |
|-|-|
| 18:16:16 | `drain` set while `b-w2` had just finished; `b-w3` was already queued (hold `wave`), now hold `drain` |
| 18:27:06 | `run` set (10 min 50 s later) |
| 18:27:07.9 | `b-w3` session_started, no input; `b-w4` 18:27:58, chain done 18:28:18 |

The drain landed after `rd wave` had created the spawn, so `rd` printed `queued: wave`, not `queued: drain`.

Chain E (the claim's order), drain set the moment `e-w2` worked (18:35:13Z): `e-w2` finished its work, `rd wave` died with
`green gate failed … the factory queue for project … is draining`, and the plan's Left behind says `stopped: …`. `run`
at 18:46:25Z; at 18:48:31Z `factory-gate-e-w3` still did not exist (`factory spawn get` 404). The chain is dead until
someone runs `rd wave`.

## Counts

| | Value |
|-|-|
| Chains | 5 (A, B, C, D, E; A and C walled by mistake, E stopped by the gate) |
| Waves run (sessions) | 18; chains B, D done 4 of 4; A and C 4 of 4 after the cleanup; E 2 of 4 |
| Turns | 19 (18 first turns, 1 second turn on `d-w2` from the `continue`) |
| Prompts typed by the factory | 1 `continue` (resume watchdog); 18 first prompts from the Runner |
| Owner inputs | 0 |
| Accounts | iu 9 spawns, me 9 (`spawns.json`); all role `wave`, Sonnet, effort high |
| Gate repos | `make check` green on B and D at the end (15 and 14 tests) |

## What the operator did (outside the gate panes)

- The scripts in `scripts/gate-run/`: `setup.sh`, `start.sh` (the two `rd wave` calls), `inject-wall.sh`, `drain.sh`,
  `watch.sh`, `when-working.sh`, `snapshot.sh`. Nothing was typed into a gate pane and no `rd say` was used.
- Deployed the fix from the branch at 18:15:29Z (`FACTORY_REF=f1-w6-gate make deploy`).
- Set and lifted the drain, injected the wall (hook and test row).
- One `factory session note` to the lead about the drain conflict.
- Cleanup: `rd close` of `a-w2` and `c-w2` at 18:50Z (walled, with held successors), then `teardown.sh`.

## Log cadence

`log.txt` has a snapshot line (sessions with state, spawns, notes pending, queue state, accounts) at every step that
mattered; the waves run for a minute each, so the 15-minute cadence of the brief was shorter than the events it would have
separated. Raw data: `events.tsv` (spool events: time, session, kind, key), `spawns.json`, `prompts.txt`,
`repos-git-log.txt`, `d-w2-pane-tail.txt`.
