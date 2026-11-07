# Package 0: Skeleton

**Build the empty shape of the new core: the `apps/` and `packages/` layout, an Elysia server that boots on Postgres,
the contract that becomes the OpenAPI document, a CLI generated from it with `version`, `role get` and `role list`,
and a `make check` that enforces the architecture from the first commit.** No domain logic: package 1 starts the
kernel and the Issue machine on top of this.

You are the worker for package 0 of the rewrite (`docs/rewrite.md`). You work in this worktree on branch
`rw/0-skeleton`, made from `rewrite`. You commit on your branch and never merge into `rewrite`; the orchestrator
integrates.

## Read first

`docs/rewrite.md`, `docs/architecture.md` (the target: layout, server folders, boundary rules, API/CLI, tests),
`docs/language.md` (the words; use them in every name), `AGENTS.md` (the rules that still hold: exact pins, the
3-day release-age cooldown, the CLI contract, the role contract, public repo, no model SDK).

## Calls already made (do not reopen)

1. **The old core moves to `legacy/`.** `git mv packages legacy` so the old code sits at `legacy/{cli,contract,door,server}`,
   readable as the reference the later packages port from. It leaves the workspace, the root `tsconfig.json`, oxfmt,
   oxlint, the tests and the retired-word check. It does not have to build. Package 9 deletes it. Leave
   `scripts/deploy.sh`, `verify.sh`, `version.sh`, `launch*.sh` and `env-file.sh` as they are (package 9 rewrites them);
   they keep passing shellcheck.
2. **New layout** as `docs/architecture.md` §Layout: `apps/server`, `apps/cli`, `packages/contract`, `packages/client`,
   `tests/scenarios`. Not yet: `apps/door` (package 2), `apps/console` and `tests/e2e` (after the cutover). Workspace
   names `@software-factory/<name>`.
3. **Server folders** as §The server (`kernel/`, `domains/`, `app/`, `adapters/`, `api/`, `read/`). Create only what holds
   code now; the boundary script must work on folders that do not exist yet.
4. **Postgres foundation belongs here**, because the scenario harness needs a real server on a real database: a
   connection adapter, a migration runner for schema `factory` (advisory-locked, every name qualified, migrations never
   edited once applied, expand then contract; port the idea from `legacy/server`, not the files), the session-level
   advisory process lock taken first (a second copy waits 45 s, then exits 1; all advisory keys in one file), and the
   private test cluster (`initdb` in a temp dir, `PG_BIN_DIR` when not on PATH; port `legacy/server/test/support/pg.ts`).
   The first migration may create the schema and nothing else. No `Result`, ids, clock or events: those are package 1.
5. **Versions:** the newest release of each package that clears the 3-day cooldown in `~/.bunfig.toml` (on
   2026-11-07: `elysia` 1.4.30, not 1.4.31; `@elysiajs/openapi` 1.4.17 if it clears, else 1.4.16; `@elysiajs/eden`
   1.4.9; `zod` 4.6.7; oxlint, oxfmt and oxlint-tsgolint at the newest that clear, never below what `package.json`
   pins now; `typescript` 7.0.2; `@types/bun` 1.4.4). Exact pins, no `^` or `~`.
6. **Elysia and zod:** zod 4 through Standard Schema; the OpenAPI document needs
   `openapi({ mapJsonSchema: { zod: z.toJSONSchema } })` (`import * as z from 'zod'`). The spec is served at
   `/openapi/json` and is read in-process with `app.handle(new Request('http://x/openapi/json'))`, no port.
   Known traps, from research on 2026-11-07: a zod response schema on 204 fails (use 200 with a body); a zod response
   mismatch answers 422 in 1.4 (assert the status in a test so an upgrade that changes it is caught); `z.custom` breaks
   the spec; Eden infers from zod's output type, so avoid `default`/`transform` on request schemas.
7. **The generated CLI:** a generator (`apps/cli/scripts/generate.ts` or similar) builds the OpenAPI document
   in-process and writes one command per operation into a committed file under `apps/cli/src/`. `make check` fails when
   the committed file is stale. Names: operationId to `factory <group> <verb>`. The contract stays agw's: `--format
   json|plain`, data on stdout, messages on stderr, exit codes ported from `legacy/cli/src/exit.ts`, never a prompt, a
   body that does not parse with the contract's schema is exit 9. Hand-written verbs sit beside the generated ones:
   `version` (same output as the old CLI: `{"version"}` in json, the bare version in plain) and `role get <role>` /
   `role list`, which read `config/roles.json` (or `FACTORY_ROLES_FILE`) without a server or token. `role get` prints
   exactly `{"role","tier","effort"}`; an unknown role is exit 4. Byte-compare against the old CLI's output.
8. **Health:** `GET /health` keeps the heartbeat names `ok`, `reason`, `tickAt`, `queueMovedAt` (a pusher outside this
   repo reads them), built through a contract schema. With no tick yet, `tickAt` and `queueMovedAt` are null.
9. **The boundary script** (`scripts/boundaries.ts`, in `make check`) enforces §The server's rules that are checkable by
   import graph: `kernel` imports nothing of the server; `domains/<d>` imports only `kernel` and `domains/<d>`; no
   domain imports `elysia`, `postgres`/SQL clients, `node:fs`, `Bun.*` I/O or any adapter; only `app/` may import from
   more than one domain; `read/` imports no domain code that writes. Add rules as they become checkable; each rule has a
   failing fixture test.
10. **The retired-word check** (`scripts/retired-words.ts`, in `make check`) scans `apps/`, `packages/`, `tests/` and
    `scripts/` (not `docs/`, not `legacy/`; `docs/design.md` describes the old core until the cutover) for the words in
    the Retires cells of `docs/language.md`, whole word, case-insensitive, in identifiers, strings and comments. Keep the
    list in the script with one line per word naming its replacement. Generic English that collides with code (task,
    item, document, question, track, worker, hold) is checked only in the factory sense you can match precisely (for
    example `mother`, `wave`, `park`, `manifest`, `scorer`, `babysitter`, `zero-touch`, `taste gate`, `light review`,
    `decision card`, `ask judge`, `ticket`), or through an exception file with a reason per line. Bare `hold` stays out:
    triage outcome `held` and the memory hold are live words. Failing fixture tests.
11. **The scenario harness** (`tests/scenarios`): starts the real server process on the private cluster with fake hc and
    agw seams (stubs are enough now: a fake is a file the later packages fill), and runs the generated CLI against it.
    One scenario now: the server boots, `/health` answers through the contract, `factory version` and `factory role get
    lead` behave as the contract says, and a second server copy on the same database waits, then exits 1. `make check`
    runs it.
12. **`make check`:** frozen install, `oxfmt --check`, `oxlint --type-aware` over the new code, shellcheck, `tsc --noEmit`,
    the boundary script, the retired-word check, the generated-CLI staleness check, `bun test` (units), the scenarios.
    `make test` keeps going through the installed `factory slot run` when it exists (that is the running old CLI; fine).
    Keep `make fmt`, `deploy`, `rollback`, `verify`, `version` targets working as today (they still call the old scripts).
13. **CI:** `.github/workflows/ci.yml` also runs on pushes to `rewrite`. Public repo: hosted runner stays.
14. **AGENTS.md:** add one short paragraph saying that on the `rewrite` branch `legacy/` is the old core kept as a
    read-only reference, the new core is `apps/` and `packages/`, and `docs/architecture.md` is the target. Change
    nothing else in it.

## Acceptance

- `make check` green on the empty server, with the output in your report.
- `rd --role lead` reads the new CLI: with a PATH shim named `factory` that runs `bun apps/cli/<entry>`,
  `RD_DRY_RUN=1 rd --role lead ...` (find the exact form in `~/SourceRoot/dotfiles/scripts/remote-dev.sh`) resolves the
  role's tier and effort and prints no "unavailable" line. Paste the output.
- Every boundary and retired-word rule has a failing fixture and a passing one.
- The OpenAPI document parses as OpenAPI 3 and holds `/health` with its response schema.
- `tsc` strict with the root config's flags; no `any`, no non-null assertions, no ts-comments.

## Out of scope

Result, ids, clock, keys, events, the state machine (package 1). Any domain. Hooks, socket, spool, slots, the door's
behaviour (packages 2 to 4). Auth beyond what boots (package 8). The Console and Playwright. Deploy scripts (package 9).
Do not edit `docs/architecture.md`, `docs/language.md`, `docs/rewrite.md`, `docs/decisions.md`: if the target is wrong
or contradicts itself, say so in your report's open points.

## Finish

1. Commit in logical conventional commits on `rw/0-skeleton`, no AI attribution.
2. `make check` green.
3. `/review` your range (`rewrite..HEAD`) once, deep. Fix what it finds that is real; note what you declined and why.
4. Write `docs/rewrite/reports/0-skeleton.md` and commit it: **what changed** (by folder, a few lines each), **`make check`
   output** (the tail that shows every step passed), **the `rd` evidence**, **review outcome** (findings, fixed, declined),
   **open points** (anything the next packages or the orchestrator must know, contradictions in the docs).
5. Say `REPORT READY` as the last line of your final message and stop. Questions to the orchestrator: write them as open
   points in the report and take the reversible default meanwhile; do not wait for an answer.
