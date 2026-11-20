# Learnings

Each section below pairs a failure, with its numbers, with the rule or code it produced. The records are `docs/archive/strategy/2026-11-reset/learnings.md`, `docs/archive/rewrite-learnings.md` and `docs/decisions.md`.

## Background work at a turn's end

4 of 5 deep reviews failed on 2026-11-05 because the collector took a turn that ended with background work in flight for a finished one. Claude Code lists that work on the Stop hook as `background_tasks`: a subagent, a shell, a monitor.

- **What broke.** 4 of 5 deep reviews through the hidden transport (06:30 to 07:55 UTC) gave up on both attempts with "the reply holds no JSON object". The reviewer had started its verifier as a background subagent and ended its turn with "waiting before I give the final reply". The collector read the idle session as a finished one. It was the third time this class bit: the Stop send-back in the second package, then monitors in the sixth.
- **The same night,** one lead ended a turn with `make check` running in the background, the session compacted while idle, and no turn followed the check's end. It sat 4 h 20 min until a note woke it.
- **What changed (Issue 67).** Every consumer of a turn's end honours `background_tasks`:
  - The Stop send-back lets such a stop through.
  - The quiesce check refuses to act on such a session.
  - The steward nudges a lead that is idle with background work only after 90 minutes, against 10 for a lead with none.

<!-- snippet: apps/server/src/domains/leads/stop.ts decideStop -->
```ts
export function decideStop(facts: StopFacts): StopDecision {
  if (facts.backgroundTasks || !facts.working || !facts.factoryTurn || facts.reported) return 'let_through'
  return facts.sentBack ? 'let_through' : 'send_back'
}
```

**Example files:**

- [`stop.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/stop.ts#L34-L43): the send-back decision; background work lets the stop through.
- [`quiesce.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/quiesce.ts#L56): a session with background work in flight is never quiesced.
- [`stall.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/planning/stall.ts#L52-L56): the longer idle threshold for a lead waiting on background work.

## Unreviewed ships

369 ships landed unreviewed in the 7 days to 2026-11-17, 0.32 per closed Issue. A ship is unreviewed when the range it lands has a commit at standard or deep tier with no review covering it.

- **What broke.** Issue 1807 (filed 2026-11-17 by friction) counted the 369. By day the share fell from 0.68 on 11-11 to 0.07 on 11-16. Separately, of Issues 1640 to 1806, 12 shipped unreviewed, 11 of them with the review tool's status `stale`.
- **Three causes,** read from the lead sessions:
  - A squash commit of a multi-round review: its patch matches the rounds together, no single job.
  - A ship past a held deep review (cap 74 of 60).
  - A commit pushed after the last review that rode the merge window.
- **What changed.** The lead reviews before it takes the merge window, treats a held review as a deferral and never as a ship without one, and checks the landed squash commit. The factory still never refuses a ship for a missing review (NL23). It counts them: unreviewed ships on one in four closed Issues, with at least 3 (`min: 3`), file a friction signal.
- **What stayed open.** The covered check belongs to another repo, so Issue 1807 filed it there with the reproduction. The stale ships of multi-round squashes stay counted until it lands.

<!-- snippet: packages/contract/src/thresholds.ts unreviewed_ship -->
```ts
  unreviewed_ship: {
    min: 3,
    rate: 0.25,
    why: 'ships with no review on one in four closed Issues is a habit or a broken review path',
  },
```

**Example files:**

- [`thresholds.ts`](https://github.com/jkrumm/software-factory/blob/master/packages/contract/src/thresholds.ts#L64-L68): the rule that counts it.
- [`brief.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/brief.ts#L18): lead order 6, as Issue 1807 rewrote it.
- [`decisions.md`](https://github.com/jkrumm/software-factory/blob/master/docs/decisions.md#L34): NL23, why a missing review is counted and never refused.

## Caps that held work back

The repo's lead cap left 168.8 of 308.5 idle seat-hours unused with work queued, from 2026-11-14 18:08 to 2026-11-15 07:30 UTC. A cap is a number that keeps work out.

- **What broke.** `factory read capacity-loop` showed the cap as the largest reason seats idled with work queued, over 57 Issues. Seat caps and account windows cost 0.4 and 1.6 hours.
- **What the cap protected.** The merge window (about 10 merges an hour) and rebase conflicts: 98 of 401 sessions rebased twice or more. Lifting the cap costs more rebases per merge, not more waiting past the lock.
- **What changed (NL32).** A repo that states no `leads` takes the maximum of 64, so memory fit, load and the accounts decide. A stated `leads: N` stays and carries its reason beside it.

<!-- snippet: packages/contract/src/project-file.ts DEFAULT_LEADS -->
```ts
/**
 * The leads of a repo whose `project.yaml` states none (and of a repo with none): no cap beyond the host, whose memory
 * fit, load and accounts hold work back. A `leads: N` below it is an exception the file gives its reason for (NL32).
 */
export const DEFAULT_LEADS = MAX_LEADS
```

**Example files:**

- [`project-file.ts`](https://github.com/jkrumm/software-factory/blob/master/packages/contract/src/project-file.ts#L476-L483): the maximum and the default, one constant each.
- [`decisions.md`](https://github.com/jkrumm/software-factory/blob/master/docs/decisions.md#L123-L132): NL32 with the measured window.

## Parallel checks in one tree

Load reached 385 on 12 cores on 2026-11-04 and 578 on 2026-11-05, both from heavy commands running in parallel on the host.

- **2026-11-04.** Load reached 100 to 385 on 12 cores while two `agw check` runs, a factory `make check` and a simulator (about 180 processes) ran together. Tests timed out at 30 to 60 s, a different set each run, and passed alone.
- **2026-11-05.** About 120 test workers of another repo drove the load to 558 (00:35 to 00:58 UTC). The server lost its database lock and exited, and the first relaunch failed on its secrets. Later that morning a worker that ran `make -k check` twice in parallel reached 578 on the 5-minute average, though its brief said "once at the end".
- **What changed.** A brief is not a guard, so the host holds the line: one test slot for every repo, a second check waits for the first, and selfwatch files `load_over_ceiling` and `slot_line` when it does not hold.

The lead's brief carries the two measurements, in these two lines (the source escapes the backticks):

```text
- Never run `find`, `fd` or `bfs` from `/` or `$HOME`: one such search took 470% CPU and pushed the machine's load to 282. Search a targeted directory.
…
- One check per worktree: while your @implementer runs one, do not start your own; two in one tree ran for 31 minutes.
```

**Example files:**

- [`brief.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/brief.ts#L28): the `find` rule, with its number.
- [`brief.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/brief.ts#L38): one check per worktree.
- [`overload.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/improve/overload.ts#L35-L67): `load_over_ceiling`, the host's alarm.

## Waits with no exit

Issue 82 held Issues 83 to 85 for 6 hours on the evening of 2026-11-05, because nothing could end its wait. A wait is a stored reason an Issue is paused.

- **What broke.** Issue 82 was merged and deployed, the verify of the hold it was waiting on went red on rows from other projects, and the lead blocked. The owner fixed the cause and wrote a note. Nothing could take the Issue back: the lead's verbs are refused on a waiting Issue, `reopen` takes only a closed one, and `stop` records a drop.
- **The earlier rule had said** that every wait can end. Nothing had ever checked it.
- **What changed.** Every wait needs a way out that is not a drop. Issue 97 added the exit (`note --wake`), and a model test now fails on any wait without one. A wait with a machine exit needs the clock or the steward to end it, and a wait on a person must state which Issues it holds.

<!-- snippet: apps/server/test/work/model.test.ts checkShape -->
```ts
  if (WAITS[wait.reason].exit === 'machine') {
    // The lead's own verbs leave a timer wait too, but the lead is not the machine: the clock or the steward must.
    // `moved_up` leaves a wait only for a light lead that struggled: it is no exit the wait can count on.
    const counted = exits.filter((event) => event.kind !== 'moved_up')
    if (!counted.some((event) => (event.actor === 'factory' || event.actor === 'steward') && leaves(event))) {
      fail(`the machine wait ${wait.reason} has no exit`)
    }
    return
  }
```

**Example files:**

- [`issue.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/work/issue.ts#L38): the `WAITS` table, with each wait's exit kind.
- [`model.test.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/test/work/model.test.ts#L144-L184): the invariants checked over random event sequences.

## A green Issue without its proof

Issue 67 closed `done` on 2026-11-05 without the one thing it asked for. Closing on a green deploy is not the same as meeting the Issue's acceptance.

- **What broke.** Issue 67 closed `done` on `make verify`. Its own acceptance, one real deep review through the hidden transport, had not happened: the only hidden review since the fix was light. The ship gate checked the deploy and the verify, not the Issue's stated proof.
- **What changed.** A ship states every acceptance line as met, or not met with the reason. A `not met` is allowed and honest, and a ship that states nothing counts as friction. Issue 1809 shipped with one line met and two not, each with its reason, and the watch still passed.

<!-- snippet: packages/contract/src/thresholds.ts unstated_acceptance -->
```ts
  unstated_acceptance: {
    min: 3,
    rate: 0.25,
    why: 'ships that state nothing against the acceptance on one in four closed Issues is a habit or a brief that never asks',
  },
```

**Example files:**

- [`thresholds.ts`](https://github.com/jkrumm/software-factory/blob/master/packages/contract/src/thresholds.ts#L69-L73): the rule that counts a ship that stated nothing.
- [`brief.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/brief.ts#L18): the last sentence of order 6 states the acceptance duty.

## Research claims in a brief

Every route answered 404 on 2026-11-07 because a brief's researched claim was wrong. A claim marked "derived from source reading" is a guess until a test says otherwise.

- **What broke.** The first package's brief carried a researched form for calling the web framework's handler with a short host (`http://x/…`). Elysia reads the path at a fixed offset, and every route answered 404. The worker found it by running the test.
- **What changed.** A research claim needs a test before it goes into a brief. The test file keeps the reason beside the fix, so the next reader does not "simplify" it back.

<!-- snippet: apps/server/test/api.test.ts get -->
```ts
// Elysia's router finds the path at a fixed offset: a URL as short as `http://x/…` answers 404 for every route.
const get = (app: { handle(request: Request): Promise<Response> }, path: string) =>
  app.handle(new Request(`http://localhost${path}`))
```

**Example files:**

- [`api.test.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/test/api.test.ts#L17-L19): the request helper and why it uses `localhost`.
- [`rewrite/learnings.md`](https://github.com/jkrumm/software-factory/blob/master/docs/archive/rewrite-learnings.md#L19-L22): the entry that recorded it.

## A restart that hangs

The server never exited on SIGTERM, twice, in the first live window on 2026-11-07. Every deploy and every rollback stops the service, so a restart that does not finish is an outage.

- **What broke.** `launchctl kickstart -k` sent SIGTERM and the server kept its database connections and so its process lock. launchd's new copy gave up after 45 s on the lock.
- **Two faults.** `app.stop()` without `true` waits for an open SSE stream forever, and the server had no shutdown deadline at all.
- **What changed.** The one way the server ends on a signal is `createShutdown`: ordered steps, a step that throws is logged and the rest still run, and a 30 s deadline exits with code 1 from whatever step is stuck. A scenario holds a stream and a kept-alive socket, sends SIGTERM and boots a second server on the lock. In the second window, three deploys and a restart in a row ended on their own, with no lock left behind.

<!-- snippet: apps/server/src/shutdown.ts createShutdown -->
```ts
/**
 * The one way the server ends on a signal: the steps run in order, a step that throws is logged and the rest still run
 * (the lock must be let go even when a loop's stop failed), and the deadline ends the process with code 1 whatever
 * step it is stuck in. Exit 0 only when every step finished without error. A second signal does nothing.
 */
```

**Example files:**

- [`shutdown.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/shutdown.ts#L27-L47): the steps and the deadline.
- [`main.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/main.ts#L490-L498): the wiring, with `stop(true)` and why.

**Read more:**

- [Learnings of the reset](https://github.com/jkrumm/software-factory/blob/master/docs/archive/strategy/2026-11-reset/learnings.md): the dated record of 2026-11-04 to 2026-11-05.
- [Rewrite learnings](https://github.com/jkrumm/software-factory/blob/master/docs/archive/rewrite-learnings.md): the calls and surprises of the rewrite, 2026-11-07 to 2026-11-08.
- [Decisions](https://github.com/jkrumm/software-factory/blob/master/docs/decisions.md): every owner decision with its measurements, NL1 onward.

Next: [Running a Factory](./running.md)
