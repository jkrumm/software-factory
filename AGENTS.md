# software-factory

The lifecycle server for agent-built software: it takes in signals, triages them into Issues, queues work against the
available Claude Code subscriptions, starts interactive Claude Code sessions in herdr-core terminals that own a piece of
work from root cause to production evidence, follows them through hooks, and closes and learns. CLI `factory`.
Status: the rewritten core has been live on the mini since 2026-11-08; `docs/program.md` is the current state.

**Start here:** `docs/product.md` (what it is) → `docs/language.md` (the words) → `docs/architecture.md` (what is built
and where) → `docs/decisions.md` (what was decided and why) → `docs/research/` → `docs/evidence/`. `docs/rewrite/` is
the record of the rewrite and `docs/rewrite/state.md` its log. A directory listing, `package.json`, the Makefile and
`--help` say what exists; this file says what they cannot.

## Rules

- **Public repo.** No secrets, hostnames, IPs, tailnet names, internal URLs or account e-mails in any tracked file.
  Placeholders: `<your-domain>`, `<see-1password>`. Secrets resolve at runtime through `secrets-run`. MIT licensed.
  `scripts/public-scan.ts` (in `make check`) fails on an address, tailnet name, e-mail, secret, home path, ssh alias, account
  or work-repo name in any tracked file; an exception is a line in `scripts/public-scan.allow` with its reason. Work repos
  appear only as `WorkRoot` and `work-repo-N`.
- **The factory never calls a model.** Every judgment (triage, the steward, the Judge, the queue, the screening of held signals) is an `agw` workflow
  called through `apps/server/src/adapters/agw/`. No model SDK in this repo.
- **Dependencies point one way:** factory → agw, herdr-core, GitHub, the intake sources. Nothing here is imported by
  agent-workflows.
- **The layers are enforced** by `scripts/boundaries.ts` in `make check`: `domains/*` import only `kernel` and their own
  folder and do no I/O; a domain reaches another through `app/`; `read/` writes nothing; only
  `adapters/postgres/unit-of-work.ts`, `migrate.ts` and `read/bounded.ts` (a read-only, timed read) open a transaction. A rule the script does not hold is written here.
- **Facts are stored, state is derived.** An Issue's state is the result of its applied events, kept on the row because its
  `version` guards the write; a count or a timer that `issue_events` can answer is never a column. A lead's session state is
  derived from its hook events when read. The transition table (`domains/work/table.ts`) is total: a new state or event
  fills every cell, and `docs/language.md`'s diagram is regenerated (`make check` fails when it is stale).
- **A repo is stored as its project name, never as a path.** Every write that takes a repo (`signal file`, `signal promote`, `door route-set`,
  `issue new`) resolves a name, a path or a linked worktree to the directory name of the main checkout (`repoNameOf`,
  `projectOf`) and stores that; an agent signal's source is `agent:<project name>` (a lead's `agent:factory-<issue>-<n>`
  resolves to its Issue's project). Only a second directory of a taken name (`<name>~<hash>`) is stored as its path.
- **Every effect has a deterministic key** (`kernel/keys.ts`: terminal labels, prompt ids, comment markers, signal
  fingerprints), so a replayed pass never spawns, prompts or posts twice. The Runner looks before it acts: a terminal
  carries `factory.key=<spawn key>`.
- **Never call a port inside a transaction.** A pass claims a row and commits, calls the port (every call has a process
  timeout; every port returns a `Result`), and records the outcome in a new transaction. `git` and `make verify` never run
  inside the leads' pass. Admission is decided again at every claim.
- **Deploy locks fail closed.** The factory's own deploy and `factory deploy-lock --project <name> -- <cmd>` (other
  projects' leads) hold a host-local pid symlink; an unreadable or uncreatable lock refuses the deploy (exit 75 / 1), only
  a dead holder is reclaimed.
- **Interactive Claude Code in herdr-core only.** Never headless `claude -p`.
- **CLI contract = agw's:** `--format json|plain`, data on stdout, messages on stderr, the same exit codes
  (`apps/cli/src/exit.ts`), never prompts; help and body validation derive from the contract schemas (`--schema` prints one). Commands are generated from the OpenAPI document
  (`apps/cli/src/generated/operations.ts`, never edited by hand; `make check` fails when it is stale); `hook`, `slot`,
  `deploy-lock`, `follow`, `retro` (the weekly retro bundle: the retro read plus a pass over the lead transcripts), `role`, `issue schema` (the filing contract, offline) and `plan schema` / `plan check` (the plan page and a line-numbered check of a plan file, offline) are hand-written. On the host a call with neither `FACTORY_TOKEN` nor `FACTORY_READ_TOKEN` resolves the owner token itself (`apps/cli/src/credentials.ts`: the deployed release's `.env.tpl` through `secrets-run`); a set token always wins, offline verbs and `health get` never resolve one. The CLI is the one vocabulary on the host: `rd` keeps only the owner's terminal verbs. `rd --role` depends on `factory role get <role> --format json`
  printing exactly `{"role","tier","effort"}`; unknown is exit 4. A role is a tier (`haiku|sonnet|opus`, never a model id)
  and an effort, in `config/roles.json`, changed only on measured data. The table governs the terminals the factory spawns
  (the lead, `rd --role`); an Issue's or plan row's `seat` overrides the lead row for that Issue. A lead's in-session subagents take model and effort from the global agent files in dotfiles
  (`agents/*.md`), and the reviewer's seat comes from `agw review prepare`.
- **Tooling:** Bun, TypeScript strict, zod at boundaries, exact pins (no `^`/`~`; the repo's `bunfig.toml` (and `~/.bunfig.toml`) sets
  `exact` and a 3-day release-age cooldown, never exclude a package from it). oxlint and oxfmt, no Biome. No Effect (NL11).
- **The orchestrator has its own principal:** token `FACTORY_ORCHESTRATOR_TOKEN` (optional, in `FACTORY_TOKEN` of its
  terminal), caller and actor `orchestrator`. It has the owner's rights bar eight owner-only routes (worth-asking, verdict,
  annotations with their edit and delete, Errand done, promote and dismiss of a held signal), and every owner-touch count reads the owner alone; its steering is the friction group
  `orchestrator_steer`. `--via orchestrator` stays only for a client still on the owner token.
- **Who may call what is `apps/server/src/api/policy.ts`.** A caller is decided by its bearer token alone (`owner`, `orchestrator`, `agent`,
  `machine`, `signal`, `read`); a route with no row is 403 for everyone, so a new route gets its row first and
  `apps/server/test/policy.test.ts` fails without one. Only `GET /health` is public. When in doubt, the owner alone.
- **Trust boundary.** The owner's token and the orchestrator's can start Claude Code with `--dangerously-skip-permissions`: a spawn's repo must be
  inside `FACTORY_REPO_ROOTS` after `realpath` (`adapters/git/repos.ts`). The API is loopback only; the tailnet and the
  owner's GitHub user are the perimeter. `FACTORY_REF=<branch>` deploys that branch, the same boundary.
- **The Console listener** (`apps/server/src/api/console.ts`) is a second loopback listener (`FACTORY_CONSOLE_PORT`, default 7795; 7794 is the agw gateway's), published on the tailnet by
  dotfiles-private's serve row on :8797 (not by `make deploy`) and started whenever the Console is built. It answers 405 to
  anything but `GET`/`HEAD` (bar the eight verbs below), forwards only `/health` and `/v1/*` to the API (the owner token stays
  in the closure; the client's `authorization`, `cookie` and `tailscale-*` headers are dropped; an answer with no `cache-control` of its own gets `no-store`), and serves
  `apps/console/dist` otherwise. The one writes it forwards are the owner's eight answer verbs and nothing else (405):
  `decisions/:id/answer`, `artifacts/:id/verdict`, `artifacts/:id/annotations` (`POST`) with `PATCH` and `DELETE` on `artifacts/:id/annotations/:annotationId`, `errands/:id/done` and
  `POST /signals/:id/promote` and `POST /signals/:id/dismiss`, each but the `DELETE` needing `content-type: application/json` (415), no cross-site `sec-fetch-site` and no
  foreign `origin` (403; there is no per-request identity, so a page in the owner's browser could send one) and at most 64 KiB (413).
  It can never start a session, and never cancels, reopens or files an Issue by its own words; promote files one only
  from a signal already held; dismiss files nothing. `/frame.html` and `/frame/*`, the artifact's sandboxed frame, are served under their own CSP
  (scripts, no network), the page keeps `script-src 'self'`. A new write goes through the Issue, not this list. Residual, accepted
  (`docs/architecture.md` "Perimeter", NL25): there is no per-request identity and the ACL tag grant is the perimeter, so any
  tagged node granted :8797 and any process on the mini reads what the owner reads (including what the read token is denied)
  and can make those eight answers, promote among them;
  the `origin` check compares with the request's own `Host`, so a page rebound to loopback in a browser on the mini passes it.
  The Console (`apps/console`, `README.md` there) holds no logic the API could hold, and
  `apps/console/test/no-raw-colour.test.ts` fails on any raw colour.
- **Work repos hear only the owner** (NL18, no `project.yaml`), and the read token never sees their words
  (`read/surface.ts` keeps shape, ids, states and counts). Their text may go to agw (NL22).
- **The door** (`apps/door`) holds only `FACTORY_DOOR_TOKEN` (caller `machine`: `POST /signals/alerts`,
  `POST /signals/feedback` and `POST /door/reports`, nothing else), no database credential, and takes the repo from the door route registry
  (`factory.door_routes`), never from the payload.
- **Hooks: spool first, then post.** `factory hook <event>` does nothing without `FACTORY_SESSION`, appends to the spool,
  posts to the unix socket and exits 0 whatever happens (one exception: the Stop send-back, exit 2). `apps/cli/src/hook.ts`
  imports only `node:fs` and `@software-factory/contract/spool` and keeps **stdout empty for every event** (and stderr,
  except a send-back): Claude Code injects a hook's stdout into the session's context. The one exception is a
  `session-start` with `source: compact` in an Issue lead's session: one line telling it to re-read the Issue. The socket
  (mode 0600) is the hook's credential; it is a same-user boundary, not a per-session one (SF11).
- **One process.** A session-level Postgres advisory lock is taken first; a second copy waits 45 s, then exits 1. Every
  advisory key lives in `adapters/postgres/locks.ts` and they stay distinct.
- **One contract.** Request, response and event shapes are zod schemas in `packages/contract`; the server builds every body
  through its schema and the CLI parses with the same one (a body that does not parse is exit 9).
- **One schema, `factory`,** in the shared database. Migrations (`apps/server/migrations/`, named `NNNN_words.sql`) are
  advisory-locked, qualify every name, are expand then contract, and are never edited once applied (a checksum refuses it).
  A number is used once: `loadMigrations` refuses a repeat (only `0993` is shared, both files applied; the ledger keys on the name).
  `DATABASE_URL` comes from `secrets-run`, never a tracked file.
- **Settings:** secrets in `.env.tpl` (server-only optional refs in `.env.server.tpl`, read by the launcher and the deploy's
  ref check only, never by a client; the door has `.env.door.tpl`); non-secret settings in `~/.config/factory/env`, which
  `scripts/env-file.sh` allow-lists (a key not on its list refuses the start; the old core's keys stay listed so an old file
  and a rollback still launch). Read at launch: an edit takes a restart.
- **Heartbeat names** on `GET /health` (`ok`, `reason`, `tickAt`, `queueMovedAt`) are read by a pusher outside this repo:
  do not rename them.
- **Retired words fail `make check`** (`scripts/retired-words.ts`, the Retires column of `docs/language.md`). An exception
  is a line with its reason in `scripts/retired-words.allow`; a stale line fails too.

## Where to look

- Layers, the Issue machine, signals and triage, loops and agw, API and CLI, perimeter, what is not built yet:
  `docs/architecture.md`.
- A word, an event, a wait and its exit: `docs/language.md`. Why a rule exists: `docs/decisions.md`. What is open:
  `docs/program.md` and `docs/plan.yaml` (the server files its rows as Issues). Writing a plan file: `docs/plan.md`.
- Why a lead is briefed as it is: `apps/server/src/domains/leads/brief.ts`. What a reviewer treats as failure here:
  `REVIEW.md`.
- The factory's client pieces (the Herdr glance mod, the Claude Code hook entries, `rd`'s contract, the Hermes `fleet`
  skill): `integrations/`, an index and a README each. Other repos install them; the copies here are the source.
- Moving to or away from the live core (windows, the way back): `docs/rewrite/cutover-runbook.md`.

## Validate and ship

`make check` runs install (frozen), oxfmt check, oxlint (type-aware), shellcheck, `tsc --noEmit`, the boundary script, the public-hygiene scan, the
retired-word check, the Issue diagram and generated-CLI freshness checks, `bun test` and the scenarios (`tests/scenarios`:
a real server and Postgres with fake `hc` and `agw`), then typechecks and builds the Console and runs its Playwright suite
(`make e2e`, `tests/e2e`) against a seeded server; `make fmt` formats. The tests start a private Postgres cluster with
`initdb` (on PATH, or `PG_BIN_DIR`); nothing touches a real database. `make check` (and `make test`, `make e2e` alone) goes through `factory slot run` when
`factory` is installed: one lease on the host's test slots for the whole check, "queued for a test slot" on stderr while it waits,
a wait past 45 min exits 75 without running. `make deploy`,
`make rollback` and `make verify` act on the mini only; `DRY_RUN=1` prints the plan, `FACTORY_REF=<branch>` proves a branch
live before it is merged. CI runs `make check` on `ubuntu-latest`.

**Merging.** Parallel leads share one master, so before a lead merges its PR it rebases on the current `origin/master`,
takes the next free migration number if it adds a migration (`make check` prints it; `scripts/merge-guard.ts
--next-migration` too) and pushes. `make check` runs locally before the first push and after every change the lead authors; a
rebase that only brings in master's commits is not re-run locally, CI on the rebased head is that check (NL28). Then
`make merge-guard` (`MERGE_GUARD_ARGS=--wait` waits for the head's CI), merging only on exit 0. The guard refuses, with the
reason, a branch that does not contain `origin/master`, a new migration whose number master (or the branch) already uses,
a head with no finished green CI run on its exact sha, and a master whose last finished CI run is red (a cancelled run was
superseded and is skipped; an unreadable `gh` refuses too; a master run still running is not a refusal). `MERGE_GUARD_ARGS=--allow-red`
is for the one change that fixes a red master and never skips the head's CI. The lead's brief (`domains/leads/brief.ts`)
states the same rule, and by hand for a repo with no `make merge-guard`.

Changes land through a pull request (`project.yaml` `ship:`), conventional commits, no AI attribution. Update this file in
the same commit as the code it describes, and keep it to what lookup cannot reveal: a detail that is in the code or in
`docs/architecture.md` is deleted here.
