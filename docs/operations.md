# Operations: the listener, the CLI, the gate, the merge window and the deploy

The detail behind the short rules of `AGENTS.md`. Read the section for the work in front of you: the Console listener,
the CLI's credentials and verbs, a CI job or a test slot, the merge window, a deploy variable. Why the perimeter is
shaped as it is: `docs/architecture.md` "Perimeter".

## The Console listener

`apps/server/src/api/console.ts` is a second loopback listener (`FACTORY_CONSOLE_PORT`, default 7795; 7794 is the agw
gateway's). The tailnet publishes it on :8797 through dotfiles-private's serve row, not through `make deploy`. It starts
whenever the Console is built.

- It answers 405 to anything but `GET` and `HEAD`, bar the fourteen write verbs below.
- It forwards only `/health` and `/v1/*` to the API. The owner token stays in the closure; the client's
  `authorization`, `cookie` and `tailscale-*` headers are dropped; an answer with no `cache-control` of its own gets
  `no-store`. Everything else is `apps/console/dist`.
- The writes are the owner's ten answer verbs, the pin and unpin of a collection and the set and clear of an account's mode, nothing else (405):
  - `decisions/:id/answer`
  - `artifacts/:id/verdict`
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
  frame stays `data:` only), so a Markdown artifact can show screenshots from the owner's own bucket and nothing else; a submit or revision whose picture would not load (other host, http, expired presigned link, a non-`data:` HTML `<img>`) is refused with the reason.
- A new write goes through the Issue, not this list.

Residual, accepted (`docs/architecture.md` "Perimeter", NL25): there is no per-request identity and the ACL tag grant is
the perimeter, so any tagged node granted :8797 and any process on the mini reads what the owner reads (including what
the read token is denied) and can make those fourteen writes, promote among them (and so pause or drain an account until its mode ends or is cleared). The `origin` check compares with the
request's own `Host`, so a page rebound to loopback in a browser on the mini passes it.

The Console (`apps/console`, its README) holds no logic the API could hold, and `apps/console/test/no-raw-colour.test.ts`
fails on any raw colour.

## The CLI

- Help and body validation derive from the contract schemas (`--schema` prints one).
- `hook`, `slot`, `deploy-lock`, `merge-lock`, `land`, `follow`, `retro` (the weekly retro bundle: the retro read plus a pass over
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
typecheck and token, template and InfoHint freshness, `fallow audit --only dead-code` against the merge base (fails only on dead code the branch introduces; `.fallowrc.json` names the entry points and the accepted exceptions, and `fallow` is a pinned devDependency so CI runs it), the boundary script, the retired-word check, the vocabulary check,
`make docs-check` (the README against the code), the public-hygiene scan, the Issue diagram and generated-CLI freshness
checks, `bun test`, the scenarios (`tests/scenarios`: a real server and Postgres with fake `hc` and `agw`), then builds
the Console and runs its Playwright suite (`make e2e`, `tests/e2e`) against a seeded server. `make fmt` formats. The tests
start a private Postgres cluster with `initdb` (on `PATH`, or `PG_BIN_DIR`); nothing touches a real database.

`make check` (and `make test`, `make e2e` alone) goes through `factory slot run` when `factory` is installed: one lease on
the host's test slots for the whole check, "queued for a test slot" on stderr while it waits, a wait past 45 min exits 75
without running. A server that does not answer is waited for like a restart (90 s), then the step takes one of
`FACTORY_SLOTS` (2) host-local slots (lock files in `~/.local/state/factory/local-slots`, `FACTORY_LOCAL_SLOT_DIR`): an
outage never starts every waiting step at once.

**Tiers** (`project.yaml` `checks:`, `docs/project.md` "Check tiers"). A lead runs `make check-fast`: everything of `make
check` that is not a test run, then the unit tests of the files the branch changed (`bun test --changed` against the merge
base with `origin/master`; `CHECK_FAST_ALL=1` runs all of them; the run stops at the first failing test, `UNIT_BAIL=` lists every failure, and a Playwright run in a slot stops at its first failure, `--max-failures=0` runs all: failed-run slot minutes, Issue 2375). Outside CI it first applies `oxfmt --write` to the tree,
outside the slot, so a format-only red never costs a slot wait: commit what it reformats. The rest (`check-fast-steps`) edits
nothing, so it is `steps.check-fast` in `project.yaml` with `remote: true`: when the mini's line is long, or its learned run there is shorter, it runs on the step host over
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
cancel` from a step would end it `cancelled`, which `merge-guard` skips as superseded and so hides a red head or
master (measured 2026-11-15). `make check` stays the whole gate locally (a change to the test layout, the Makefile or CI
runs it); to reproduce one CI failure, run that suite alone inside a slot.

## Merging

Parallel leads share one master, so a lead lands its branch with `factory land` in its worktree
(`apps/cli/src/land.ts`), started in the background with its exit code written out. `make check` runs locally before the
first push and after every change the lead authors; a rebase that only brings in master's commits or only resolves conflicts is not re-run locally;
CI on the rebased head is that check (NL28). A new migration takes the next free number (`make check` prints it;
`scripts/merge-guard.ts --next-migration` too).

The verb reads the ship mode from `project.yaml` (`ship:` with any `via: pr` lands by pull request; no file or only
`via: push` pushes to the default branch) and runs, inside the repo's merge window:

| Step | Pull request | Push |
|-|-|-|
| lock | the merge lock of `merge-lock` (`<project>.merge.lock`, waits up to 90 min, then exit 75); the branch is rebased before the lock is asked for, and the wait looks at the default branch every 60 s and rebases again when it moved, so a conflict ends the wait at once | same |
| rebase | (also before the lock and during its wait) `git fetch`, `git rebase origin/<default>` with the plan merge driver, `factory plan check` where `.gitattributes` declares `merge=plan`; a conflict aborts the rebase and refuses | same |
| review | `agw review covered` on the range: a commit uncovered at standard or deep refuses with the `/review` command | same |
| push | `git push --force-with-lease` (skipped when origin has the head); no open pull request refuses before the lock | `git push origin HEAD:<default>` |
| ci | the pull request shows the head, then every check's bucket is `pass` or `skipping` with at least one `pass`, and one of those passing checks is a GitHub Actions workflow run (its link has `/actions/runs/` and its bucket is `pass`: another service's status can pass before CI registers, so the wait goes on until one does), read green twice in a row (an all-skipped set is no CI); a `fail` or `cancel` refuses with the checks, no check after 3 min refuses (`--no-ci` for a head every workflow's path filter skips: `make check` on the rebased head before the push, no CI wait, no guard), 45 min refuses | none |
| guard | `make merge-guard` where the Makefile `make` reads (`GNUmakefile`, else `makefile`, else `Makefile`) has the rule (read from the file, as the brief reads it, by one rule: `packages/contract/src/landing.ts`, which the hygiene pass's landing and `scripts/merge-guard.ts` read too; one that only includes another file asks `LC_ALL=C make -n merge-guard`, and a failure other than the absent target refuses); else the same rule: the head contains the default branch, which is not red | none |
| merge | `gh pr merge --<method> --match-head-commit <head>` by the method GitHub allows (squash, then rebase, then merge; `--method` overrides), never `--admin` | none |
| report | the landed commits on stdout, and a squash commit `agw review covered` lists stale with the `/review` command for it; a failed fetch after the merge is a warning, never exit 1 | the landed commits |

A refusal is exit 1 with `land: <step>: refused: <why>` and `land: next: <command>`, the lock released and nothing
merged. Every step is safe to repeat, so a second run resumes (a rebased branch is not rebased again, a pushed head is not
pushed again, a merged pull request prints its commit and exits 0). It does not deploy and does not ship. A remote that is
not GitHub is refused with the by-hand steps. `FACTORY_LAND_POLL_MS`, `FACTORY_LAND_NO_RUN_MS` and
`FACTORY_LAND_CI_MINUTES` tune the CI wait; `FACTORY_LAND_REBASE_POLL_MS` (60 s) sets how often the wait for the lock looks for a moved default branch.

The lock is `factory merge-lock --project <repo> -- <cmd>`'s (`apps/cli/src/deploy-lock.ts`, the deploy lock's mechanism
under `<project>.merge.lock`, closed; the finished window is reported to `POST /merge-windows` afterwards, best effort, and
never changes the lock or the exit code); `merge-lock` stays for a pass that lands by its own steps (the hygiene fix).
With several leads a CI run (5.3 min p50, 6.2 p90 over 167 runs from 2026-11-13, before the shards were rebalanced)
outlasts the gap between merges, so unserialised leads rebased against each other forever (NL29).

The guard refuses, with the reason: a branch that does not contain `origin/master`, a new migration whose number master (or
the branch) already uses, a head with no finished green CI run on its exact sha, and a master whose last finished CI run is
red (a cancelled run was superseded and a skipped one judged nothing, so both are passed over; the hygiene pass's landing and `factory land` read the same rule from `packages/contract/src/landing.ts`; an unreadable `gh` refuses too; a master run still running is not a
refusal). `factory land --allow-red` (`MERGE_GUARD_ARGS=--allow-red`) is for the one change that fixes a red master and
never skips the head's CI.

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


## Logs and traces

Where to look when the server failed or did something odd. ClickStack first, the local files for the words.

**ClickStack**, service `software-factory` (`service.version` is the deployed short sha, so a restart splits two versions). The same endpoint and key as the gauges (`FACTORY_OTEL_ENDPOINT`); off without it.

- **Spans.** `loop.<name>`: one per loop pass that failed or did something (an agw call, an Issue event), with its calls under it in one trace. A pass that looked and found nothing records nothing, so the volume follows what happened, not the 10 s tick. `agw.<workflow>` and `process.<program>` (`git`, `hc`, `gh`, `make`, …): one per port call, with the Result kind (`result`) and the duration (`duration.ms`); a call in a pass that recorded nothing is dropped with it, a call outside any pass is recorded only when it failed or was an agw call. A non-zero exit is an answer, not a failure (`result=exit`, `exit.code`); a timeout or a program that cannot start is. `http.request`: one per API request that ended 5xx, by method, route pattern and status (an error nothing triaged adds an `api.unexpected_error` log with its `error.type`).
- **Logs.** The body is a fixed event name (`port.failed`, `loop.pass_failed`, `api.server_error`, `api.request_refused` (a 400, 403 or 422, a warning), `boot.failed`, `checkpoints.*`, `leads.*`, `console.error`, …); severity says error or warn. A line written by code that does not report structured becomes a `console.error` or `console.warn` row with the loop it happened in and its length; the words are in the local log. A log row has the trace and span of the pass it happened in.
- **Attributes** are ids, names, kinds, counts and durations: `loop`, `issue`, `ref`, `port`, `workflow`, `program`, `verb`, `result`, `error.kind`, `error.type`, `error.code`, `exit.code`, `duration.ms`, `count`, `http.*`. The list and the one-word rule for values are `cleanAttrs` in `kernel/telemetry.ts`: a title, note, fact, signal text, path or error message has no way in, so work repos' words stay off this surface. Add a name there only for an id, a name, a kind, a count or a duration.
- **Loss.** Records are queued and pushed every 5 s (`/v1/traces`, `/v1/logs`); a push that fails drops its batch, and a full queue drops the newest. Neither fails or delays a pass; the count is the gauge `factory.telemetry.dropped` (series `signal=logs|spans`, since the start).
- **Query**, with `/otel` (`agw hdx query clickstack_search`, discovery first): spans `ServiceName:"software-factory"` and `SpanName:"loop.leads"` on the traces source; logs `ServiceName:"software-factory" SeverityText:ERROR` on the logs source. `SpanAttributes['loop']`, `LogAttributes['error.kind']` and `['issue']` narrow them. What failed around a deploy: the logs of one `service.version` by time, then the trace of the pass.

**Local files**, `~/Library/Logs/software-factory.{out,err}.log`: the words (messages, stack lines), each line starting with an ISO time. The server stamps every line it writes (`adapters/otel/console.ts`, `console.*` and direct writes); the launcher stamps its own few (`scripts/launch.sh`, `scripts/env-file.sh`). Bun's own crash output and what a child process writes straight to the inherited stderr are not stamped. Lines from before the stamp have no time.

## Rules behind AGENTS.md

The detail behind the short rules of `AGENTS.md`, for a change that touches one of them. A rule a script holds is named
there with the script; its failure message says what to do.

- **Public repo.** `scripts/public-scan.ts` fails on an address, tailnet name, e-mail, secret, home path, ssh alias, account
  or work-repo name; an exception is a line in `scripts/public-scan.allow` with its reason.
- **Dependencies point one way.** Factory → agw, herdr-core, GitHub, the intake sources. Nothing here is imported by agent-workflows.
- **Facts are stored, state is derived.** The transition table `domains/work/table.ts` is total: a new state or event fills
  every cell, and `docs/language.md`'s diagram is regenerated (`make check` fails when it is stale).
- **A repo is stored as its project name.** Every write that takes a repo (`signal file`, `signal promote`, `door route-set`,
  `issue new`) resolves a name, a path or a linked worktree to the directory name of the main checkout (`repoNameOf`,
  `projectOf`); only a second directory of a taken name (`<name>~<hash>`) is stored as its path.
- **Every effect has a deterministic key** (`kernel/keys.ts`: terminal labels, prompt ids, comment markers, signal
  fingerprints). The Runner looks before it acts. Admission is decided again at every claim.
- **Deploy locks.** `factory deploy-lock --project <name> -- <cmd>` and the factory's own deploy hold a host-local pid
  symlink; an unreadable or uncreatable lock refuses the deploy (exit 75 / 1); only a dead holder is reclaimed.
- **CLI contract.** Commands are generated from the OpenAPI document (`apps/cli/src/generated/operations.ts`); `make check`
  fails when it is stale. The hand-written verbs and the credential rules: "The CLI" above.
- **Tooling.** `bunfig.toml` sets `exact` and a 3-day release-age cooldown; never exclude a package from it.
- **Who may call what.** The orchestrator has the owner's rights bar the six owner-only routes of `policy.ts`'s header.
- **Trust boundary.** `FACTORY_REPO_ALLOW` takes colon-separated absolute paths, each one repo and its worktrees, never its
  siblings (`adapters/git/repos.ts`). A linked worktree is never a project. The API is loopback only.
- **The Console listener.** `FACTORY_CONSOLE_PORT`, default 7795 (7794 is the agw gateway's). It forwards only `/health` and
  `/v1/*`, holds the owner token in its closure, and answers 405 to anything but `GET`/`HEAD` bar its fourteen `WRITES` verbs
  (`api/console.ts`). Its verbs, guards and the accepted residual: "The Console listener" above.
- **The door** holds only `FACTORY_DOOR_TOKEN` (caller `machine`: `POST /signals/alerts`, `POST /signals/feedback`,
  `POST /door/reports`) and no database credential; it takes the repo from `factory.door_routes`.
- **Hooks.** `factory hook` does nothing without `FACTORY_SESSION`, appends to the spool, posts to the unix socket and exits 0
  whatever happens (the Stop send-back exits 2). `apps/cli/src/hook.ts` imports only `node:fs` and `@software-factory/contract/spool`.
  Its stdout is empty for every event but `compactedLead`, a lead's post-compaction `session-start`, which prints one re-read line.
- **One process.** The session-level advisory lock is taken first; a second copy waits 45 s, then exits 1. Advisory keys
  live in `adapters/postgres/locks.ts` and stay distinct.
- **One contract.** A body that does not parse is exit 9. The server builds every body through its schema.
- **Migrations** are advisory-locked, qualify every name, are expand then contract, and are never edited once applied (a
  checksum refuses it). Only `0993` is a shared number. `DATABASE_URL` comes from `secrets-run`, never a tracked file.
- **Settings.** Secrets in `.env.tpl` (server-only optional refs in `.env.server.tpl`, the door's in `.env.door.tpl`);
  non-secret settings in `~/.config/factory/env`, which `scripts/env-file.sh` allow-lists (a key not on its list refuses the
  start). An edit takes a restart.
- **A request's `check`** is a shell command the server runs (`adapters/shell/check-runner.ts`); only owner, orchestrator or
  agent may set one, never `machine`, `signal` or `read`.
- **The throughput epoch** (`config/throughput.json`): no throughput read counts a sample before it; a bad or missing file
  stops the start. `docs/architecture.md` "The counting epoch and the three answers".
- **Heartbeat names** on `GET /health` (`ok`, `reason`, `tickAt`, `queueMovedAt`) are read by a pusher outside this repo.
  `ok` is false only for a stopped factory; `/health` never queries the database in the request.
- **State words.** The Console, the Herdr bar and `read/describe.ts` show Running, Paused, Ready, Held, Checking and Planned,
  never `queued`, `working`, `waiting`, `watching` or `settling`. `scripts/vocabulary.ts` and `scripts/retired-words.ts` fail
  the same way; an exception is a line with its reason in the script's `.allow` file.
- **The README** states counts and lists (event kinds, callers, tokens, screens, domains, states, the Console's port and
  writes); `make docs-check` fails on a mismatch.
- **Hygiene probes** are one catalogue (`packages/contract/src/hygiene-catalogue.ts`): add a probe there, with its default,
  cadence and silence; `docs/hygiene.md` is generated from it.

## Rebasing a plan file

Leads append rows to `docs/plan.yaml` faster than a check and a CI run take, so a plain rebase conflicts on the last
lines every time. The repo declares the file an append-only aggregator in `.gitattributes`:

```
docs/plan.yaml merge=plan
```

and the rebase names the driver on its command line (git keeps no driver in a tracked file):

```
git -c merge.plan.driver='factory plan merge %O %A %B' rebase origin/master && factory plan check
```

`factory plan merge <base> <ours> <theirs>` keeps master's file and appends what the branch added at the end of it. A
side that also changed existing lines is no append: the driver leaves git's line merge with its conflict markers and
exits 1, so two edits of one row stay a conflict to read. The resolution ends no merge window and owes no local
`make check`; `factory plan check` after it refuses a duplicate row key. Git's own `merge=union` is not used: it drops
the lines two appended rows share and leaves a row corrupt.

