# Running a Factory

This factory runs on one always-on machine with Bun, Postgres, herdr-core, agw and Claude Code subscriptions. The code reaches each through a port, so the parts are replaceable. This page covers what the host needs, settings, deploy and rollback, the CLI, callers and tokens, and the trust boundary.

Four rules carry over to any host:

- Secrets resolve at runtime.
- A route with no row is shut.
- A deploy refuses to start what it cannot undo.
- Nothing here calls a model.

## What one host needs

A factory host is one machine that stays on, where the server, its loops and the lead terminals all run.

- **Bun** runs the server, the CLI and the tests. The repo pins exact versions, with a 3-day release-age cooldown on new ones.
- **Postgres** holds everything in the schema `factory`. Migrations apply at start, under an advisory lock, and are never edited once applied.
- **herdr-core** owns the terminals. A lead is an interactive Claude Code session in one, and it outlives a server restart.
- **agw** is where every judgment goes: triage, the steward, the Judge, the queue and the screens. The factory never calls a model, and no model SDK is in the repo.
- **Claude Code subscriptions** run the leads. Sessions are interactive, never headless `claude -p`.
- **One process.** A session-level Postgres advisory lock is taken first. A second copy waits 45 s for it, then exits 1.

```sh
bun install
DATABASE_URL=postgres://… PORT=7793 FACTORY_TOKEN=<owner-token> bun apps/server/src/main.ts
```

The `…` and `<owner-token>` are placeholders: substitute your own values. The owner's token needs 16 characters or more. The shipped launchers show one wiring for macOS and are not meant to be copied unchanged.

**Example files:**

- [`README.md`](https://github.com/jkrumm/software-factory/blob/master/README.md#L749-L772): "Run it", the minimum to start a server.
- [`AGENTS.md`](https://github.com/jkrumm/software-factory/blob/master/AGENTS.md#L17): the rule that the factory never calls a model.
- [`AGENTS.md`](https://github.com/jkrumm/software-factory/blob/master/AGENTS.md#L39): interactive Claude Code in herdr-core only.

## Settings

A setting is either a secret or not, and the two live in different places.

- **Secrets are refs, never values.** `.env.tpl` lists one whole-value reference per line. The launcher resolves them through a secrets shim at start and fails closed (exit 78) unless every one resolves. Server-only optional refs live in `.env.server.tpl` and the door's refs in `.env.door.tpl`.
- **Everything else is a plain file** in the user's config directory. A script allow-lists its keys: a key that is not on the list, a wrong mode or owner, a symlink or a line that is not `KEY=VALUE` refuses the start. A setting silently ignored is worse than a launch that says why it will not run.
- **Read at launch only.** An edit takes a restart.
- **A test guards the list.** A unit test fails when the server reads a setting that is on neither the allow-list nor the deliberately excluded list.

```sh
# ~/.config/factory/env (FACTORY_ENV_FILE) when it exists: KEY=VALUE lines only (blank lines and # comments allowed), the file mode
# 0600 and owned by the user, and only the keys below. Nothing in it is evaluated: a line is split at the first = and exported as it
# is. The whole file is checked before anything is exported.
```

**Example files:**

- [`.env.tpl`](https://github.com/jkrumm/software-factory/blob/master/.env.tpl#L1-L12): the secret refs, with the rule that each token differs from every other.
- [`env-file.sh`](https://github.com/jkrumm/software-factory/blob/master/scripts/env-file.sh#L1-L28): the allow-list and why a key is excluded on purpose.
- [`launch.sh`](https://github.com/jkrumm/software-factory/blob/master/scripts/launch.sh#L1-L25): the launcher, which refuses to start on an unresolved ref.

## Deploy and rollback

A deploy exports one immutable release of a commit and switches the service to it. It never writes to the live release.

- **`make deploy`, `make rollback`, `make verify`** act on the host only. `DRY_RUN=1` prints the plan and the rendered service file and touches nothing.
- **`FACTORY_REF=<branch>`** deploys that branch, the way to prove a change live before it merges.
- **Health decides.** `/health` must report the new sha. If it never does, the previous release boots again and the deploy exits 1.
- **A deploy whose commit is live restarts nothing.**
- **Migrations are dry-run first.** Every deploy runs the pending migrations in a rolled-back transaction before it stops anything.
- **Load is a gate.** Before it stops anything, a deploy waits up to 600 s for the one-minute load to fall under 8 per core, and otherwise refuses with the live service untouched. At a load of 200 or more, the release and its rollback both missed their 60 s deadline.
- **Locks fail closed.** The deploy lock is a host-local pid symlink: an unreadable one refuses the deploy, and only a dead holder is reclaimed.

`factory health get --format json`, 2026-11-17 (trimmed):

```text
{"status":"ok","version":"2511836af2e3c6f09eb0f76ded4d5e49b47003ab","reason":null,"heartbeat":{"ok":true,"reason":null,"tickAt":"2026-11-17T07:52:59.183Z","queueMovedAt":"2026-11-17T07:47:13.360Z","routeP95Ms":255,"routeSamples":4133},"lines":[],"loops":[{"name":"leads","ok":true,…}, …]}
```

**Example files:**

- [`deploy.sh`](https://github.com/jkrumm/software-factory/blob/master/scripts/deploy.sh#L1-L22): the release layout, the rollback and `DRY_RUN`.
- [`operations.md`](https://github.com/jkrumm/software-factory/blob/master/docs/operations.md#L131-L150): the deploy's variables, retries and timings.

## The CLI

The CLI is `factory`: one vocabulary for the owner, the orchestrator and every lead, generated from the server's OpenAPI document.

- **Generated, not written.** Commands come from `apps/cli/src/generated/operations.ts`, and `make check` fails when it is stale. A short list of verbs is hand-written: `hook`, `slot`, `deploy-lock`, `merge-lock`, `land`, `follow`, `retro`, `role` and the offline schema and check verbs.
- **One contract with agw.** `--format json|plain`, data on stdout, messages on stderr, and it never prompts.
- **One exit-code table.** A caller branches on the code, so a code is never added or changed in one place.
- **A body that does not parse is exit 9.** The CLI parses every response with the same zod schema the server built it from.
- **The CLI waits a restart out** for 90 s, or 10 minutes while a deploy holds its lock.
- **A role is a tier and an effort,** never a model id: `factory role get <role> --format json` prints exactly the fields `role`, `tier` and `effort`.

`factory role get lead --format json`, 2026-11-17:

```text
{"role":"lead","tier":"sonnet","effort":"high"}
```

<!-- snippet: apps/cli/src/exit.ts EXIT -->
```ts
export const EXIT = {
  ok: 0,
  general: 1,
  usage: 2,
  auth: 3,
  not_found: 4,
  conflict: 5,
  confirmation_required: 6,
  network: 7,
  rate_limited: 8,
  contract_mismatch: 9,
  pending: 10,
} as const
```

**Example files:**

- [`exit.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/cli/src/exit.ts#L5-L17): the exit codes every caller branches on.
- [`operations.md`](https://github.com/jkrumm/software-factory/blob/master/docs/operations.md#L47-L69): "The CLI", the hand-written verbs and the credential rules.

## Callers and tokens

A caller is decided by its bearer token alone. `apps/server/src/api/policy.ts` holds the one table every request is checked against.

| Caller | Token | May |
|-|-|-|
| `owner` | `FACTORY_TOKEN`, required | every route; the 9 person-only rows are the owner's alone |
| `orchestrator` | `FACTORY_ORCHESTRATOR_TOKEN` | the owner's rights bar those 9 rows, so the log tells it apart |
| `agent` | `FACTORY_AGENT_TOKEN` | a lead's verbs on its own Issue, and reads |
| `machine` | `FACTORY_DOOR_TOKEN` | `POST /signals/alerts`, `/signals/feedback` and `/door/reports` |
| `signal` | `FACTORY_SIGNAL_TOKEN` | `POST /signals`, as one narrow filer |
| `read` | `FACTORY_READ_TOKEN` | `GET /v1/*`, and never a work repo's words |

- **A caller whose token is unset does not exist.** Every token is at least 16 characters, and all of them differ.
- **A route with no row is 403 for everyone.** A new route stays shut until it has a row, and `policy.test.ts` walks the OpenAPI document and fails on one without.
- **No token or an unknown one is 401.** A known caller that the route's row does not list is also 403.
- **Only `GET /health` is public.** When in doubt, the owner alone.

<!-- snippet: apps/server/src/api/policy.ts CALLERS -->
```ts
export const CALLERS = ['owner', 'orchestrator', 'agent', 'machine', 'signal', 'read'] as const
```

**Example files:**

- [`policy.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/api/policy.ts#L1-L38): the classes, the fail-closed rule and the caller list.

## The trust boundary

The owner's and the orchestrator's tokens can start Claude Code with `--dangerously-skip-permissions`. That makes the choice of repo the security boundary.

- **A spawn's repo must be inside `FACTORY_REPO_ROOTS`** after `realpath` on both sides, so neither `..` nor a link leads out. The root itself is never a repo.
- **`FACTORY_REPO_ALLOW` admits single repos outside the roots.** A repo of another organisation is admitted by name there, never by adding the directory that holds it as a root.
- **The API is loopback only.** The Console listener is a second loopback port. It answers `GET` and `HEAD`, and 405 to every other method except its 15 write verbs. It holds the owner token in its closure.
- **Work repos hear only the owner.** The read token sees none of their text.

<!-- snippet: apps/server/src/adapters/git/repos.ts rootedRepos -->
```ts
 * `allow` admits single repos outside the roots (`FACTORY_REPO_ALLOW`): each entry is one repo's directory, matched by
 * `realpath` like a root, so the repo itself and its worktrees are in and its siblings are not. A bare name matches an
 * entry's directory name.
```

**Example files:**

- [`repos.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/adapters/git/repos.ts#L17-L47): `rootedRepos`, the check every spawn passes.
- [`AGENTS.md`](https://github.com/jkrumm/software-factory/blob/master/AGENTS.md#L52): the rule, with the Console listener's limits beside it.

## What is specific to this host

Each of these is one wiring of a part you can replace.

- **macOS LaunchAgents** run the server and the door, from release directories, with `ProcessType` Interactive so the server is not throttled below the work it controls.
- **A secrets shim over a password manager** resolves the refs, because a biometric prompt cannot be answered on a headless machine.
- **The Claude Code accounts** are read in the server's own process from `packages/accounts` (its registry and cache files): which account takes a lead, in what order and why not is that package's rule, and `claude-account` is the same code as a command.
- **A push-notification topic** pages the owner, and an uptime monitor reads the heartbeat from `/health`.
- **A shared Postgres** hosts the schema `factory` beside other databases, so the factory's role owns that schema and no more.
- **The capacity numbers** (load per core, test slots, the shutdown deadline) are settings tuned to this one machine, not constants.

**Read more:**

- [`docs/operations.md`](https://github.com/jkrumm/software-factory/blob/master/docs/operations.md#L1-L6): the listener, the CLI, the gate, the merge window and the deploy.
- [`docs/architecture.md`](https://github.com/jkrumm/software-factory/blob/master/docs/architecture.md#loops-and-agw): loops and agw, the clock and the call record.
- [`README.md`](https://github.com/jkrumm/software-factory/blob/master/README.md#L749-L772): the minimum to run a server.
