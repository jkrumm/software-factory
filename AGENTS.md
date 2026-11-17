# software-factory

The lifecycle server for agent-built software, CLI `factory`: signals become Issues, each Issue is owned by an
interactive Claude Code session in a herdr-core terminal from root cause to production evidence. Live on the mini since
2026-11-08; `docs/program.md` is the current state.

**Start here:** `docs/product.md` (what it is) → `docs/language.md` (the words) → `docs/architecture.md` (what is built
and where) → `docs/decisions.md` (what was decided and why).

## Rules

- **Public repo.** No secrets, hostnames, IPs, tailnet names, internal URLs or account e-mails in any tracked file.
  Placeholders: `<your-domain>`, `<see-1password>`. Secrets resolve at runtime through `secrets-run`. MIT licensed.
  `scripts/public-scan.ts` (in `make check`) fails on an address, tailnet name, e-mail, secret, home path, ssh alias, account
  or work-repo name; an exception is a line in `scripts/public-scan.allow` with its reason. Work repos appear only as
  `WorkRoot` and `work-repo-N`.
- **The factory never calls a model.** Every judgment (triage, the steward, the Judge, the queue, the screening of held
  signals) is an `agw` workflow called through `apps/server/src/adapters/agw/`. No model SDK in this repo.
- **Dependencies point one way:** factory → agw, herdr-core, GitHub, the intake sources. Nothing here is imported by
  agent-workflows.
- **The layers are enforced** by `scripts/boundaries.ts` in `make check`: `domains/*` import only `kernel` and their own
  folder and do no I/O; a domain reaches another through `app/`; `read/` writes nothing; only
  `adapters/postgres/unit-of-work.ts`, `migrate.ts` and `read/bounded.ts` (a read-only, timed read) open a transaction.
  A rule the script does not hold is written here.
- **Facts are stored, state is derived.** An Issue's state is the result of its applied events, kept on the row because
  its `version` guards the write; a count or a timer that `issue_events` can answer is never a column. The transition
  table (`domains/work/table.ts`) is total: a new state or event fills every cell, and `docs/language.md`'s diagram is
  regenerated (`make check` fails when it is stale).
- **A repo is stored as its project name, never as a path.** Every write that takes a repo (`signal file`, `signal
  promote`, `door route-set`, `issue new`) resolves a name, a path or a linked worktree to the directory name of the main
  checkout (`repoNameOf`, `projectOf`); only a second directory of a taken name (`<name>~<hash>`) is stored as its path.
- **Every effect has a deterministic key** (`kernel/keys.ts`: terminal labels, prompt ids, comment markers, signal
  fingerprints), so a replayed pass never spawns, prompts or posts twice. The Runner looks before it acts.
- **Never call a port inside a transaction.** A pass claims a row and commits, calls the port (every call has a process
  timeout; every port returns a `Result`), and records the outcome in a new transaction. `git` and `make verify` never run
  inside the leads' pass. Admission is decided again at every claim.
- **Deploy locks fail closed.** The factory's own deploy and `factory deploy-lock --project <name> -- <cmd>` hold a
  host-local pid symlink; an unreadable or uncreatable lock refuses the deploy (exit 75 / 1), only a dead holder is reclaimed.
- **Interactive Claude Code in herdr-core only.** Never headless `claude -p`.
- **CLI contract = agw's:** `--format json|plain`, data on stdout, messages on stderr, the exit codes of
  `apps/cli/src/exit.ts`, never prompts. Commands are generated from the OpenAPI document
  (`apps/cli/src/generated/operations.ts`, never edited by hand; `make check` fails when it is stale). `rd --role` depends
  on `factory role get <role> --format json` printing exactly `{"role","tier","effort"}`; a role is a tier
  (`haiku|sonnet|opus`, never a model id) and an effort, in `config/roles.json`, changed only on measured data. The
  hand-written verbs and the credential rules: `docs/operations.md` "The CLI".
- **Tooling:** Bun, TypeScript strict, zod at boundaries, exact pins (no `^`/`~`; `bunfig.toml` sets `exact` and a 3-day
  release-age cooldown, never exclude a package from it). oxlint and oxfmt, no Biome. No Effect (NL11).
- **Who may call what is `apps/server/src/api/policy.ts`.** A caller is decided by its bearer token alone (`owner`,
  `orchestrator`, `agent`, `machine`, `signal`, `read`); a route with no row is 403 for everyone, so a new route gets its
  row first and `apps/server/test/policy.test.ts` fails without one. Only `GET /health` is public. When in doubt, the
  owner alone. The orchestrator has the owner's rights bar the ten owner-only routes of that file's header.
- **Trust boundary.** The owner's and the orchestrator's tokens can start Claude Code with
  `--dangerously-skip-permissions`: a spawn's repo must be inside `FACTORY_REPO_ROOTS` after `realpath`, or be one of the
  repos `FACTORY_REPO_ALLOW` names (colon-separated absolute paths, each one repo and its worktrees, never its siblings;
  `adapters/git/repos.ts`). A work repo of another organisation is admitted by name through the allowlist, never by
  adding the directory that holds it as a root. The API is loopback only; `FACTORY_REF=<branch>` deploys that branch, the same boundary.
- **The Console listener** (`api/console.ts`, `FACTORY_CONSOLE_PORT`, default 7795; 7794 is the agw gateway's) answers 405
  to anything but `GET`/`HEAD` bar its thirteen write verbs (`WRITES` there), forwards only `/health` and `/v1/*` with the
  owner token held in the closure, and can never start a session or cancel, reopen or file an Issue by its own words. **A
  new write goes through the Issue, never onto that list.** The verbs, their guards and the accepted residual:
  `docs/operations.md` "The Console listener". The Console (`apps/console`) holds no logic the API could hold;
  `apps/console/test/no-raw-colour.test.ts` fails on a raw colour.
- **Work repos hear only the owner** (NL18: no `project.yaml`, or `work: true` in it), and the read token never sees their
  words (`read/surface.ts` keeps shape, ids, states and counts). Their text may go to agw (NL22).
- **The door** (`apps/door`) holds only `FACTORY_DOOR_TOKEN` (caller `machine`: `POST /signals/alerts`,
  `POST /signals/feedback` and `POST /door/reports`), no database credential, and takes the repo from the door route
  registry (`factory.door_routes`), never from the payload.
- **Hooks: spool first, then post.** `factory hook <event>` does nothing without `FACTORY_SESSION`, appends to the spool,
  posts to the unix socket and exits 0 whatever happens (the one exception: the Stop send-back, exit 2).
  `apps/cli/src/hook.ts` imports only `node:fs` and `@software-factory/contract/spool` and keeps **stdout empty for every
  event** bar one (`compactedLead`: a lead's post-compaction `session-start` prints one re-read line), because Claude Code
  injects a hook's stdout into the session.
- **One process.** A session-level Postgres advisory lock is taken first; a second copy waits 45 s, then exits 1. Every
  advisory key lives in `adapters/postgres/locks.ts` and they stay distinct.
- **One contract.** Request, response and event shapes are zod schemas in `packages/contract`; the server builds every body
  through its schema and the CLI parses with the same one (a body that does not parse is exit 9).
- **One schema, `factory`,** in the shared database. Migrations (`apps/server/migrations/`, named `NNNN_words.sql`) are
  advisory-locked, qualify every name, are expand then contract, and are never edited once applied (a checksum refuses it).
  A number is used once (only `0993` is shared). `DATABASE_URL` comes from `secrets-run`, never a tracked file.
- **Settings:** secrets in `.env.tpl` (server-only optional refs in `.env.server.tpl`, the door's in `.env.door.tpl`);
  non-secret settings in `~/.config/factory/env`, which `scripts/env-file.sh` allow-lists (a key not on its list refuses
  the start). An edit takes a restart.
- **A request's `check` is a shell command the server runs** (`adapters/shell/check-runner.ts`): only a caller that can run
  a shell itself may set one (owner, orchestrator, agent), never `machine`, `signal` or `read`.
- **The throughput epoch** (`config/throughput.json`): no throughput read counts a sample before it; a bad or missing file
  stops the start. `docs/architecture.md` "The counting epoch and the three answers".
- **Heartbeat names** on `GET /health` (`ok`, `reason`, `tickAt`, `queueMovedAt`) are read by a pusher outside this repo:
  do not rename them. `ok` is false only for a stopped factory; `/health` never queries the database in the request.
- **State words stay off screens** (`scripts/vocabulary.ts`, `docs/language.md` "Where work stands"): the Console, the
  Herdr bar and `read/describe.ts` show Running, Paused, Ready, Held, Checking and Planned, never `queued`, `working`,
  `waiting`, `watching` or `settling`. Retired words (`scripts/retired-words.ts`, the Retires column) fail the same way.
  An exception is a line with its reason in the script's `.allow` file.
- **The README states counts and lists** (event kinds, callers, tokens, screens, domains, states, the Console's port and
  writes): `make docs-check` fails on a mismatch, so change it in the commit that changes one.
- **Hygiene probes are one catalogue** (`packages/contract/src/hygiene-catalogue.ts`): add a probe there, with its default,
  cadence, seat and silence; `docs/hygiene.md` is generated from it.

## Validate and ship

`make check-fast` is the lead's check (everything of `make check` that is not a test run, then the unit tests of the files
the branch changed; outside CI it first applies `oxfmt --write`, so commit what it reformats). CI runs the full gate
sharded; `make check` stays the whole gate locally for a change to the test layout, the Makefile or CI itself, and takes
minutes in a test slot (`factory slot run` wraps it; "queued for a test slot" is a wait, not a hang). Reproduce
one CI failure by running that suite alone inside a slot. The tests start a private Postgres with `initdb` (`PATH` or `PG_BIN_DIR`). The jobs, shards and slot rules: `docs/operations.md` "Check tiers".

Changes land through a pull request (`project.yaml` `ship:`), conventional commits, no AI attribution. Before merging, a
lead takes `factory merge-lock --project software-factory -- sh -c '<rebase on origin/master, push, wait for CI, make
merge-guard, merge>'`, takes the next free migration number if it adds one (`make check` prints it), and merges only when `make
merge-guard` exits 0 (`MERGE_GUARD_ARGS=--wait` waits for the head's CI). `--allow-red` is for the one change that fixes a
red master. `make deploy`, `make rollback` and `make verify` act on the mini only (`DRY_RUN=1` prints the plan,
`FACTORY_REF=<branch>` proves a branch live before it merges). The guard's refusals and the deploy's variables and timings:
`docs/operations.md` "Merging" and "Deploy".

## Where to look

- Layers, the Issue machine, signals and triage, loops and agw, API and CLI, perimeter, what is not built: `docs/architecture.md`.
- A word, an event, a wait and its exit: `docs/language.md`. Why a rule exists: `docs/decisions.md`. What is open:
  `docs/program.md` and `docs/plan.yaml` (the server files its rows as Issues). Writing a plan file: `docs/plan.md`; a `project.yaml`: `docs/project.md`.
- Before changing the Console listener, the CLI's credentials, the merge window, a deploy variable or a CI job, read
  `docs/operations.md`.
- Why a lead is briefed as it is: `apps/server/src/domains/leads/brief.ts`. What a reviewer treats as failure here: `REVIEW.md`.
- The client pieces (Herdr glance mod, Claude Code hook entries, `rd`'s contract, the Hermes `fleet` skill):
  `integrations/`, an index and a README each. Other repos install them; the copies here are the source.

Update this file with the code it describes; a detail that is in the code or in `docs/` is deleted here.
