# Packages 2 to 6: the rules every parallel worker follows

**Five workers build five domains at once on separate branches off `rewrite`; the orchestrator merges them one by
one. Everything here exists so those merges are trivial and no worker waits on another.** Read this with your own
brief, before you write code.

## Read first

`docs/rewrite.md`, `docs/architecture.md`, `docs/language.md`, `docs/product.md`, `AGENTS.md`,
`docs/rewrite/learnings.md`, and the two reports: `docs/rewrite/reports/0-skeleton.md` (the skeleton, its traps) and
`docs/rewrite/reports/1-kernel-work.md` (the Issue machine: its state table, and **"How a domain package plugs in"**,
which is how you record an event on an Issue). The running core, for the meaning you port: the `docs/design.md`
sections and the `legacy/` files your brief names. Port behaviour and the scars behind it, never the code's shape.

## Where you may write

- **Your own folders**, named in your brief: `apps/server/src/domains/<yours>/`, `apps/server/src/app/<yours>*.ts`,
  `apps/server/src/adapters/<yours>/` (or the adapter files your brief names), `apps/server/src/api/<yours>.ts`,
  `packages/contract/src/<yours>.ts`, `apps/server/test/<yours>/`, `tests/scenarios/<yours>/`.
- **Migrations in your number range only:** package 2 `0200` to `0299`, 3 `0300` to `0399`, 4 `0400` to `0499`, 5
  `0500` to `0599`, 6 `0600` to `0699`. Name every table for your domain; you own your tables (`docs/architecture.md`:
  cross-domain SQL lives in `read/` and is read-only). Never alter another domain's table, `factory.issues` included.
- **Shared files, additive and one line where you can:** `apps/server/src/main.ts` (your store in the composition,
  your routes, your ports), `apps/server/src/api/app.ts` (one `.use()`), `packages/contract/src/index.ts` (your
  exports), `apps/cli/src/generated/operations.ts` (regenerated, never hand-edited; the orchestrator regenerates it
  at the merge), `tests/scenarios/harness.ts` and `tests/scenarios/fakes/*` (add, do not change what exists),
  `scripts/boundaries.ts` (a new rule for your domain only, with fixtures).
- **Not at all:** `kernel/`, `domains/work/`, `app/issues.ts`, `app/outbox.ts`, `app/unit-of-work.ts`, the Postgres
  unit of work, another package's folders, `docs/` other than your report. If you need a change there, it goes in
  your report's open points with the smallest change that would do, and you work around it meanwhile (a port of your
  own, a local type). The orchestrator makes cross-package changes.

## When you need another domain

You do not wait for it and you do not import it. Your domain declares the **port it needs** as an interface in its own
folder (for example intake's `ProjectSignals`: which sources a repo hears), your tests use a fake of it, and
`main.ts` gets a stub adapter that is honest about being one (returns the empty answer, named
`stub<Port>`, with a comment naming the package that brings the real one). The orchestrator wires the real
adapter at integration. List every such port in your report.

## How work is written

- Use cases live in `app/`, open the transaction through the unit of work, never call a port inside it: **claim,
  commit, call, record**. Every port returns `Result<T, PortError>`; only a programming error throws.
- Every effect has a deterministic key (`kernel/keys.ts`); a replayed tick, call or event does nothing twice. Prove it
  in a test for every effect you add.
- Facts are stored, state is derived: a count or a timer readable from events is never a column.
- Every name in the language (`docs/language.md`). Where it has no word, choose the plainest English one and list it.
  Retired words fail `make check`.
- Write routes go through the contract (`packages/contract`, zod with `.meta({ id })`, operationId `<group>.<verb>`)
  so the generator emits the CLI command. No auth yet (package 8 brings it); routes bind loopback as the app does.
- New dependencies: avoid them. If one is unavoidable, check it with `/research`, pin it exactly, respect the 3-day
  cooldown, and name it in your report.

## Tests

Units where the logic is dense and pure. **A scenario in `tests/scenarios/<yours>/` for every acceptance line of your
brief**, against the real server process and Postgres with fake hc and agw, through the routes or CLI commands a
person or lead would use. A scenario never reaches into another domain's tables.

## Finish

1. Conventional commits on your branch, no AI attribution. Never merge into `rewrite`; do not rebase it either unless
   your report says why.
2. `make check` green.
3. `/review` your range once, standard or deep as your brief says, always with `--thread rw-<n>-<slug>`: parallel
   workers on one base commit otherwise share a thread and abandon each other's jobs. Fix what is real; note what you declined and why.
4. Write `docs/rewrite/reports/<n>-<slug>.md` and commit it: **what changed** (by folder), **`make check` output**
   (the tail that shows every step), **the ports you declared** and the stub `main.ts` uses, **the events you record
   on Issues** and from which use case, **review outcome**, **open points** (new words, shared-file changes you need,
   doc contradictions).
5. Say `REPORT READY` as the last line of your final message and stop. Questions go into open points; take the
   reversible default meanwhile.
