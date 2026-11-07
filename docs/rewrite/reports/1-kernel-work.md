# Package 1: Kernel and work, report

**Done: the kernel, the Issue as a total state machine with its model test and generated diagram, and the one write
path that stores an event, the new state and its effects in one transaction.** Branch `rw/1-kernel-work`, eight commits
on `97c564f` (the brief's base; `rewrite` has moved on since), this report the ninth. `make check` is green.

## What changed

- **`apps/server/src/kernel/`** (imports nothing else of the server): `result.ts` (`Result<T, E = PortError>`, `ok`,
  `err`, `portError`; `ok` is `Result<T, never>` so a callback's error type infers), `ids.ts` (`Id<K>` branded per kind,
  `IssueId`, `EventId`, the `IdSource` port, `systemIds` as `<kind>_<uuidv7>`, `sequentialIds` for tests, `idOf` to
  read one back), `clock.ts` (`Clock`, `systemClock`, `fixedClock`), `keys.ts` (`key(...parts)`: parts joined by `:`,
  with `%` and `:` escaped so two part lists never make one key; `Key` is branded), `events.ts` (`ACTORS`, the
  `EventEnvelope`: id, Issue id, key, kind, payload, actor, at, the version it produced or null, causation), `index.ts`.
- **`apps/server/src/domains/work/`**, pure:
  - `issue.ts`: states, kinds, origins, outcomes, `WAITS` (each reason: `exit` machine or person, `stall`, how it
    ends), `WaitSpec` (a person's wait always `holds` a checkpoint `{id, summary}`), `Wait` (+ `since`, `told`), the
    `Issue` snapshot with its derived counts, the thresholds.
  - `events.ts`: the 21 event kinds with zod payloads (`PAYLOADS`), `SENDERS` per kind, `parseIssueEvent`.
  - `effects.ts`: effects as data (`start_lead`, `note_lead`, `start_watch`, `finalize`), their key builders,
    `OUTLIVES_CLOSE`, `retryDelayMs`.
  - `table.ts`: `Cell`, `Ctx<E>`, `Table = { [S in State]: { [E in EventKind]: (ctx: Ctx<E>) => Cell } }`, and `TABLE`,
    every one of the 126 cells written out.
  - `machine.ts`: `file`, `apply` (sender rule, then the cell), `replay` (folds the stored transitions, never decides
    again). `ports.ts`: `WorkStore`, `StoredEvent`, `ClaimedEffect`, `EffectRun`, `EffectPorts`.
  - `explore.ts`: the event space (`candidates`) and the reachable `edges()`, shared by the model test and the diagram.
    `diagram.ts`: the generated block.
- **`apps/server/src/app/`**: `unit-of-work.ts` (the port: `run` commits on ok, rolls back on an error result, maps a
  dead database to `PortError`; `inTransaction`), `issues.ts` (`recordIn`, `fileIn` inside a caller's transaction;
  `recordIssueEvent`, `fileIssue` in their own), `outbox.ts` (`runOutbox`: claim and commit, call each port with no
  transaction open, a programming error if one is, record in a new transaction).
- **`apps/server/src/adapters/postgres/`**: `unit-of-work.ts` (the only `.begin` besides `migrate.ts`; an
  `AsyncLocalStorage` marks the transaction's call chain), `work-store.ts` (the SQL; rows parsed with zod).
- **`apps/server/migrations/0002_work.sql`**: `issues` (`id`, `repo`, `state`, `wait_reason`, `outcome`, `version`, with
  CHECKs tying `waiting` to a reason and `closed` to an outcome), `issue_events` (every event a fact, refused and ignored
  too; `key` unique across all Issues; `version` unique per Issue and set only when applied; the transition), the
  outbox `issue_effects` (`key` primary, `version` and `position` order an Issue's effects, `not_before`,
  `claimed_until`, `done_at`, `cancelled_at`) and `issue_effect_runs` (one row per port call; failures are counted
  from it).
- **`apps/server/src/api/internal-test.ts`** and **`packages/contract/src/internal-test.ts`**: `POST
  /internal/test/issues` and `POST /internal/test/issues/:id/events`, mounted only with `FACTORY_INTERNAL_TEST_ROUTES=1`
  (`settings.ts`), so the OpenAPI document and the generated CLI never have them (a test asserts both). Package 8
  deletes the two files and the setting. `main.ts` composes the unit of work and the work store.
- **`apps/server/scripts/issue-diagram.ts`** (`--check`), a `make check` step, and the marker block at the end of
  `docs/language.md` under "The Issue, as the code has it" (the only edit there).
- **`scripts/boundaries.ts`**: two rules, each with a failing and a passing fixture (three fixture pairs). Package 0's
  rules hold.
- **`.oxlintrc.json`**: `ban-ts-comment` now refuses `@ts-expect-error` everywhere but
  `apps/server/test/work/table-types.test.ts`, where it needs a description.
- **Tests**: `test/kernel.test.ts`; `test/work/{model,machine,table-types,diagram}.test.ts`; `test/work-write.test.ts`
  (Postgres); `tests/scenarios/issue-write.test.ts`; `boot.test.ts` now expects `0002_work.sql`.

## Acceptance

- **A missing cell fails `tsc`:** `table-types.test.ts` holds four `@ts-expect-error` fixtures: a state without a cell,
  a table without a state, a cell moving to a state the machine lacks, and a move to `closed` with no outcome. An unused
  directive fails `tsc`. Checked by hand as well: deleting `regressed: regress` from the real `TABLE` gives `TS2741:
  Property 'regressed' is missing`.
- **Model test:** 10,000 sequences of up to 60 events in 1.4 s, each from seed `n`. Half the picks favour events that
  apply, so a sequence goes deep (a third lead gone, a third regression, a reopen); one in ten has a random actor. The
  invariants: no cell throws; a refusal or ignore names its reason; an applied event raises the version by one, and a
  refused or ignored one changes nothing; `closed` leaves only through `reopened`, into `queued`; `waiting` holds
  exactly when there is a wait, `closed` exactly when there is an outcome; every machine wait has an exit that a
  sender other than the owner can take; every wait on a person holds a checkpoint with an id and a summary, and has an
  exit; one key never names two different effects; every note recorded during a wait reaches the lead in the
  `note_lead` that ends it; replaying the applied log gives the same Issue. The run also asserts it reached every
  state and every wait reason. A failure prints `model seed <n>, step <i>` and the trace;
  `WORK_MODEL_SEED=<n> bun test apps/server/test/work` replays that sequence alone. A test plants an invariant and checks
  that the message names a seed which fails the same way again.
- **Diagram:** generated from `TABLE` by walking `edges()`; `make check` fails on a stale block (tried by hand: exit 1
  with `the Issue diagram is stale`), and `diagram.test.ts` asserts it too.
- **Write path:** `work-write.test.ts` on a private cluster: event, state and outbox stored together. A refusal is
  stored with a null version and moves nothing. The same key again is `replayed` and nothing doubles; a key reused for
  another kind is `key_taken`. A stale version (a store that reads one event behind) is `{ kind: 'version_conflict' }`,
  nothing of it is stored, and the retry applies. Four writers at once: each applies or conflicts, and the version
  counts the applied ones. A close cancels the open effects but `finalize`. The tables accept every state, wait reason
  and outcome of the machine. The outbox: every fake port records `uow.inTransaction()`, and every call recorded `false`.
  `runOutbox` called inside `uow.run` throws `a port is never called inside a transaction` before any port is called.
  A failed effect waits 30 s and holds back its Issue's next effect. A runner that dies after the call: the claim
  lapses, the port is asked again with the same key, and it acts once.
- **Scenarios** (`issue-write.test.ts`, real server process and Postgres): filed, settled, admitted, lead started,
  shipped, watch passed, landing in `closed`/`done` at version 6, with the six applied events in order and the outbox
  holding `start_lead`, `start_watch` and `finalize`, all undone (nothing runs the outbox yet). The same seven requests
  again are each `replayed`, and the log, the outbox and the Issue count are unchanged. A lead verb on the closed Issue
  is refused, stored, and keeps version 6. Neither `hc` nor `agw` was called.

## `make check`

```
==> install (bun install --frozen-lockfile)
Checked 44 installs across 100 packages (no changes) [6.00ms]
==> format (oxfmt --check)
All matched files use the correct format.
Finished in 8ms on 84 files using 12 threads.
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
 121 pass
 0 fail
 403 expect() calls
Ran 121 tests across 14 files. [3.90s]
==> scenarios (bun test tests)
 10 pass
 0 fail
 35 expect() calls
Ran 10 tests across 2 files. [3.63s]
==> check passed
```

## The state table

- **States:** `settling` (every Issue begins here), `queued`, `working`, `waiting`, `watching`, `closed`.
- **Events** (sender in brackets):
  - Intake and capacity: `filed` (factory, owner), `settled` (factory), `admitted` (factory: the next attempt,
    `start_lead`).
  - Leads: `lead_started {attempt, terminal}` (factory), `lead_gone {attempt, detail}` (factory: to `queued` with
    `finalize` twice, the third time a `lead_gone` stall).
  - Notes: `noted {text}` (owner, factory, steward, judge).
  - Checkpoints: `asked {attempt, decision}` (lead), `answered {decision, answer}` (owner, judge, factory),
    `submitted {attempt, artifact}` (lead), `verdict_given {artifact, verdict}` (owner), `errand_raised {attempt,
    errand}` (lead), `errand_done {errand}` (owner).
  - Waits: `deferred {attempt, until | after}` (lead), `stalled {attempt, cause: wall|unreported|blocked}` (factory for
    `wall` and `unreported`, lead for `blocked`), `woken {since, detail}` (factory, steward, owner).
  - Shipping: `shipped {attempt}` (lead: `start_watch`), `watch_passed {watch}` (factory: closed `done`), `regressed
    {watch | null, detail}` (factory: back to the lead twice, the third time a `regressed` stall).
  - Endings: `reopened {reason}` (owner, factory: `closed` to `queued` within 30 days), `cancelled {reason}` (owner),
    `closed {attempt | null, outcome: done|dropped|healed}` (lead: done or dropped; factory: healed, only before a lead).
- **Wait reasons:** machine exits: `timer`, `dependency` (waits, not stalls), and the stalls `wall`, `unreported`,
  `blocked`, `lead_gone`, `regressed`, all ended by `woken` (`lead_gone` into `queued` with `finalize`, the rest into
  `working`). Person exits, each holding its checkpoint: `decision` (`answered`), `review` (`verdict_given`), `errand`
  (`errand_done`). A `woken` refuses a person's wait. A timed wait takes the lead's verbs as `working` does; every
  other wait refuses them.
- **Outcomes:** `done`, `dropped`, `healed`, `cancelled`.
- **Effects:** `start_lead:<issue>:<attempt>`, `note_lead:<issue>:<version>` (payload `{attempt, from, version}`: the
  events from `from` to `version` are the lead's news), `start_watch:<issue>:<watch>`, `finalize:<issue>:<attempt>`. A
  close cancels every open effect but `finalize`.
- **Stale is ignored, wrong is refused:** an event naming another attempt, watch, wait (`since`) or checkpoint is
  ignored when the factory sent it, and refused when it is a lead's verb. A sender not in `SENDERS` is refused.

## How a domain package plugs in

1. Add its store to the composition in `main.ts`: `postgresUnitOfWork(sql, (tx) => ({ work: postgresWorkStore(tx), intake: postgresIntakeStore(tx) }))`.
2. Its use case takes `UnitOfWork<{ work: WorkStore; intake: IntakeStore }>` (`app/unit-of-work.ts`) plus `{ clock, ids }`, and inside `uow.run(async ({ work, intake }) => …)` writes its rows and calls `recordIn(work, deps, { issueId, key, event })` or `fileIn(work, deps, { key, event })` (`app/issues.ts`), returning their `Result`.
3. An event is typed `IssueEvent<K>` or parsed with `parseIssueEvent`; its key is `key(...parts)` (`kernel/keys.ts`), deterministic from the cause; the time is `Clock`, ids `IdSource`.
4. A `version_conflict` comes back as an error result to retry; `replayed` means the key was stored already.
5. Its effects run through `EffectPorts` (`domains/work/ports.ts`) and `runOutbox` (`app/outbox.ts`); the port finds its own work by the effect's key.

## Review outcome

`/review` deep, scope `97c564f..HEAD` (the merge base: `rewrite` had moved on), job `rv_6we636pmjhw6hrw4rk7w`, one round
as the brief says. The first reply was refused because it had skipped the core files (`table.ts`, `issue.ts`,
`explore.ts`, the tests). The reviewer ran again with the refusal and covered every file (attempt 2). The outcome was
**actionable, 1 important**, fixed in `fix(work): a note to a waiting lead reaches it…` and disposed `fixed`:

| Finding | Disposition |
|-|-|
| `noted` on a `waiting` Issue planned no effect, so the note never reached the lead | Fixed, and not as the reviewer proposed: a `note_lead` planned while waiting would block the Issue's outbox head when there is no lead (a `lead_gone` stall, with its `finalize` behind it). Instead a wait records `told`, the last version the lead heard, and the `note_lead` that ends the wait names the range `from..version`. A new model invariant caught two more cases of the same gap, both fixed: a lead verb from a timed wait that begins another wait kept no anchor, and a wait the factory began (the third regression) would have skipped its own cause |

No round 2 was run: the brief asks for one. The fix has unit tests and a model invariant, and that invariant fails when
the fix is broken by hand.

## Open points

1. **New words for `docs/language.md`**: the state `settling`; the events `filed`, `settled`, `admitted`,
   `lead_started`, `lead_gone`, `noted`, `asked`, `answered`, `submitted` (a Concept or Spec handed over for review),
   `verdict_given`, `errand_raised`, `errand_done`, `deferred` (the lead waits until a time or other Issues),
   `stalled`, `woken`, `shipped`, `watch_passed`, `regressed`, `reopened`, `cancelled`, `closed`; the waits `timer`,
   `dependency`, `review`, `errand` and the stall causes `wall`, `unreported`, `blocked`, `lead_gone`, `regressed`; the
   outcomes `done`, `dropped`, `healed`, `cancelled` (the language's Cancel; the old core closed a stop as `dropped`).
2. **The third regression is a stall now, not the owner's.** The old core parked it for the owner. Here it is a
   machine wait the steward ends: it wakes the lead, or raises a Decision when the rules do not say (package 7).
   `docs/design.md` §4 describes the old way; the orchestrator should confirm.
3. **No claim wait.** The old `claim` reason (a resumed Issue waiting for its repo's claim) is not in the machine.
   Package 3 decides whether a wait gives the claim back. If it does, the `start_lead` or `note_lead` that resumes
   waits for the claim, or package 3 files `woken` and `answered` only once the claim is held. The machine does not
   need to change for either.
4. **A note to a waiting lead plans nothing;** the note reaches the lead in the `note_lead` that ends the wait (`from`
   to `version`). A note to a `settling` or `queued` Issue, or one left over when a wait ends in `queued`, is for the
   next attempt's brief to read from `issue_events` (package 4). `noted` never wakes: the owner's "note and wake" is
   two events, `noted` then `woken`.
5. **Issue ids are `issue_<uuidv7>`:** long in pane names (`lead-<issue>-<attempt>`) and on the CLI. The cutover can
   import the old integer ids as `issue_<n>`, because `idOf` accepts any alphanumeric part. Reversible: a different
   `IdSource` is one line in `main.ts`.
6. **`issues.repo`** is on the row beside state and version: an immutable fact from `filed`, there for capacity's "open
   Issues of repo X". Title, kind and origin stay in the `filed` payload, and the snapshot derives them.
7. **Stores throw, the unit of work returns a `Result`.** `WorkStore` methods throw on a database failure, and
   `UnitOfWork.run` turns that into `PortError` (`gone`). A statement the server refuses (a CHECK, say) is rethrown as
   a bug. That is how I read "every port returns `Result`" for stores that run inside a transaction.
8. **A refused or ignored event is stored and final for its key.** `issue_events.key` is unique across all Issues, so a
   retry after a refusal needs a new key (the old core made `<key>:retry:<n>`). The version does not move; the UPDATE
   still runs with `version = version` to check that the decision saw the Issue as it stands.
9. **Nothing runs the outbox yet.** `runOutbox` has no caller in `main.ts`; the tick (package 4 or 7) schedules it and
   brings the real ports. The runner sets no process timeout of its own: each port owns its timeout, as `AGENTS.md`
   says. The claim lease is 15 min.
10. **The boundary rule allows `.begin(` in `app/`**, as the brief says, though `app/` never needs it: it gets the unit
    of work. Tightening it to "only the two adapter files" is a one-line change once nobody objects.
11. **`FACTORY_INTERNAL_TEST_ROUTES`** is not on `scripts/env-file.sh`'s allow-list, on purpose: only the scenarios set
    it, and package 8 deletes it. The routes have no token, because no auth exists yet; they bind loopback and are off
    by default.
12. **The old `prio`, `dep` and `retier` events are not Issue events here:** priority and the chain are planning's own
    facts (package 3), and `after` is a wait reason only when a working lead defers on other Issues.
13. **`AGENTS.md` §Validate and ship** now misses the Issue diagram step of `make check` (package 0's open point 1
    still stands; I left `AGENTS.md` alone).
14. **Something wrote Claude Code's own config into this worktree before I started.** At the start `git status` showed
    `backups/`, `cache/`, `history.jsonl`, `plugins/`, `projects/`, `settings.json`, `skills/`, `sessions/`,
    `shell-snapshots/` and `session-env/` untracked at the root. They were gone a few minutes later, and I never touched
    them. It looks like a session launched with its config dir set to this worktree. Worth a look in how `hc run` starts
    worker sessions.
