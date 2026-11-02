# software-factory

The lifecycle server for agent-built software: it takes in signals and requests, merges duplicates, queues
work against the available Claude Code subscriptions, starts interactive Claude Code sessions in herdr-core terminals that
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
- **Dependencies point one way:** factory → agw, herdr-core, GitHub, the intake sources. Nothing here is imported
  by agent-workflows.
- **Facts are stored, state is derived.** "Working", "stuck", "waiting" are computed from events when read.
- **Every effect has a deterministic key** (pane names, prompt ids, comment markers), so a replayed tick
  never spawns, prompts or posts twice.
- **Interactive Claude Code in herdr-core only.** Never headless `claude -p`.
- **CLI contract = agw's:** `--format json|plain`, data on stdout, messages on stderr, the same exit codes,
  never prompts.
- Bun, TypeScript strict, zod at boundaries, exact pins (no `^`/`~`; `~/.bunfig.toml` enforces a 3-day release-age
  cooldown, never exclude a package from it). No Effect: the F0 spike decided that
  (`docs/spikes/2026-10-30-effect/verdict.md`).
  The effects are in `docs/design.md` §3 "As built".
- **Never call a port inside a transaction.** The tick claims a row and commits, calls the `Runner` (every call has a
  process timeout), records the result in a new transaction. A failing start is retried until the 30-minute budget, then
  `failed` with a logged reason; `factory spawn requeue <key>` starts it over. Admission is decided again at every claim.
- **Trust boundary.** The token can start Claude Code with `--dangerously-skip-permissions`: a spawn's `repo` and `space` must be
  inside `FACTORY_REPO_ROOTS` after `realpath`, else 422 and nothing stored. The API is loopback only; the tailnet and the
  owner's GitHub user are the perimeter. `FACTORY_REF=<branch>` deploys that branch, the same boundary.
- **The door** (`packages/door`, `docs/design.md` §11): alerts from the tailnet become Issues. It binds loopback only, holds no factory token
  and no database credential, and posts to the socket's `POST /intake`; the repo comes from `factory.door_routes`, never the payload.
- **Hooks: spool first, then post.** `factory hook <event>` does nothing without `FACTORY_SESSION`, appends one line to the
  spool, posts it to the unix socket (300 ms) and exits 0 whatever happens (one exception: the Stop send-back, exit 2).
  `src/hook.ts` imports only `node:fs` and `@software-factory/contract/spool` (no zod, no rest of the CLI) and keeps
  **stdout empty for every event, and stderr too except for a send-back**: Claude Code injects a hook's stdout into the
  session's context. The socket (mode 0600) is the hook's credential; the witness alone records `runner_restarted` and
  `pane_gone`.
- **Placement and sessions.** The Runner looks before it acts: a terminal carries `factory.key=<spawn key>`, and a live one
  running claude is never started twice. One space per repo, keyed by path. A spawn with a parent
  terminal is that terminal's hidden child when `placement` says `child`; `tab` makes it a tab; with none, by role: `worker`,
  `mechanical` or `deep` child, every other role a tab. State is derived from stored events, never stored.
- **Roles** (`config/roles.json`): role → tier (`haiku|sonnet|opus`, never a model id) and effort. `deep` is a worker raised for
  novel hard logic (opus, high). `rd --role` depends on `factory role get <role> --format json` printing exactly
  `{"role","tier","effort"}`; unknown is exit 4. Values change only on measured data.
- **One process.** A session-level Postgres advisory lock is taken first; a second copy exits 1. Every advisory key lives in
  `src/locks.ts` and they stay distinct.
- **One contract.** Response shapes are zod schemas in `packages/contract`; the server builds every body through its schema and
  the CLI parses with the same one (a body that does not parse is exit 9).
- **One schema, `factory`,** in the shared database; migrations are advisory-locked, qualify every name, and are expand, then
  contract. The `factory` role has no CREATE on the database; `DATABASE_URL` comes from `secrets-run`, never a tracked file.
- **The API is authenticated.** Every route but `GET /health` needs `Authorization: Bearer <FACTORY_TOKEN>`; JSON only (415), at
  most 64 KiB (413), loopback Host (421). The CLI reads `FACTORY_TOKEN`; run it under `secrets-run run --env-file=.env.tpl --`.
- **Tests:** `make test` runs through `factory slot run` when `factory` is installed (a lease, fails open). Update this file in
  the same commit as the code it describes; behaviour goes to `docs/design.md` §3 "As built", not here.
- Direct-to-master, conventional commits, no AI attribution.

**Issues** are `docs/design.md` §4: `src/issues/lifecycle.ts` is the one writer of `issues.state` (a create, always `queued`, is `create.ts`; the door's `intake.ts` files through it); past about 500 lines, stop. `FACTORY_AGW_BIN` is the `agw` Classify calls; `FACTORY_ALERT_LEADS=0` keeps `alert` Issues from starting a lead (default on); `FACTORY_ARCHIVE_DIR` is where a closed attempt's transcripts go (default `~/.local/share/factory/archive`). `issue_id` goes on a lead's session only. `git` and `make verify` never run on the tick or in a transaction: a lead's call waits for its `git`, and `verify` and `finalize` run off the tick (`issues/offtick.ts`).

**The fleet view** is `docs/design.md` §11 "The fleet view": `src/fleet/` (`index.ts` the builder the tick kicks, `model.ts` the pure assembly, `plans.ts`, `sources.ts` hc and the human queue, `git.ts`, `store.ts` the one-row snapshot `factory.fleet_snapshot` and `NOTIFY fleet`), `GET /fleet` and `POST /fleet/refresh` (**token API only**: the model holds IuRoot's text, so the socket answers 404), `factory fleet` (needs `FACTORY_TOKEN`, exit 3 without). The model itself reads and calls no model; **the digest** (`src/fleet/digest*.ts`, `transcript.ts`; `docs/design.md` §11 "The digest") asks `agw digest` about what changed every `FACTORY_DIGEST_EVERY` (default `5m`, `off`) and the snapshot reads its cache (`short`, `headline`, `source: reply` asks); **nothing of a `visible` (IuRoot) repo, plan or session is ever sent** (`scopeOf` is the one place that decides). Config: `FACTORY_VISIBLE_ROOTS` (read-only roots, default `~/IuRoot`, `off`), `FACTORY_ASK_HUMAN`, `FACTORY_DIGEST_EVERY`, `FACTORY_PROBE_HOSTS`. Migrations `021`, `022`, `023`.

**Triage** (`src/fleet/triage.ts`, `probes.ts`, `triage-store.ts`, `act.ts`; `docs/design.md` §11 "Triage and actions"): a tier, a suggestion with evidence and `actions[]` per ask by deterministic rules (the digest never moves an ask); probes are read-only, bounded, run in the build; `POST /fleet/asks/:id/act` takes intents (token only), **never runs a queue request's command** (`ask-human.sh resolve` only records how it ended), and `archive_plan`/`hand_off` are spawns a worker carries out, never the server; the automatic tier is bookkeeping in `factory.fleet_triage_log`, undoable (`POST /fleet/triage/:id/undo`). `factory fleet act|triage`. Migration `024`.

**Away and back** (`src/fleet/presence.ts`, `away.ts`, `since.ts`, `window.ts`; `docs/design.md` §11 "The fleet view", "The owner's line"): `POST /fleet/presence {place, act, until?}` (human acts only; `caught_up` alone takes `until`, and needs it; the desk is present 45 min after its last act, the phone 10; derived by the clock, `presence` on `GET /fleet`), one owner-wide `seen_at` (moves on `caught_up`, to the `until` of the reading that was seen, and on the act that closes the window's last ask), `GET /fleet/since?t=` (grouped, every line with its `source`; **never calls agw or git**), the headline paragraph as `agw digest` kind `window` (non-IuRoot facts only, an IuRoot item is a count; cached by the facts' hash, queued and run by the tick), the away rule in the outbox (`folded`: only a decision, the morning reading and a test go out unless the phone is present and the desk is not), and the 07:30 message as the since groups with no model text. `factory fleet presence|since|seen` (token only). Migrations `025` to `027`.

**Behaviour as built** is in `docs/design.md` §3 "As built": the tick, spaces, the runner, hooks and the socket, prompt delivery,
the rules that act, the spool, derived state, sessions, the witness, panes as clients, test slots, quota, admission, the queue
state, roles, process/health/contract/schema/API.

## Layout

- `packages/server` — the lifecycle server: HTTP (`http.ts`), the tick (`tick.ts`), the `Runner` port and its herdr-core
  adapter (`runner.ts`: the port; `hc-runner.ts`, `hc.ts`, `app-doc.ts`), derived session state (`sessions.ts`), the hooks' spool (`spool.ts`), the witness
  (`witness.ts`, `hc-events.ts`), the queue (`spawns.ts`, `queue.ts`), admission and capacity (`admission.ts`, `capacity.ts`), the account
  picker's readings (`quota.ts`), prompt delivery (`prompts.ts`), the rules that act (`rules.ts`), the status screen
  (`status.ts`), the test slots (`slots.ts`), Issues (`issues/`: `lifecycle.ts` the one writer, `inbox.ts`, `worker.ts`, `effects.ts`,
  `read.ts`; classify, the lead, its brief, worktree, verbs and send-back: `classify.ts`, `admission.ts`, `lead.ts`, `leadtree.ts`, `names.ts`, `brief.ts`, `worktree.ts`, `verbs.ts`, `sendback.ts`; evidence, the hold and finalize: `evidence.ts`, `commits.ts`, `origin.ts`, `hold.ts`, `finalize.ts`, `archive.ts`, `resume.ts`, `offtick.ts`; what `factory status` and `issue show` read: `follow.ts` (the ISSUES section, the timeline), `attention.ts` (its ATTENTION lines)), projects (`projects/`: `project.yaml` v0 sync, the make contract, claims; `docs/design.md` §9 "As built"), `migrations/`.
- `packages/contract` — the zod schemas of every response, imported by the server and the CLI, the Issues' (`issues.ts`), and the
  role table's schema and loader (`roles.ts`); `spool.ts` is the zod-free half the hook uses (event kinds, the spool line, key and time counting).
- `project.yaml` — this repo's manifest (`docs/design.md` §9); the schema is `packages/contract/src/projects.ts`.
- `config/roles.json` — the role table (FL4).
- `packages/server/src/notify/` — the owner's line (`docs/design.md` §11): the `Notifier` port (`port.ts`: Hermes, null, and the tests' fake), the outbox (`outbox.ts`), the rules and templates (`rules.ts`, `text.ts`), the morning reading (`digest.ts`), `index.ts` the tick's pass. Migration `018`; the away rule is in `outbox.ts`. Config: `FACTORY_NOTIFY_TARGET`, `HERMES_BIN`, `FACTORY_DIGEST_AT`, `FACTORY_DIGEST_TZ`.
- `packages/door` — the factory door: a Bun server, `POST /alert/<source>`, the parsers (`src/parsers.ts`), the tokens file; its README has the HyperDX template.
  Server side: `issues/intake.ts`. LaunchAgent `deploy/com.jkrumm.factory-door.plist.template`, `scripts/launch-door.sh`.
- `packages/cli` — the `factory` binary (`bin/factory.ts`): `version`, `health`, `status`, `spawn list|create|get|requeue`, `session
  list|get|wait|note`, `slot run`, `queue get|set`, `quota get|refresh`, `role list|get`, `issue new|list|show` (`show` is the Issue with its timeline, evidence and questions), `issue phase|wait|ship|close|block|ask|drop <id>` (a lead's report), `issue evidence|reopen|stop|resume <id>`, `issue answer <id> <text>` and `issue note <id> <text>` (the owner's, token only), `notify list|test`, `project list|show|sync`, `fleet [--refresh]`, `fleet act <ask> <intent>`, `fleet triage [--undo <id>]`, `fleet presence <place> <act> [--until <iso>]`, `fleet since [--t <iso>]`, `fleet seen --until <iso>`, `door route|unrouted|token`, `hook <event>` (`src/hook.ts`). Exit codes are agw's table, copied in `src/exit.ts`.
- `scripts/` + `deploy/` + `.env.tpl` — release-directory deploy as agent-workflows does it (`deploy.sh`, `launch.sh`,
  `verify.sh`, the LaunchAgent plist template). `launch.sh` also applies `~/.config/factory/env` (`FACTORY_ENV_FILE`; `env-file.sh`): `KEY=VALUE` lines only, mode 0600 and owned by the user, only the non-secret keys `env-file.sh` lists (e.g. `FACTORY_PROBE_HOSTS`), else the start is refused; secrets stay in `.env.tpl`; read at launch, so an edit takes a restart.
- `scripts/gameday/` — the F1 kill gamedays: `run.sh <claimed|working>` `kill -9`s the server at a chosen moment and counts what survives; `setup.sh`, `collect.sh`, `teardown.sh`, `kill-server.sh`, `template/` the scratch repo. Evidence in `docs/evidence/f1-gamedays/`.
- `scripts/gameday/f2/` — the F2 gamedays, live against the deployed factory with real leads: `run.sh <silent-lead|seeded-bug|seeded-bug-regress> [run-id]`, a `report.md` per run in `docs/evidence/f2-gate/`.

## Validate

`make check` — install (frozen), oxfmt check, oxlint (type-aware), shellcheck, `tsc --noEmit`, `bun test`. The tests start a
private Postgres cluster with `initdb` in a temp dir (on PATH, or `PG_BIN_DIR`, or `/usr/lib/postgresql/<major>/bin`
as on GitHub's runners); nothing touches a real database. `make test` runs the tests, `make fmt` formats.
`make deploy` and `make verify` act on the mini only; `DRY_RUN=1 make deploy` prints the plan. `FACTORY_REF=<branch>` on
both proves a branch live before it is merged (default `master`). The hc fake for the tests is
`packages/server/test/support/fake-hc.ts` (shapes taken from a scratch core, hc 0.1.15); `HC_E2E=1 bun test packages/server/test/hc-e2e.test.ts` runs the runner and the witness against a scratch core. CI runs `make check` on
`ubuntu-latest`.
