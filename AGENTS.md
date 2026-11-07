# software-factory

The lifecycle server for agent-built software: it takes in signals and requests, merges duplicates, queues
work against the available Claude Code subscriptions, starts interactive Claude Code sessions in herdr-core terminals that
own a piece of work from root cause to production evidence, follows them through hooks, and closes and
learns. CLI `factory`. Status: live on the mini; `docs/program.md` is the current state.

**Start here:** `docs/decisions.md` (what was decided and why) → `docs/program.md` (tracks, who runs them) →
`docs/design.md` (the design and, in §3 "As built" and §11, the behaviour) → `docs/research/` → `docs/evidence/`.
A directory listing, `package.json`, the Makefile and `--help` say what exists; this file says what they cannot.

## Rules

- **Public repo.** No secrets, hostnames, IPs, tailnet names, internal URLs or account e-mails in any tracked
  file. Placeholders: `<your-domain>`, `<see-1password>`. Secrets resolve at runtime through `secrets-run`.
- **The factory never calls a model.** Every judgment (classify, dedup, wording, learnings) is an `agw`
  workflow; the factory calls `agw` like any other client. No model SDK in this repo.
- **Dependencies point one way:** factory → agw, herdr-core, GitHub, the intake sources. Nothing here is imported
  by agent-workflows.
- **Facts are stored, state is derived.** "Working", "stuck", "waiting" are computed from events when read; a count
  or a timer that can be read from `issue_events` is never a column.
- **Every effect has a deterministic key** (pane names, prompt ids, comment markers, inbox keys), so a replayed tick
  never spawns, prompts or posts twice. The Runner looks before it acts: a terminal carries `factory.key=<spawn key>`.
- **Interactive Claude Code in herdr-core only.** Never headless `claude -p`.
- **CLI contract = agw's:** `--format json|plain`, data on stdout, messages on stderr, the same exit codes
  (`src/exit.ts`), never prompts. `rd --role` depends on `factory role get <role> --format json` printing exactly
  `{"role","tier","effort"}`; unknown is exit 4. A role is a tier (`haiku|sonnet|opus`, never a model id) and an effort; role values change only on measured data.
  The table governs the terminals the factory spawns (the lead, `spawn create`, `rd --role`). A lead's in-session
  subagents take model and effort from the global agent files in dotfiles (`agents/*.md`), and the reviewer's seat
  comes from `agw review prepare`. The Explore and verifier rows state what those agent files run; the implementer row
  (Sonnet/high) applies to `spawn create` and `rd --role` only, a lead's `@implementer` runs Sonnet/medium.
- **Tooling:** Bun, TypeScript strict, zod at boundaries, exact pins (no `^`/`~`; `~/.bunfig.toml` enforces a 3-day
  release-age cooldown, never exclude a package from it). oxlint and oxfmt, no Biome. No Effect: the F0 spike decided
  that (`docs/spikes/2026-10-30-effect/verdict.md`).
- **Never call a port inside a transaction.** The tick claims a row and commits, calls the port (`Runner`, `Notifier`,
  `agw`; every call has a process timeout), records the result in a new transaction. `git` and `make verify` never run on the
  tick either (`issues/offtick.ts`). Admission is decided again at every claim.
- **Trust boundary.** The token can start Claude Code with `--dangerously-skip-permissions`: a spawn's `repo` and `space`
  must be inside `FACTORY_REPO_ROOTS` after `realpath`, else 422 and nothing stored. The API is loopback only; the tailnet and the
  owner's GitHub user are the perimeter. `FACTORY_REF=<branch>` deploys that branch, the same boundary.
- **Visible (IuRoot) text never leaves the machine's token API.** `scopeOf` is the one place that decides what is `visible`;
  nothing of a visible repo or session goes to `agw`, the socket or the read token, and the morning message counts it only. Changing the fleet
  view, the digest or the read API: `docs/design.md` §11 "The fleet view", "The read API", "The read token".
- **The door** (`packages/door`) holds no factory token and no database credential, binds loopback, posts to the socket's
  `POST /intake`, and takes the repo from `factory.door_routes`, never the payload. Changing alert intake: `docs/design.md` §11 "The factory door".
- **Hooks: spool first, then post.** `factory hook <event>` does nothing without `FACTORY_SESSION`, appends to the spool,
  posts to the unix socket and exits 0 whatever happens (one exception: the Stop send-back, exit 2). `src/hook.ts` imports only
  `node:fs` and `@software-factory/contract/spool` and keeps **stdout empty for every event** (and stderr, except a send-back):
  Claude Code injects a hook's stdout into the session's context. The one exception is a `session-start` with `source: compact`
  in an Issue lead's session: one line telling it to re-read the Issue. The socket (mode 0600) is the hook's credential.
- **One process.** A session-level Postgres advisory lock is taken first; a second copy waits 45 s, then exits 1. Every
  advisory key lives in `src/locks.ts` and they stay distinct.
- **One contract.** Response shapes are zod schemas in `packages/contract`; the server builds every body through its schema and
  the CLI parses with the same one (a body that does not parse is exit 9).
- **One schema, `factory`,** in the shared database; migrations are advisory-locked, qualify every name, are expand then
  contract, and are never edited once applied. `DATABASE_URL` comes from `secrets-run`, never a tracked file.
- **The API is authenticated.** Every route but `GET /health` needs a bearer token; the read token passes on `GET /v1/*` only.
  `/fleet`, `/v1` and the model text are token API only, the socket answers 404. The CLI runs under `secrets-run run --env-file=.env.tpl --`.
- **Settings:** secrets in `.env.tpl`; non-secret settings in `~/.config/factory/env`, which `scripts/env-file.sh` allow-lists
  (a key not on its list refuses the start; its retired keys stay listed so an old file still launches). Read at launch: an edit takes a restart.
- **Heartbeat names** on `GET /health` (`ok`, `reason`, `tickAt`, `queueMovedAt`) are read by a pusher outside this repo: do not rename them.

## Where the detail lives

Read the section before you change the branch it describes:

- Tick, spaces, runner, hooks and socket, prompts, rules that act, spool, derived state, witness, test slots, quota, roles:
  `docs/design.md` §3 "As built".
- Admission, the lead cap, the load ceiling, the memory hold, holds: §3 "Admission" and §4. Issue states, who writes `issues.state`
  (only `issues/lifecycle.ts`; a create is `create.ts`), parks and how every park ends (RS3), the hold and its checkout sync,
  evidence and review coverage (agw's, fails closed), dependencies and `prio`, `issue_facts`: §4.
- The steward, the ask judge, the plan file (`docs/plan.yaml`): §4 "The steward", "The ask judge", "The plan files its next Issue".
- Intake (signals, fingerprints, heal and settle, stop the line, GitHub, checks, launchd, Beszel): §8 "Intake: work comes in by itself".
- Projects and the manifest: §9. Asks versus health lines, the owner's line (ntfy, the outbox, the fold rule, the morning message), the door, the fleet view, the digest, the read API: §11.
- Why a rule exists: `docs/decisions.md`.

## Validate and ship

`make check` runs install (frozen), oxfmt check, oxlint (type-aware), shellcheck, `tsc --noEmit` and `bun test`; `make fmt` formats.
The tests start a private Postgres cluster with `initdb` (on PATH, or `PG_BIN_DIR`); nothing touches a real database. `make test` goes
through `factory slot run` when `factory` is installed: a lease on the host's test slots, a wait past 45 min exits 75 without running.
`make deploy`, `make rollback` and `make verify` act on the mini only; `DRY_RUN=1` prints the plan, `FACTORY_REF=<branch>` proves a branch
live before it is merged. CI runs `make check` on `ubuntu-latest`.

Direct-to-master, conventional commits, no AI attribution. Update this file in the same commit as the code it describes, and keep it
to what lookup cannot reveal: a detail that is in the code or in `docs/design.md` is deleted here.
