# software-factory

The lifecycle server for agent-built software: it takes in signals and requests, merges duplicates, queues
work against the available Claude Code subscriptions, starts interactive Claude Code sessions in herdr that
own a piece of work from root cause to production evidence, follows them through hooks, and closes and
learns. CLI `factory`. Status: being planned and built; `docs/program.md` is the current state.

**Start here:** `docs/decisions.md` (what was decided and why) → `docs/program.md` (tracks, who runs them) →
`docs/design.md` (the design) → `docs/research/` → `docs/evidence/` (the golden set and the
intervention KPIs, moved from dotfiles; `README.md` there says what still re-runs).

## Rules

- **Public repo.** No secrets, hostnames, IPs, tailnet names, internal URLs or account e-mails in any tracked
  file. Placeholders: `<your-domain>`, `<see-1password>`. Secrets resolve at runtime through `secrets-run`.
- **The factory never calls a model.** Every judgment (classify, dedup, wording, learnings) is an `agw`
  workflow; the factory calls `agw` like any other client. No model SDK in this repo.
- **Dependencies point one way:** factory → agw, herdr, GitHub, the intake sources. Nothing here is imported
  by agent-workflows.
- **Facts are stored, state is derived.** "Working", "stuck", "waiting" are computed from events when read.
- **Every effect has a deterministic key** (pane names, prompt ids, comment markers), so a replayed tick
  never spawns, prompts or posts twice.
- **Interactive Claude Code in herdr only.** Never headless `claude -p`.
- **CLI contract = agw's:** `--format json|plain`, data on stdout, messages on stderr, the same exit codes,
  never prompts.
- Bun, TypeScript strict, zod at boundaries, exact pins (no `^`/`~`; `~/.bunfig.toml` enforces a 3-day release-age
  cooldown, never exclude a package from it). No Effect: the F0 spike decided that
  (`docs/spikes/2026-10-30-effect/verdict.md`).
- **Never call a port inside a transaction.** The tick claims a row and commits, calls the `Runner` (every call has a
  process timeout), records the result in a new transaction. A failing start is retried until a time budget from the
  first claim (30 min, `FACTORY_RETRY_BUDGET_MS`), then `failed` with a logged reason; `factory spawn requeue <key>`
  starts a failed spawn over. Capacity is checked again at start, and only due rows are selected
  (`docs/design.md` §3, "The tick").
- **The runner looks before it acts.** `HerdrRunner` (herdr 0.9.3) finds the tab by its label and the agent by its
  pane, never by an exit code, and carries on where an earlier call stopped: no second tab, no second agent, no second
  prompt (a prompt counts as delivered once the agent is not a fresh idle one). It does the steps of `rd wave`
  (account's `CLAUDE_CONFIG_DIR` via `--env`, `claude-pretrust.sh`, `agent start`, prompt proven by a state change, one
  re-send); a tab without a ready agent is never `started`. A prompt cannot start with `-` (herdr reads it as an option).
- **A failed spawn leaves its tab.** The tab is named after the key and `factory spawn requeue` finds it again (an agent
  already running keeps the account it started on); closing it is a decision, not a side effect of `failed`. A tab with
  no agent is closed and made again on every try, so a retry on another account gets that account's environment.
- **Trust boundary.** The token is shell access as the mini user by design: it can start Claude Code with
  `--dangerously-skip-permissions` in any `repo` path. The API is loopback only and the tailnet plus the owner's GitHub
  user is the perimeter (`docs/design.md` §1). `FACTORY_REF=<branch>` runs whatever is on that origin branch with the
  server's secrets, the same boundary; `make deploy` without it deploys `master`.
- **One process.** A session-level Postgres advisory lock is taken before anything else, and a watchdog exits the server
  if its connection loses it; a second copy exits 1. Every
  advisory key lives in `src/locks.ts` and they must stay distinct.
- **`/health` is the ticker's pulse:** the last successful tick and the last tick error; no success within three
  intervals (or a pass past its lease) is 503, which fails `make verify` and the deploy health check.
- **One contract.** Response shapes are zod schemas in `packages/contract`; the server builds every body through its
  schema and the CLI parses with the same one (a body that does not parse is exit 9).
- **One schema, `factory`,** in the shared database; migrations are advisory-locked and qualify every name.
  The `factory` role owns the schema in the database `shared` (`vps: make db-shared`), holds no CREATE on the database
  and has 10 connections; `launch.sh` builds `DATABASE_URL` from its password (`.env.tpl` refs through `secrets-run`),
  never from a tracked file.
  Migrations are additive for one release (expand, then contract): a rollback starts the previous release on the
  migrated schema.
- **The API is authenticated.** Every route but `GET /health` needs `Authorization: Bearer <FACTORY_TOKEN>`; a body
  needs `application/json` (415), at most 64 KiB (413), and the Host must be loopback (421). The CLI reads the token
  from `FACTORY_TOKEN`; run it under `secrets-run run --env-file=.env.tpl -- factory ...`.
- Direct-to-master, conventional commits, no AI attribution. Update this file in the same commit as the
  code it describes.

## Layout

- `packages/server` — the lifecycle server: HTTP (`http.ts`), the tick (`tick.ts`), the `Runner` port and its herdr
  adapter (`runner.ts`), derived session state (`sessions.ts`), the queue and capacity (`spawns.ts`, `capacity.ts`),
  `migrations/`.
- `packages/contract` — the zod schemas of every response, imported by the server and the CLI.
- `packages/cli` — the `factory` binary (`bin/factory.ts`). v0: `version`, `health`, `spawn list`, `spawn requeue`. Exit
  codes are agw's table, copied in `src/exit.ts`.
- `scripts/` + `deploy/` + `.env.tpl` — release-directory deploy as agent-workflows does it (`deploy.sh`, `launch.sh`,
  `verify.sh`, the LaunchAgent plist template).

## Validate

`make check` — install (frozen), Biome format and lint, shellcheck, `tsc --noEmit`, `bun test`. The tests start a
private Postgres cluster with `initdb` in a temp dir (on PATH, or `PG_BIN_DIR`, or `/usr/lib/postgresql/<major>/bin`
as on GitHub's runners); nothing touches a real database. `make test` runs the tests, `make fmt` formats.
`make deploy` and `make verify` act on the mini only; `DRY_RUN=1 make deploy` prints the plan. `FACTORY_REF=<branch>` on
both proves a branch live before it is merged (default `master`). The herdr fake for the tests is
`packages/server/test/support/fake-herdr.ts` (shapes taken from a live herdr 0.9.3). CI runs `make check` on
`ubuntu-latest`.
