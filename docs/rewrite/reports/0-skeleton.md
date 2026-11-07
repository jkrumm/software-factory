# Package 0: Skeleton, report

**Done: the new core's empty shape builds, boots on Postgres and passes `make check` with every step the brief names;
`rd --role lead` resolves through the new CLI.** Branch `rw/0-skeleton`, eleven commits on `098b086` (the brief's base), this report the last.

## What changed

- **`legacy/`**: `git mv packages legacy`, pure renames. Outside the workspace, `tsconfig.json`, oxfmt, oxlint, the tests
  and the retired-word scan. `scripts/{deploy,verify,version,launch*,env-file}.sh` are untouched and still pass shellcheck.
- **Root**: workspaces `apps/*`, `packages/*`, `tests`. Pins: `elysia` 1.4.30, `@elysiajs/openapi` 1.4.17 (published
  2026-11-04 03:49 UTC, so it clears the 72 h cooldown), `@elysiajs/eden` 1.4.9, `zod` 4.6.7, `oxlint` 1.91.0, `oxfmt`
  0.76.0, `oxlint-tsgolint` 7.0.2005 (7.0.2006 is inside the cooldown), `typescript` 7.0.2, `@types/bun` 1.4.4. No `^` or `~`.
- **`packages/contract`**: `Health` (`status`, `version`, `reason`, `heartbeat: {ok, reason, tickAt, queueMovedAt}`),
  `ErrorBody` (`error`, `code`), the role schemas and `parseRoleTable`. Every schema an operation answers with carries
  `.meta({ id })`, which is how the generator finds it again.
- **`apps/server`**:
  - `adapters/postgres/`: the connection and the ping, `locks.ts` (every advisory key, the old core's values),
    `process-lock.ts` (session-level lock, a 45 s wait, a watchdog) and `migrate.ts`. The migration runner takes a
    transaction-level advisory lock and stores a sha256 per migration. It refuses an edited, missing or out-of-order
    migration, and the old core's ledger. It runs every migration with `search_path` set to `''`, so a name without
    `factory.` fails. `migrations/0001_schema.sql` only comments the schema: the runner creates the schema because its
    ledger lives in it.
  - `api/app.ts`: the Elysia app, OpenAPI through `mapJsonSchema: { zod: z.toJSONSchema }` at `/openapi/json`, and every
    failure as an `ErrorBody` (`not_found`, `unparseable`, `invalid_request`, `invalid_response`, `internal`).
    `api/health.ts`: `GET /health`, operationId `health.get`, 200 or 503 in the same shape. `read/health.ts` builds it.
  - `settings.ts` reads `DATABASE_URL`, `PORT`, `FACTORY_VERSION` and `FACTORY_LOCK_WAIT_MS`. `main.ts` takes the lock,
    then migrates, then listens on 127.0.0.1. A second copy exits 1; SIGTERM releases the lock.
  - Folders with code: `adapters/`, `api/`, `read/`. `kernel/`, `domains/` and `app/` do not exist yet.
- **`packages/client`**: `send()`, the CLI's transport, which never throws for the network or the status. `eden.ts` has
  `consoleClient` and `inProcessClient` (Eden over `App`, a type-only import from `@software-factory/server/app`).
- **`apps/cli`**: `scripts/generate.ts` builds the document in-process, checks each operation and writes
  `src/generated/operations.ts`, formatted through oxfmt. Its checks: operationId `<group>.<verb>`; every answer a contract
  schema with an id; no group a hand-written verb owns; no query parameter named `format`, `help` or `body`; no duplicate
  command. `--check` exits 1 when the file is stale (tried both ways). `src/operation.ts` runs a generated command:
  path parameters are positionals, query parameters are flags, the body is `--body <json>`. A 2xx body that does not
  parse is exit 9. A declared non-2xx body (the 503 health) prints, then exits with its kind. `exit.ts` is the old table
  verbatim. `run.ts` holds the hand-written `version` and `role get|list`.
- **`scripts/`**: `boundaries.ts` and `retired-words.ts`, each with fixture tests in `scripts/test/`.
  `retired-words.allow` holds one exception per file and term, each with a reason. A stale line fails the check.
- **`tests/`**: `support/pg.ts` is the private cluster, ported from the old helper. `scenarios/harness.ts` starts the real
  server process with fake `hc` and `agw` first on PATH (`fakes/*.ts` record each call and fail loudly until a package
  fills them). `scenarios/boot.test.ts` is the one scenario.
- **`Makefile`, CI, `AGENTS.md`, `REVIEW.md`**: `make check` gains the boundaries, retired-word, generated-CLI and
  scenario steps. `make test` runs units, then scenarios, each through the installed `factory slot run` when it exists.
  CI also runs on pushes to `rewrite`. AGENTS.md gets the one paragraph. REVIEW.md: `legacy/**` is tier none, and the new
  migrations, `adapters/postgres/**` and `main.ts` are sensitive (a review finding).

## `make check`

```
==> install (bun install --frozen-lockfile)
Checked 44 installs across 100 packages (no changes) [11.00ms]
==> format (oxfmt --check)
All matched files use the correct format.
Finished in 12ms on 55 files using 12 threads.
==> lint (oxlint --type-aware)
==> shellcheck
==> typecheck (tsc --noEmit)
==> boundaries (scripts/boundaries.ts)
boundaries hold
==> retired words (scripts/retired-words.ts)
no retired words
==> generated CLI is current (apps/cli/scripts/generate.ts --check)
==> unit tests (bun test apps packages scripts)
 83 pass
 0 fail
 160 expect() calls
Ran 83 tests across 8 files. [1.83s]
==> scenarios (bun test tests)
 6 pass
 0 fail
 19 expect() calls
Ran 6 tests across 1 file. [2.98s]
==> check passed
```

Scenarios: the server boots on Postgres and `/health` parses as `Health` with null `tickAt` and `queueMovedAt`; `factory
health get` reads it; `factory version` and `factory role get lead` keep their contract (unknown role exit 4); a second
copy with a 1.5 s wait exits 1 after at least 1.5 s while the first stays healthy; a stopped server frees the lock and
the next copy boots; booting called neither `hc` nor `agw`. The 45 s default is asserted in a unit test.

Fixtures: 11 boundary rules and 19 retired terms, each with a failing and a passing fixture, plus the exception-file
rules (no reason, unknown term, stale line).

OpenAPI: `apps/server/test/api.test.ts` parses the document with a zod schema of the OpenAPI 3 parts the generator
uses (`openapi` 3.x.y, `info`, `paths`, operations with `responses`). It asserts that `/health` `get` has operationId
`health.get` and that 200 and 503 `$ref` `#/$defs/Health`. A test also asserts that a response mismatch is 422 with code
`invalid_response`.

Byte-compare with the installed old CLI (`bun apps/cli/bin/factory.ts` against `factory`, stdout, stderr and exit):

```
same  exit 0  factory version
same  exit 0  factory version --format plain
same  exit 0  factory role get lead
same  exit 0  factory role get lead --format json
same  exit 0  factory role list
same  exit 0  factory role list --format plain
same  exit 0  factory role get lead --format plain
same  exit 4  factory role get nope
same  exit 2  factory role get
```

## `rd` evidence

`rd_role_resolve` runs `host_run "PATH=\"$HOME/.local/bin:...:$PATH\"; ... factory role get '<role>' --format json"`.
Inside `rd`, `$HOME/.local/bin` comes first on PATH, so a shim placed only on PATH loses to the installed CLI. The proof
therefore uses a scratch HOME: every entry is a symlink to the real one, except `.local/bin/factory`, a shim that runs
`bun <worktree>/apps/cli/bin/factory.ts` and logs each call.

```
$ HOME=$FH RD_DRY_RUN=1 bash -x remote-dev.sh work software-factory --role lead 2>&1 | grep -E "ROLE_TIER=|ROLE_EFFORT=|SPAWN_MODEL=|SPAWN_EFFORT=|unavailable|would start"
+ ROLE_TIER=sonnet
+ ROLE_EFFORT=high
+ SPAWN_MODEL=sonnet
+ SPAWN_EFFORT=high
would start claude 'software-factory' in a new tab of the space for /tmp/rd-home.n73J/SourceRoot/software-factory  [picked=iu reason=home stale=false]
--- shim log
shim ran: bun apps/cli/bin/factory.ts role get lead --format json -> exit 0: {"role":"lead","tier":"sonnet","effort":"high"}

$ HOME=$FH RD_DRY_RUN=1 rd work software-factory --role lead; echo "exit $?"
would start claude 'software-factory' in a new tab of the space for /tmp/rd-home.n73J/SourceRoot/software-factory  [picked=iu reason=home stale=false]
exit 0

$ HOME=$FH RD_DRY_RUN=1 rd work software-factory --role nobody; echo "exit $?"
error: unknown role 'nobody' — see factory role list (lead|implementer|verifier|reviewer|Explore)
exit 2
shim ran: bun apps/cli/bin/factory.ts role get nobody --format json -> exit 4:
```

No "unavailable" line in either run.

## Review outcome

`/review` deep, scope `098b086..HEAD`, job `rv_pqb3nw62aua4yoxo576z`, round 1: **clean**, 0 important, 3 nits. All three
were fixed in `bea0864`:

| Finding | Disposition |
|-|-|
| REVIEW.md sensitive globs still named `packages/server/...`; AGENTS.md's `make check` sentence is stale | REVIEW.md fixed. AGENTS.md sentence left as it was (brief item 14 allows one paragraph): open point 1 |
| The scenario harness could read `output()` before its drain loops finished | `exited()` and `stop()` await both drains |
| A query parameter named `format`, `help` or `body` would share a CLI flag | The generator rejects it; failing fixture added |

The first submission was refused because the reply's file list left out the `legacy/` renames and `bun.lock`. The
reviewer resent it with the full list (attempt 2), and the findings did not change. A first prepare against
`rewrite..HEAD` diffed against the orchestrator's newer commits on `rewrite`; it was cancelled and run again from the
merge base.

## Open points

1. **AGENTS.md is now partly wrong, and the brief forbids fixing it here.** §Validate and ship still lists the old `make
   check` steps, and the rules name `src/exit.ts`, `src/locks.ts` and `packages/door`. The orchestrator should allow a
   `docs:` commit, or leave it to package 9.
2. **The brief's in-process URL is a trap:** `app.handle(new Request('http://x/openapi/json'))` answers 404 for every
   route. Elysia looks for the path at a fixed offset, and `http://x/` is too short. Use `http://localhost/...` (done
   everywhere, with a comment in `api.test.ts`). Worth a line in `docs/rewrite/learnings.md`.
3. **Bun's SQL client ignores a unix socket in a URL** (`?host=/dir` silently connected to the default port). The test
   cluster therefore listens on 127.0.0.1 with a random port and a random scram password. Production `DATABASE_URL` must
   be TCP.
4. **Advisory keys are the old core's** (`7_093_001` migration, `7_093_003` process). An old and a new server on one
   database exclude each other instead of both running. The runner also refuses the old ledger (`factory.schema_migrations`
   without `checksum`), so package 9 must rename the old schema to `factory_legacy` before the first start, as
   `learnings.md` plans. New migration names have four digits and cannot collide with the old three-digit ones.
5. **Health without a tick:** `status` and `heartbeat.ok` are true when the database answers; `tickAt` and `queueMovedAt`
   are null. The package that brings the tick must add tick staleness (the old core reported "no tick has succeeded
   yet"). The `heartbeat` object stays nested because the pusher reads `.heartbeat.ok`, `.heartbeat.reason`,
   `.heartbeat.tickAt` and `.heartbeat.queueMovedAt`. `status` and `version` stay because `scripts/verify.sh` reads
   `version`.
6. **A server answer the contract refuses is 422 with `invalid_response`,** which the CLI maps to usage, exit 2 (agw's
   422). That code describes a server bug badly; package 8 may want 500 for it. The test pins today's 422.
7. **The generated health verb is `factory health get`;** the old `factory health` has no counterpart until package 8.
   The operationId convention is `<group>.<verb>`, and the generator enforces it.
8. **The boundary rules as implemented:** `kernel` imports only `kernel`. A domain imports only `kernel` and its own
   folder, and does no I/O: no `elysia`, `@elysiajs/*`, `bun`, `bun:*`, `postgres`, `pg`, fs, net, child_process, os,
   `fetch`, or `Bun.*` beyond hash, deepEquals, escapeHTML, stringWidth and CryptoHasher. Only `app/` imports from more
   than one domain. **`read/` imports only `import type` from domains, nothing from `app/`, and holds no SQL that writes**:
   my reading of "no domain code that writes". "Only `app/` opens a transaction" is not checked yet, because the
   migration runner in `adapters/` opens one; package 1 should decide how to scope it.
9. **The retired-word list leaves out** request, item, task, track, worker, document, question, ask and hold, as the
   brief says. Tool names are a screen rule. `classify` and `dedup` are retired, after the Triage row. Exceptions: the
   old `scripts/env-file.sh` (`FACTORY_ASK_JUDGE`) and four `scripts/gameday/f2` files, for package 9, plus the script's
   own list and its fixtures.
10. **`FACTORY_LOCK_WAIT_MS` is a new server setting,** used only by the scenarios. It is not in `scripts/env-file.sh`'s
    allow-list (package 9).
11. **`rd` prepends `$HOME/.local/bin`** (see the evidence above): the cutover must install the new CLI at
    `~/.local/bin/factory`, because a PATH shim alone is never seen by `rd`.
12. **oxlint 1.91 rejects `await expect(promise).rejects…`** (`await-thenable`, from bun-types). The new tests use a
    small `rejection()` helper instead; `legacy/` has the old pattern.
13. **The deploy scripts still point at `packages/server` and `packages/cli`:** `make deploy` from this branch would fail
    until package 9 rewrites them, as planned.
14. **Package direction:** `packages/client` and `apps/cli` depend on `@software-factory/server` for development only
    (Eden's `App` type, the generator). Nothing imports `apps/` at run time from `packages/`.
