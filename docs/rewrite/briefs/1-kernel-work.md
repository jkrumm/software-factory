# Package 1: Kernel and work

**Build the kernel every domain stands on and the Issue as a total state machine, with the one write path that
stores an event, the new state and its effects atomically.** Packages 2 to 6 start in parallel on top of this and
must not need to touch `kernel/`, `domains/work/` or the write path; get those right and complete now.

You are the worker for package 1 of the rewrite (`docs/rewrite.md`). You work in this worktree on branch
`rw/1-kernel-work`, made from `rewrite` after package 0. You commit on your branch and never merge into `rewrite`.

## Read first

`docs/rewrite.md`, `docs/architecture.md` (§The server, §The Issue state machine, the boundary rules),
`docs/language.md` (every state, event, wait reason and outcome is named in its words), `docs/product.md`
(principles 2, 3, 6), `AGENTS.md`, `docs/rewrite/reports/0-skeleton.md` (what the skeleton gives you and its traps),
`docs/rewrite/learnings.md`. The running core's Issue behaviour, to port the meaning and not the code:
`docs/design.md` §4 "The Issue machine" (states, parks, holds, how every park ends, evidence, `after` and `prio`),
§4 "The steward", and `legacy/server/src/issues/`.

## Calls already made (do not reopen)

1. **`kernel/`** (imports nothing else of the server): `Result<T, E = PortError>` with `ok`/`err` helpers and
   `PortError = { kind: 'timeout' | 'gone' | 'refused' | 'unreadable'; detail: string }` exactly as the architecture
   shows; branded ids (an `IssueId` is not a string you can pass for another id); a `Clock` port with a fixed clock
   for tests; an id source as a port too, so tests are deterministic; deterministic effect keys (one function that
   builds a key from its parts, stable across processes); the event envelope (id, Issue id, kind, payload, actor,
   at, the Issue version it produced, causation). Small and deep; nothing speculative for later packages.
2. **`domains/work/`**, pure: states `settling`, `queued`, `working`, `waiting`, `watching`, `closed` and no others;
   the event kinds; wait reasons (each one says whether its exit needs a person, and what it holds when it does);
   the closed outcomes; effects as data (never functions). The `TABLE` as the architecture shows: `{ [S in State]: {
   [E in EventKind]: (ctx: Ctx) => Cell } }` with `Cell` = to / refuse / ignore. **A missing cell fails `tsc`**:
   prove it with a type test (a `// @ts-expect-error` fixture is the one allowed ts-comment, in a test file only, if
   oxlint's rule permits it scoped there; otherwise a `tsc` run on a fixture file in a unit test). `apply(issue,
   event, ctx)` returns the next Issue state and its effects, or the refusal.
3. **Event kinds**: derive them from the language and design §4, covering at least: filed, settled (triage and the
   chain are done), admitted (a lead may start), lead started, lead gone, noted (an amend reaches the lead), asked
   (a Decision raised), answered, errand raised and done, stalled (machine cause) and woken, shipped, watch passed
   (verify ended the watch), regressed, reopened (its own verb, the only way out of `closed`), cancelled (the
   owner's stop), closed. Name each in the language; where the language has no word, choose the plainest English
   one and list it in your report's open points so the orchestrator can add it to `docs/language.md`. Port the old
   parks and holds into waits and stalls (`docs/language.md`: Park and Hold are retired).
4. **Model test** (`domains/work`): a small seeded PRNG of your own (no dependency), playing random event sequences
   over 10,000 sequences in `bun test` well inside its 30 s timeout. Invariants at least: every machine wait has an
   exit that needs no person; every wait on the owner states what it holds; `closed` leaves only through the reopen
   event; no cell throws; the version rises by one per applied event and never on a refusal or an ignore. A failing
   seed prints itself so it can be replayed.
5. **The diagram** is generated from `TABLE` (a Mermaid `stateDiagram-v2` block) into `docs/language.md` between two
   marker comments you add at the end of the file, under a heading "The Issue, as the code has it". `make check`
   fails when the block is stale. That marker block is the only edit you make to `docs/language.md`.
6. **The write path** (`app/`, the work domain's tables, the Postgres adapter): migration `0002_...` with the work
   tables (the Issue row with its state and `version`, `issue_events`, an outbox of effects with their keys); a
   unit-of-work port whose Postgres adapter is the only code besides the migration runner that calls `sql.begin`;
   one use case that loads an Issue, applies an event, and in one transaction stores the event, `UPDATE ... WHERE id
   = $1 AND version = $2`, and the effects in the outbox (a version conflict is a typed result the caller can retry,
   not an exception); and the outbox runner skeleton: claim an effect and commit, run it through a port, record the
   result in a new transaction. **Claim, commit, call, record**: never a port inside a transaction. An effect's key
   makes a replay a no-op. Effects in package 1 run against fake ports only; packages 2 to 7 bring the real ones.
7. **Facts are stored, state is derived** (`AGENTS.md`): the Issue row's `state` and `version` are the result of its
   events, kept because the version guards the write; a count or timer readable from `issue_events` is never a
   column. Name every column in the language.
8. **Boundary rules added** to `scripts/boundaries.ts` with a failing and a passing fixture each: only `app/` and
   `adapters/postgres/` call `.begin(` (and in `adapters/postgres/` only the unit-of-work adapter and the migration
   runner); `app/` imports no adapter (it gets ports injected; the composition happens in `main.ts`). Keep the rules
   from package 0 green.
9. **Scenarios**: one in `tests/scenarios` that drives an Issue through filed, settled, admitted, lead started,
   shipped, watch passed and closed against the real server process and Postgres, through whatever narrow entry the
   use case needs now (an internal test route behind a setting is fine, named so package 8 can delete it), and checks
   the event log, the version and the outbox. A second one replays the same events and shows nothing doubles. If an
   API route is the cleanest entry, add it through the contract and let the generator emit its CLI command.

## Acceptance

- A missing `TABLE` cell fails `tsc`, proven by a test.
- The model test holds its invariants over 10,000 sequences, seed printed on failure.
- The diagram in `docs/language.md` is generated and `make check` catches a stale one.
- The write path stores event, state and outbox in one transaction, refuses a stale version without throwing, and
  never calls a port inside a transaction (a test with a port that records whether a transaction is open).
- `make check` green, output in your report.

## Out of scope

Intake, planning, capacity, leads, quality, checkpoints (packages 2 to 6): their domains, tables and ports. Real
adapters for hc, agw, gh, ntfy. The API beyond what a scenario needs. Do not edit `docs/architecture.md`,
`docs/rewrite.md`, `docs/decisions.md`, or `docs/language.md` outside the marker block; contradictions go to open
points.

## Finish

1. Logical conventional commits on `rw/1-kernel-work`, no AI attribution.
2. `make check` green.
3. `/review` your range (`rewrite..HEAD`) once, deep. Fix what is real; note what you declined and why.
4. Write `docs/rewrite/reports/1-kernel-work.md` and commit it: **what changed** (by folder), **`make check` output**
   (the tail showing every step), **the state table** as a compact list of states, events, wait reasons and outcomes
   (the parallel packages brief from it), **how a domain package plugs in** (which ports and helpers from `kernel/`
   and `app/` packages 2 to 6 use to record an event on an Issue, in five lines or fewer), **review outcome**, **open
   points** (new words for `docs/language.md`, doc contradictions, anything the next packages must know).
5. Say `REPORT READY` as the last line of your final message and stop. Questions go into open points; take the
   reversible default meanwhile.
