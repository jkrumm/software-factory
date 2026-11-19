# Operations: the listener, the CLI, the gate, the merge window and the deploy

The detail behind the short rules of `AGENTS.md`. Read the section for the work in front of you: the Console listener,
the CLI's credentials and verbs, a CI job or a test slot, the merge window, a deploy variable. Why the perimeter is
shaped as it is: `docs/architecture.md` "Perimeter".

## The Console listener

`apps/server/src/api/console.ts` is a second loopback listener (`FACTORY_CONSOLE_PORT`, default 7795; 7794 is the agw
gateway's). The tailnet publishes it on :8797 through dotfiles-private's serve row, not through `make deploy`. It starts
whenever the Console is built.

- It answers 405 to anything but `GET` and `HEAD`, bar the fifteen write verbs below.
- It forwards only `/health` and `/v1/*` to the API. The owner token stays in the closure; the client's
  `authorization`, `cookie` and `tailscale-*` headers are dropped; an answer with no `cache-control` of its own gets
  `no-store`. Everything else is `apps/console/dist`.
- The writes are the owner's eleven answer verbs, the pin and unpin of a collection and the set and clear of an account's mode, nothing else (405):
  - `decisions/:id/answer`
  - `artifacts/:id/verdict`
  - `artifacts/:id/needed` (his needed-me mark)
  - `artifacts/:id/annotations` (`POST`), with `PATCH` and `DELETE` on `artifacts/:id/annotations/:annotationId`
  - `errands/:id/done` (the owner's click; the orchestrator closes through the API, with `confirmedBy`, recorded as itself)
  - `errands/:id/approve` (his yes on an `approval` Errand: the server runs its command on the mini)
  - `errands/:id/turn-back` (the owner or the orchestrator ends an Errand wait: not done, the lead hears the note)
  - `POST /signals/:id/promote` and `POST /signals/:id/dismiss`
  - `artifact-collections/:id/pin` and `/unpin` (one timestamp)
  - `POST` and `DELETE accounts/:id/mode` (the Accounts screen: Fill first, Hold for a model, Pause, Back to normal; a mode ends at its time or when cleared, `claude-account mode` shows and clears it, and it starts and cancels nothing)
- Each write but the `DELETE` needs `content-type: application/json` (415), no cross-site `sec-fetch-site` and no foreign
  `origin` (403; there is no per-request identity, so a page in the owner's browser could send one), and at most 64 KiB
  (413).
- It can never start a session, and never cancels, reopens or files an Issue by its own words. Promote files one only
  from a signal already held; dismiss files nothing.
- `/frame.html` and `/frame/*`, the artifact's sandboxed frame, are served under their own CSP (scripts, no network);
  the page keeps `script-src 'self'`.
- The page's CSP is `img-src 'self' data:` plus the https hosts of `FACTORY_CONSOLE_IMAGE_HOSTS` (empty by default; the
  frame stays `data:` only), so a Markdown artifact can show screenshots from the owner's own bucket and nothing else.
- A new write goes through the Issue, not this list.

Residual, accepted (`docs/architecture.md` "Perimeter", NL25): there is no per-request identity and the ACL tag grant is
the perimeter, so any tagged node granted :8797 and any process on the mini reads what the owner reads (including what
the read token is denied) and can make those fifteen writes, promote among them (and so pause or drain an account until its mode ends or is cleared). The `origin` check compares with the
request's own `Host`, so a page rebound to loopback in a browser on the mini passes it.

The Console (`apps/console`, its README) holds no logic the API could hold, and `apps/console/test/no-raw-colour.test.ts`
fails on any raw colour.

## The CLI

- Help and body validation derive from the contract schemas (`--schema` prints one).
- `hook`, `slot`, `deploy-lock`, `merge-lock`, `follow`, `retro` (the weekly retro bundle: the retro read plus a pass over
  the lead transcripts), `role`, `issue schema` (the filing contract, offline), `project schema`, `project check` (`docs/project.md`
  and a line-numbered check of a `project.yaml`, offline), `plan schema`, `plan check` (a line-numbered check of a plan
  file, offline) and `plan merge` are hand-written. `plan merge` is the git merge driver
  that appends a branch's rows to master's `docs/plan.yaml` (`.gitattributes` `merge=plan`), so a rebase of that file ends
  no merge window.
- On the host a call with neither `FACTORY_TOKEN` nor `FACTORY_READ_TOKEN` resolves the owner token itself
  (`apps/cli/src/credentials.ts`: the deployed release's `.env.tpl` through `secrets-run`). A set token always wins, so an
  interactive `claude` session on the mini (which starts with the orchestrator token set) is the orchestrator, not the owner:
  it may close an Errand its operator confirmed (`factory errand done <id> --confirmed-by "…"`, recorded as the orchestrator's),
  but approve, verdicts and a Decision's worth-asking stay the owner's. `FACTORY_TOKEN= factory …` resolves the owner token and
  is recorded as the owner: do not use it to close an Errand. The owner's own shell has no `FACTORY_TOKEN` and resolves it.
  Offline verbs and `health get` never resolve one.
- The CLI is the one vocabulary on the host: `rd` keeps only the owner's terminal verbs. An unknown role is exit 4.
- The role table governs the terminals the factory spawns (the lead, `rd --role`); an Issue's or plan row's `seat`
  overrides the lead row for that Issue; with none, `apps/server/src/domains/leads/light.ts` may start it on the `light`
  row (NL33, NL38). A lead's in-session subagents take model and effort from the global agent files
  in dotfiles (`agents/*.md`), and the reviewer's seat comes from `agw review prepare`.
- The CLI waits a restart out (90 s, `FACTORY_RESTART_WAIT_MS`; 10 minutes while a deploy holds its lock). A script that
  must see the outage at once uses `health get`.

## Check tiers

`make check` runs install (frozen), oxfmt check, oxlint (type-aware), shellcheck, `tsc --noEmit`, the Console's
typecheck and token, template and InfoHint freshness, the boundary script, the retired-word check, the vocabulary check,
`make docs-check` (the README against the code), the public-hygiene scan, the Issue diagram and generated-CLI freshness
checks, `bun test`, the scenarios (`tests/scenarios`: a real server and Postgres with fake `hc` and `agw`), then builds
the Console and runs its Playwright suite (`make e2e`, `tests/e2e`) against a seeded server. `make fmt` formats. The tests
start a private Postgres cluster with `initdb` (on `PATH`, or `PG_BIN_DIR`); nothing touches a real database.

`make check` (and `make test`, `make e2e` alone) goes through `factory slot run` when `factory` is installed: one lease on
the host's test slots for the whole check, "queued for a test slot" on stderr while it waits, a wait past 45 min exits 75
without running. A server that does not answer is waited for like a restart (90 s), then the step takes one of
`FACTORY_SLOTS` (2) host-local slots (lock files in `~/.local/state/factory/local-slots`, `FACTORY_LOCAL_SLOT_DIR`): an
outage never starts every waiting step at once.

**Tiers** (`project.yaml` `checks:`, `docs/plan.md` "Check tiers"). A lead runs `make check-fast`: everything of `make
check` that is not a test run, then the unit tests of the files the branch changed (`bun test --changed` against the merge
base with `origin/master`; `CHECK_FAST_ALL=1` runs all of them; the run stops at the first failing test, `UNIT_BAIL=` lists every failure, and a Playwright run in a slot stops at its first failure, `--max-failures=0` runs all: failed-run slot minutes, Issue 2375). Outside CI it first applies `oxfmt --write` to the tree,
outside the slot, so a format-only red never costs a slot wait: commit what it reformats. The rest (`check-fast-steps`) edits
nothing, so it is `steps.check-fast` in `project.yaml` with `remote: true`: when the mini's line is long it runs on the step host over
the tree as just formatted (`step_placements`, Throughput's "Steps by host"; the step image carries shellcheck and Postgres for it). CI leaves the rest:
`.github/workflows/ci.yml` runs the full gate on `ubuntu-latest` as jobs:

- `static`: `make check-fast` with `CHECK_FAST_ALL=1 UNIT_SHARD=1/2`, the checks and the first half of the unit tests.
- `unit (2/2)`: `make test-unit UNIT_SHARD=2/2`.
- `scenarios`: `make test-scenarios`, `SHARD=i/3`.
- `e2e`: `make e2e`, `E2E_SHARD=i/3`.

Both suites run the files `scripts/shard.ts` plans for that shard from the seconds per file in
`tests/e2e/shard-weights.json` and `tests/scenarios/shard-weights.json`, because bun's and Playwright's own `--shard`
balance file or test count, not time (a scenarios shard of three ran 265 s against 167). A file with no weight counts as
the suite's median, so a new test file touches nothing; `make check` fails only on a weight naming a deleted file; the
weights are refreshed from a CI log now and then. A screenshot variant is its own e2e file for the same reason.

The run is green only when every job is, which is all `merge-guard` reads. The jobs are one matrix with `fail-fast`, so the
first red job (`static` is known minutes before the tests end) cancels the rest and the run ends `failure`. A `gh run
cancel` from a step would end it `cancelled`, which `merge-guard` and `ci_red` skip as superseded and so hide a red head or
master (measured 2026-11-15). `make check` stays the whole gate locally (a change to the test layout, the Makefile or CI
runs it); to reproduce one CI failure, run that suite alone inside a slot.

## Merging

Parallel leads share one master, so before a lead merges its PR it rebases on the current `origin/master`, takes the next
free migration number if it adds a migration (`make check` prints it; `scripts/merge-guard.ts --next-migration` too) and
pushes. `make check` runs locally before the first push and after every change the lead authors; a rebase that only
brings in master's commits is not re-run locally, CI on the rebased head is that check (NL28). Then `make merge-guard`
(`MERGE_GUARD_ARGS=--wait` waits for the head's CI), merging only on exit 0.

The rebase, push, CI wait, guard and merge run inside `factory merge-lock --project <repo> -- sh -c '…'`
(`apps/cli/src/deploy-lock.ts`, the deploy lock's mechanism under `<project>.merge.lock`, waits up to 90 min, closed; the
finished call is reported to `POST /merge-windows` afterwards, best effort, and never changes the lock or the exit code).
With several leads a CI run (5.3 min p50, 6.2 p90 over 167 runs from 2026-11-13, before the shards were rebalanced)
outlasts the gap between merges, so unserialised leads rebased against each other forever (NL29).

The guard refuses, with the reason: a branch that does not contain `origin/master`, a new migration whose number master (or
the branch) already uses, a head with no finished green CI run on its exact sha, and a master whose last finished CI run is
red (a cancelled run was superseded and is skipped; an unreadable `gh` refuses too; a master run still running is not a
refusal). `MERGE_GUARD_ARGS=--allow-red` is for the one change that fixes a red master and never skips the head's CI. The
lead's brief (`domains/leads/brief.ts`) states the same rule, and by hand for a repo with no `make merge-guard`.

## Deploy

`make deploy`, `make rollback` and `make verify` act on the mini only; `DRY_RUN=1` prints the plan, `FACTORY_REF=<branch>`
proves a branch live before it is merged.

- A rollback target is started up to `RESTART_ATTEMPTS` (3) times, `RESTART_PAUSE_SECS` (20) apart, before the deploy gives
  up and removes the plist: a Postgres lock timeout at start (issue 830) clears by itself.
- A deploy whose commit is live and healthy restarts nothing (`FACTORY_DEPLOY_FORCE=1` restarts anyway; a settings-file
  change needs it), builds the newer commit when master moved during its build (`DEPLOY_ROUNDS`, 3), and dry-runs the
  pending migrations in a rolled-back transaction before it stops anything.
- It writes `unreachable_s=N stopped_s=N started_s=N load_down=N load_up=N` on its `deploys.log` end line (`factory read
  throughput`, `deploys.days` sums the first). The other two seconds split it: the old process told to stop to gone, then
  to `/health` ok. The last two are the one-minute load at the stop and at `/health` ok, so a slow boot reads from the log.
  The old server's `stopped in N s (slow steps)` and the new one's `listening … (boot N s: lock, migrations, rest)` lines in
  `~/Library/Logs/software-factory.out.log` split those further.
- Both plists carry `ProcessType` Interactive, the band herdr-core and the leads' processes run in, so the server is not
  throttled below the work it controls.
- The health wait is `HEALTH_WAIT_SECS` (180). Before it stops anything, a deploy or rollback waits up to `LOAD_WAIT_SECS`
  (600) for the one-minute load to fall to `LOAD_MAX` (8 per core, 0 = off) and otherwise refuses with the live service
  untouched (issue 885: at load 200+ the new release and its rollback both missed 60 s).
