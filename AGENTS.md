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
  process timeout), records the result in a new transaction. Attempts are capped, capacity is checked again at start,
  and only due rows are selected (`docs/design.md` §3, "The tick").
- **One schema, `factory`,** in the shared database; migrations are advisory-locked and qualify every name.
  `DATABASE_URL` comes from the environment (`.env.tpl` refs through `secrets-run`), never from a tracked file.
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
- `packages/cli` — the `factory` binary (`bin/factory.ts`). v0: `version`, `health`, `spawn list`. Exit codes are
  agw's table, copied in `src/exit.ts`.
- `scripts/` + `deploy/` + `.env.tpl` — release-directory deploy as agent-workflows does it (`deploy.sh`, `launch.sh`,
  `verify.sh`, the LaunchAgent plist template).

## Validate

`make check` — install (frozen), Biome format and lint, shellcheck, `tsc --noEmit`, `bun test`. The tests start a
private Postgres cluster with `initdb` in a temp dir (on PATH, or `PG_BIN_DIR`, or `/usr/lib/postgresql/<major>/bin`
as on GitHub's runners); nothing touches a real database. `make test` runs the tests, `make fmt` formats.
`make deploy` and `make verify` act on the mini only; `DRY_RUN=1 make deploy` prints the plan. CI runs `make check` on
`ubuntu-latest`.
