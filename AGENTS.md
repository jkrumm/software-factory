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
  starts a failed spawn over. Admission is decided again at every claim except a reclaim (an expired lease: its agent may
  already run, so it finishes on its account), and only due rows are selected
  (`docs/design.md` §3, "The tick").
- **The runner looks before it acts.** `HerdrRunner` (herdr 0.9.3) finds the tab by its label and the agent by its
  pane, never by an exit code, and carries on where an earlier call stopped: no second tab, no second agent, no second
  prompt (a prompt counts as delivered once the agent is not a fresh idle one). It does the steps of `rd wave`
  (account's `CLAUDE_CONFIG_DIR` via `--env`, `claude-pretrust.sh`, `agent start --model <tier> --effort <effort>` from the
  spawn's role, prompt proven by a state change, one re-send); a tab without a ready agent is never `started`. A prompt cannot start with `-` (herdr reads it as an option).
- **A failed spawn leaves its tab.** The tab is named after the key and `factory spawn requeue` finds it again (an agent
  already running keeps the account it started on); closing it is a decision, not a side effect of `failed`. A tab with
  no agent is closed and made again on every try, so a retry on another account gets that account's environment.
- **Trust boundary.** The token can start Claude Code with `--dangerously-skip-permissions`, so a spawn's `repo` must be
  inside an allow-listed root: `FACTORY_REPO_ROOTS` (colon-separated, default `$HOME/SourceRoot:$HOME/IuRoot`). The path
  is resolved with `realpath` and must be strictly inside a resolved root, so neither `..` nor a symlink leaves it;
  otherwise `POST /spawns` answers 422 and stores nothing (the row keeps the resolved path). Within the roots the token is
  shell access as the mini user by design. The API is loopback only and the tailnet plus the owner's GitHub
  user is the perimeter (`docs/design.md` §1). `FACTORY_REF=<branch>` runs whatever is on that origin branch with the
  server's secrets, the same boundary; `make deploy` without it deploys `master`.
- **Hooks: spool first, then post.** `factory hook <event>` (session-start, user-prompt-submit, stop, stop-failure,
  notification, session-end) does nothing without `FACTORY_SESSION` (set at spawn: the Runner puts the spawn key in the
  pane's `--env`, `rd` its agent name). Otherwise it appends one line to `~/.local/share/factory/spool/<session>.jsonl`
  (`FACTORY_SPOOL_DIR`, one `O_APPEND` write), posts it to the server's unix socket (`FACTORY_SOCKET`, default
  `~/.local/share/factory/hook.sock`, 300 ms timeout) and exits 0 whatever happens. The hook has no token and the Runner
  keeps secrets out of the panes, so the socket (mode 0600, owner only) is its credential; the socket serves
  `POST /events` and `POST /sessions/:id/wait` (`factory session wait`, which
  a session in a pane runs without a token) and nothing else; bound under umask 0177. It imports nothing but `node:fs` and `@software-factory/contract/spool`: keep zod and
  the rest of the CLI out of `src/hook.ts` (`bin/factory.ts` loads it alone). **Stdout and stderr stay empty for every
  event**: Claude Code injects a SessionStart/UserPromptSubmit hook's stdout into the session's context (tested per event).
- **The key is session, event name, turn number** (`<session>:turn_ended:3`), counted from the spool, written into the
  line, so a replay carries it. Counting and appending happen under a per-session lock (`<file>.lock`, a `mkdir`; the
  server's rotation takes it too); a hook that cannot get it in 200 ms writes a key with a random suffix instead. A kind that repeats inside a turn gets `:2`, `:3`. Event time is strictly increasing per
  session. `SpoolReplayer` (`spool.ts`) reads the directory at the start of every tick and stores whole lines past its
  in-memory offset (a restart re-reads: the unique key makes it harmless). A quiet, fully read file over 64 KiB is
  rotated: its sums (`turns`, current-turn counts) go to `<file>.base` first, so numbering never starts over, then the
  file is retired. Spool files of dead sessions are kept (a reused `rd` name must not reuse keys). A rotation that died after moving the
  file leaves `<file>.retired`; the next pass stores it and removes it. The lock holds a token, so a holder taken for
  dead cannot release its successor's lock.
- **Derived state** (`sessions.ts`, first match wins; turns, walls and prompts count from the latest `session_started`):
  `dead` (last of session_started / session_ended / pane_gone is not a start; a `pane_gone` is withdrawn by a later hook
  event or by herdr showing the agent again), `starting` (the factory has the row, nothing proves it is up), `walled` (limit_stop or quota_resume with no
  later turn_started; a turn that ends after `quota_resume fired` ends it too), `blocked` (prompt_blocked with no later
  turn_started or turn_ended), `working` (open turn; `stuck` when herdr says working within 5 minutes and neither the
  worktree nor the turn moved for 45 minutes), `waiting` (an open `factory session wait --on workers|deploy|owner`, no
  open turn), `idle`. Events are ordered by event time, then arrival. Only `limit_stop` from `StopFailure rate_limit`
  is a wall; other stop failures are ignored.
- **`factory.sessions` is what the factory follows; `usage` owns the session entity.** Row id = `FACTORY_SESSION`; a spawn
  gets its row when the tick claims it (`starting` until its first event; the pane is added when the Runner returns it; a
  spawn that fails for good without a pane or event takes its row with it), an `rd` name when its first event arrives. `session_started` binds
  Claude's session id, transcript path and cwd (the join key with `usage`); an older start delivered late does not
  overwrite a newer binding.
- **The witness** (`witness.ts`) asks herdr (`agent list`, Wave 1 process timeout) once a minute: records each session's
  agent status, the worktree's last change (`git log` + `git status` with `GIT_OPTIONAL_LOCKS=0`, only for an agent that
  is working), and herdr's server (pid + start time from the process table, herdr has no API for it): a change is the
  event `herdr_restarted` (filed under the pseudo-session `_herdr`). A session with a known pane that no agent matches in
  two passes in a row gets `pane_gone` (= `dead`, key per disappearance); a pass in which herdr restarted or could not be
  identified counts nobody as missing, and an agent that returns revives the session. Git runs without the server's
  secrets, `core.fsmonitor` or hooks (the agent controls `.git/config`), four probes at a time. `GET /sessions` answers
  with the newest 200. A herdr that
  does not answer records nothing.
- **Quota is a stored fact, read from the picker.** `ClaudeAccountSource` (`quota.ts`) runs `claude-account usage --json`
  (`FACTORY_CLAUDE_ACCOUNT_BIN`, default `~/.local/bin/claude-account`, the Wave 1 process timeout) and parses it with zod: one
  row per account of the registry (`dotfiles/config/claude-accounts.json`), so accounts are never listed here and a fourth
  appears when the picker lists it. The tick polls at most once a minute (a failed attempt counts; the error goes into the
  tick's `errors`, never crashes it); `factory quota refresh` / `POST /quota/refresh` polls now, `factory quota get` /
  `GET /quota` shows the newest row per account. `quota_readings` keeps every row: percent of the 5-hour window and the week
  (null = no sample), both resets, `enabled`, `auth_ok`, `exhausted_until`, `read_at`, and `sampled_at` (read time minus the
  sample's age). `PUT /quota/accounts/:account` stores a reading by hand (tests, operators); the next poll supersedes it.
  A reading not renewed for 10 minutes is stale and admits nothing (a stopped poller, an account that left the registry); the
  age of the picker's own sample is not judged, only stored. A window the picker has no number for counts as unused (as the
  picker weighs it); both without, or no sample time, is no sample and the account is closed. Rows older than a week are
  deleted, the newest of each account kept. `capacity_readings` (the previous release's table) is still fed for one release so a
  rollback finds live readings; drop it, and this sentence, in the release after. A rollback to the Wave 2 release is not
  fail-safe otherwise: it knows no holds, roles or per-sample loads, so drain by waiting for the queue to empty first.
- **Admission** (`admission.ts`, one function, used at `POST /spawns` and at every claim; first rule that says no wins):
  1. queue state `drain`: hold. 2. role `wave` while another live session (derived state not `dead`) of a `wave` spawn
  has the same repo: hold `wave` (fan workers and other roles are never limited; sessions `rd` starts count once they
  carry a role, which they do not yet; a `failed` spawn whose agent still runs, and a spawn waiting to retry its start, are live sessions: the tab is kept and the
  agent may run). 3. `pace` and any live session of the project: hold `pace`. 4. an account: enabled,
  auth fine, a sample, not `exhausted_until`, below 85 % of its 5-hour window and below 95 % of its week; under `pace` also
  weekly use at or below the elapsed share of its week. Never spills: with no account open the spawn is `waiting` with
  `resume_at` the first time any account opens by its own reading (a window's reset; both windows closed: the later one; under
  pace the moment the elapsed share reaches the use); none if no reading names a time, a new reading wakes it.
  **The spawn cost is not a number:** an account takes one new spawn per sample. A queued or starting spawn holds its account (no agent runs yet, no sample
  can show it); a started one holds it until a sample is taken after the moment it started (`assigned_at`, moved to the start;
  `sampled_at` is stamped before the picker is asked). Then the account is offered again (the poll shows it within about a
  minute). A burst starts as many spawns as there are open accounts
  and the rest wait for the next sample.
- **Queue state `run|pace|drain`** (`queue.ts`, table `queue_states`): per scope, global (`project` null) or a project (the
  repo path, resolved like a spawn's); `initiative` is a nullable column for F4, not read yet. No row is `run`. The most
  restrictive scope that applies wins. `drain` starts nothing and never interrupts; `pace` as above. A spawn held by a rule
  stays `queued` with `hold` set (`drain|pace|wave`) and no account, looked at again every 30 s (`HOLD_RECHECK_MS`), and
  `queue set` makes held and waiting spawns due at once. `factory queue get|set [--project <path>]`, `GET|PUT /queue`.
- **Roles** (`config/roles.json`, schema in `packages/contract/src/roles.ts`): role → tier (`haiku|sonnet|opus`, never a
  model id) and effort (`low|medium|high|xhigh|max`). `POST /spawns` takes `role` (default `worker`; unknown = 422, but a replay
  of a known key answers with its row) and
  stores the table's tier and effort on the row; the Runner starts Claude Code with exactly those. The server reads the file
  at boot (`FACTORY_ROLES_FILE`; it refuses to start on an unusable one), so an edit needs a deploy or restart, and a
  spawn keeps the tier and effort it was queued with. `factory role list|get <role>` reads the file
  itself, with no server and no token: `rd --role` depends on `role get <role> --format json` printing exactly
  `{"role","tier","effort"}` (exit 0; unknown role is exit 4). Values change only on measured data.
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
  adapter (`runner.ts`), derived session state (`sessions.ts`), the hooks' spool (`spool.ts`), the herdr witness
  (`witness.ts`), the queue (`spawns.ts`, `queue.ts`), admission and capacity (`admission.ts`, `capacity.ts`), the account
  picker's readings (`quota.ts`), `migrations/`.
- `packages/contract` — the zod schemas of every response, imported by the server and the CLI, and the role table's schema
  and loader (`roles.ts`); `spool.ts` is the zod-free half the hook uses (event kinds, the spool line, key and time counting).
- `config/roles.json` — the role table (FL4).
- `packages/cli` — the `factory` binary (`bin/factory.ts`): `version`, `health`, `spawn list|requeue`, `session
  list|get|wait`, `queue get|set`, `quota get|refresh`, `role list|get`, `hook <event>` (`src/hook.ts`). Exit codes are agw's table, copied in `src/exit.ts`.
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
