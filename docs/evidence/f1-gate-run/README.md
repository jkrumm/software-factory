# F1 gate run, 2026-10-30

**Verdict, both runs against the claim: pass on everything the claim observes, one thing not proven.** Nine chains of four waves
in nine scratch repos: eight ran to their end (two of them after the first run's operator closed their walled tabs) with nobody typing anything into any pane (owner inputs 0; the factory typed the first
prompt of each spawn and three `continue` from the resume watchdog), five limit walls were injected (three walls behaved as
designed, two first-run injections were operator errors), and the drain passes both ways: held at the factory (first run, chain B)
and through `rd wave` itself (rerun, chain `y`: `queued: drain`, exit 0, starts by itself after `run`). The first run failed the
drain-through-`rd wave` half because the gate refused under `drain`; dotfiles #52 fixed it and the rerun proves it. **Not proven:**
a wave that a *real* wall stopped mid-work picking up its unfinished work after `continue`. A hook-injected wall does not stop
a live agent: in both wall runs the wave finished all its work through the wall, so `continue` woke a wave with nothing left,
and the watchdog never typed into a working wave (it waited 2 min 10 s). Detail under "Rerun".

## Rerun, 2026-10-30 (19:30Z to 19:51Z)

**Verdict: the drain through `rd wave` passes; the mid-turn wall passes except the one thing an injected wall cannot show.**
Four chains (`w`, `v` walled; `y` drained through `rd wave`; `x` an unplanned control), 16 waves, all four chains ran 4 of 4 waves to
their end, `make check` green in all four scratch repos (69, 15, 13 and 70 tests). Owner inputs into gate panes: **0**. No
code fix was needed; the run found nothing in `packages/**` to change. The factory at the start was release `9eb7ed4` (PR #8 and dotfiles #52 in).

| Arm | Chain | Result |
|-|-|-|
| Drain through `rd wave`, the chain-E way | `y` | **pass**: `rd wave` of `y-w2` printed `queued: drain` and exited 0, the wave ended its turn, `y-w3` was held `drain` for 10 min 17 s, started by itself after `run`, `y-w4` followed, chain done |
| Wall mid-turn, long Wave 2 | `v` | **pass with a limit**: wall at 2 of 8 steps, 8 min 6 s before the turn ended; session `walled` throughout, successor held, one `continue` typed 5 s after the turn ended, chain done. The wave had finished all 8 steps through the wall, so `continue` found nothing to resume |
| Wall, short Wave 2 (first attempt) | `w` | wall 42 s before the wave ended: same shape as the first run's chain D (the lengthened template was still a minute of work); one `continue`, chain done |
| Control, nothing injected | `x` | my drain landed 16 s after `x-w2` ended its turn (see below), lifted 27 s later; chain done 4 of 4 |

### The drain through `rd wave` (chain `y`)

`when-working.sh` sets the drain the moment `y-w2` is `working`, so the timing is not by hand.

| Time (UTC) | Event |
|-|-|
| 19:34:07.8 | `y-w2` `turn_started:1` |
| 19:34:09.85 | `factory queue set drain --project …/factory-gate-y` (2 s into the turn) |
| 19:34:29 | `y-w3` created by `rd wave` (hold `drain`, no account); the pane tail shows `rd wave answered queued: drain` (`y-w2-pane-tail.txt`) |
| 19:34:33.6 | `y-w2` `turn_ended:1`: the wave ended its turn, exit 0 from `rd wave` counted as the successor spawned |
| 19:44:27.3 | `factory queue set run` (10 min 17 s after the drain) |
| 19:45:56 | `y-w3` `session_started` (account iu), no input; `y-w4` 19:47:09, chain done 19:47:29 |

The 89 s between `run` and `y-w3` starting is not explained by the stored data: `queue set` makes held spawns due at once, so
it is admission (account takes one new spawn per sample, other chains were starting) or the herdr start. `spawns.assigned_at`
says 19:46:02.985, the start. Not investigated further; it is latency, not a missed start.

**Mistimed attempt (chain `x`).** My first drain call was a watcher whose first poll lost the race: the whole of `x-w2` is 25 s
(`turn_started` 19:31:47.8, `turn_ended` 19:32:16.2), my drain landed at 19:32:32, after `rd wave` had made `x-w3`. I lifted it
at 19:32:59 and let `x` finish as a control. This is the old chain-B order, not a new result. The cause was a 120 s tool
timeout on my side and doing it by hand; `y` used the script.

### The wall mid-turn (chain `v`, Wave 2)

Wave 2 of the `v` plan is eight functions, one commit and one `bun scripts/soak.ts` (a 55 s foreground run) per function. The
wave takes 10 min 30 s. The wall is injected when the repo has the third `feat:` commit (`clamp` of Wave 1 plus two of Wave 2),
by `when-commits.sh`, through `FACTORY_SESSION=… factory hook stop-failure` with a `rate_limit` payload. The reset is a **test row**:
the real 5-hour reset of the account (`me`) was 21:40Z, outside the run; `PUT /quota/accounts/me` stored a reading with
`exhausted_until` 61 s ahead.

| Time (UTC) | Event |
|-|-|
| 19:37:39 / 19:37:42.9 | `v-w2` `session_started` (account me) / `turn_started:1` |
| 19:40:02 | commit `feat: inverseLerp`, the second of eight steps (the wave was 2 min 19 s into a 10 min 30 s turn) |
| 19:40:06.96 | `limit_stop` (key `v-w2:limit_stop:1`), state `walled`; test row for `me`, reset 19:41:06Z |
| 19:46:08.076 | prompt `resume:factory-gate-v-w2:2026-10-30T19:41:06.000Z`, text `continue` (reset + 5 min 2 s); `walled` and herdr says `working`, so it waits |
| 19:48:13.6 | `turn_ended:1`: the wave finished all eight steps, the table and the close-out (8 min 6 s after the wall) |
| 19:48:18.549 | the `continue` typed (`sent_count` 1, `failures` 0), `turn_started:2` 19:48:18.6, delivered 19:48:23 |
| 19:48:30.4 | `turn_ended:2`: "Nothing is left for me to do in Wave 2" (`v-w2-pane-tail.txt`) |
| 19:48:48 | `v-w3` started (its hold `wave` lifted when the `continue` turn ended), `v-w4` 19:49:44, chain done 19:50:17 |

What this proves: a wall in the middle of a working turn makes the session `walled` and holds the repo (the successor `v-w3`
waited behind it); the watchdog queues one `continue` at reset plus 5 min, **does not type into the working wave** (it waited
2 min 10 s for the turn to end and typed 5 s after), and the chain goes on once the `continue` turn ends. One prompt row, no
failures, no second `continue`.

**What it does not prove.** The injected wall does not stop the agent: the wave worked through it and finished everything.
A real wall ends the turn, so the real case is a wave with unfinished steps at the prompt. An injected hook cannot produce
that without interrupting the pane, which the observe-only rule forbids. To prove it, either wait for a real wall or make the
interrupt a named part of the injection (a decision for the owner; nothing here depends on it).

Chain `w` (first attempt, 19:34:11.8 wall, `w-w2` ended its turn 41.8 s later, `continue` 19:40:13.4, chain done 19:43:04.8) is
the same shape on a wave that was too short; it is kept as a second `continue`.

### Counts (rerun)

| | Value |
|-|-|
| Chains | 4 (`w`, `v` walled; `y` drained; `x` control), all 4 of 4 waves |
| Waves run (sessions) | 16 |
| Turns | 18 (16 first turns, 2 second turns from the `continue`) |
| Prompts typed by the factory | 2 `continue` (resume watchdog), 16 first prompts from the Runner |
| Owner inputs | 0 |
| Accounts | iu 9 spawns, me 7; all role `wave`, Sonnet, effort high (`spawns.json`) |
| Notes | the pending drain-conflict note from the first run is still unread by its session (not part of this run) |

### What broke

Nothing in `packages/**`; no code change in this PR beyond the gate scripts (`when-commits.sh`, template `c`/`d` with
`scripts/soak.ts`, a `snapshot.sh` that lists only the run's chains).

1. **Start-up "no capacity".** `rd wave` for `w-w1` and `x-w1` printed `queued: no capacity until 2026-11-01T18:00:01.000Z` at
   19:30:20, although iu and me read 7 % and 6 % of the 5-hour window. Both started about 80 s later. The accounts were held
   for one new spawn per sample (this worker's own session had just started on iu, other waves were running), and the printed
   time is the first moment *any* account opens by its own reading (`me2`, a week away), which is misleading for a hold that ends
   with the next poll. `w-w1` shows 3 attempts in `spawns.json`, probably the same wait. Not fixed here; for the owner.
2. **My timing, not the factory's.** The `x` drain (above), and the first `w` template being too fast to put a wall mid-turn.
   Both are why there are four chains.

### What the operator did (outside the gate panes)

`setup.sh`, `start.sh`, `when-working.sh … drain.sh on` (chain `y`), `when-commits.sh … inject-wall.sh` (chains `w`, `v`),
`drain.sh off` (`x` at 19:32:59, `y` at 19:44:26), `snapshot.sh`, `watch.sh`. The 15-minute cadence of the brief
is in `rerun/log.txt` (snapshots at 19:30, 19:32, 19:35, 19:36, 19:44, 19:47, 19:51: the run is 21 minutes, so the 15-minute
line is dense). No `rd say`, no typing, no `secrets` reads by hand. Raw data in `rerun/`: `log.txt`, `events.tsv`, `spawns.json`,
`prompts.txt`, `repos-git-log.txt`, `y-w2-pane-tail.txt`, `v-w2-pane-tail.txt`, `w-w2-pane-tail.txt`, `when-*.out`.


## First run

**First run verdict: fail against the claim as written.** The claim: two chains of waves in two repos run to their end with an
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

### What broke

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

### The wall (chain D, Wave 2)

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

### The drain

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

### Counts

| | Value |
|-|-|
| Chains | 5 (A, B, C, D, E; A and C walled by mistake, E stopped by the gate) |
| Waves run (sessions) | 18; chains B, D done 4 of 4; A and C 4 of 4 after the cleanup; E 2 of 4 |
| Turns | 19 (18 first turns, 1 second turn on `d-w2` from the `continue`) |
| Prompts typed by the factory | 1 `continue` (resume watchdog); 18 first prompts from the Runner |
| Owner inputs | 0 |
| Accounts | iu 9 spawns, me 9 (`spawns.json`); all role `wave`, Sonnet, effort high |
| Gate repos | `make check` green on B and D at the end (15 and 14 tests) |

### What the operator did (outside the gate panes)

- The scripts in `scripts/gate-run/`: `setup.sh`, `start.sh` (the two `rd wave` calls), `inject-wall.sh`, `drain.sh`,
  `watch.sh`, `when-working.sh`, `snapshot.sh`. Nothing was typed into a gate pane and no `rd say` was used.
- Deployed the fix from the branch at 18:15:29Z (`FACTORY_REF=f1-w6-gate make deploy`).
- Set and lifted the drain, injected the wall (hook and test row).
- One `factory session note` to the lead about the drain conflict.
- Cleanup: `rd close` of `a-w2` and `c-w2` at 18:50Z (walled, with held successors), then `teardown.sh`.

### Log cadence

`log.txt` has a snapshot line (sessions with state, spawns, notes pending, queue state, accounts) at every step that
mattered; the waves run for a minute each, so the 15-minute cadence of the brief was shorter than the events it would have
separated. Raw data: `events.tsv` (spool events: time, session, kind, key), `spawns.json`, `prompts.txt`,
`repos-git-log.txt`, `d-w2-pane-tail.txt`.
