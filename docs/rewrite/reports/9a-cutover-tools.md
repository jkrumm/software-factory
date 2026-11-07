# Package 9a: the cutover's tools, report

**Permissions check first: the `factory` role cannot rename its schema or create a new `factory` in `shared`. It owns schema `factory` (`has_schema_privilege(…, 'CREATE')` true) but holds no `CREATE` on the database (`has_database_privilege(current_user, 'shared', 'CREATE')` false; not superuser, createdb or createrole).** `ALTER SCHEMA … RENAME` needs both ownership and `CREATE` on the database, and `CREATE SCHEMA` needs the latter. The rehearsal proves it on a cluster with the same role shape: `permission denied for database shared`. Read-only queries on live (`pg_namespace`, `has_*_privilege`, a schema-only and a data `pg_dump` of `factory`, `SELECT`s) were all I did there.

The orchestrator's answer (message of the session): no standing grant. The rename and the new empty schema are the database admin's step: `ALTER SCHEMA factory RENAME TO factory_legacy; CREATE SCHEMA factory AUTHORIZATION factory;` as the superuser in the `postgres` container, through vps's own path (`cd ~/SourceRoot/vps && secrets-run run --env-file=.env.dev.tpl -- sh -c 'docker exec -i postgres psql -X -U "$POSTGRES_USER" -d shared -v ON_ERROR_STOP=1'`, the shape `scripts/setup-shared-db.sh`'s `psql_su` uses). The four SQL files of every schema move are in `scripts/cutover/` and are the files both the runbook and the rehearsal run. Nothing in `~/SourceRoot/vps` changed. (What `make db-shared` would need instead, for the record: `scripts/setup-shared-db.sh` line `DB_CREATE_WRITERS=(argo)` becomes `(argo factory)`, then `make db-shared`. Not done, by decision.)

Branch `rw/9a-cutover-tools` on `c109dd1`; `make check` green (output below). Live was read-only throughout.

## What changed

- **`apps/server/scripts/import-legacy.ts`, `import/plan.ts`, `import/run.ts`, `migrations/0900_import.sql`**: the import and the comparison, a script rather than a verb (it needs the database credential, not the API, and has to run before the new core serves). `plan.ts` is pure: the old Issue's rows go in, the new events come out, **each decided by the new machine itself at the time the old event happened** (`apply(issue, event, { now: event.at })`), so the derived state is the machine's, not a copy. `run.ts` reads `factory_legacy` (only `SELECT`s name it) and writes `factory` in one transaction per Issue, through the real work store. `0900_import.sql` is the ledger: `import_issues` (old id, last old event carried, the version the import left) and `import_events` (what became of every old event: `mapped`, `folded` into another table, `dropped` with the reason, plus the keys of the new events). Idempotent by keys and the ledger: a second run changes nothing; a later run **appends** only what the old core recorded since; an Issue the new core has worked since (`version` moved) with new old events is reported `diverged` and left alone; a number the new core took is a `conflict`.
- **`scripts/rehearse.ts`, `scripts/cutover/*.sql`, `tests/scenarios/cutover/`, `harness.ts` (`startWorldOn`)**: the rehearsal harness (`make rehearse`). Read-only `pg_dump` of live, restore into a private cluster with the production shape (an admin superuser, the `factory` role with no `CREATE`), the admin step, a boot of the new core **through `scripts/launch.sh`** with a fake `secrets-run` and a settings file of a paused start, import, import again, compare, the scenarios on the imported data, the way back (master's release exported, installed and booted on the restored old schema), and the next window (the new schema forward again, the import carries on). One summary; exit 1 on any failed step. The copy is deleted at the end (`--keep` leaves it).
- **Deploy for the new core** (`scripts/deploy.sh`, `verify.sh`, `version.sh` unchanged, `launch.sh`, `launch-door.sh`, `deploy/*.plist.template`, `.env.door.tpl`, `scripts/import.sh`, `scripts/env-file.sh`, `.env.tpl`, `Makefile`): `deploy.sh` asks each release which core it holds (`core_of`, `cli_of`), so the one script deploys `apps/server`, `apps/door` and `apps/cli` and `make rollback` returns to the old core's release (`packages/*`); both print which core they start and return to. The CLI lands at `~/.local/bin/factory`. A settings file the target launcher would refuse is caught **before anything is stopped** (`env_file_ok`), for a deploy and for a rollback: the old launcher exits 78 on a key it does not know, which would loop under KeepAlive. The door has its own template and now holds exactly one secret, `FACTORY_DOOR_TOKEN`. `.env.tpl` has `FACTORY_AGENT_TOKEN` and `FACTORY_DOOR_TOKEN` (both resolve through `secrets-run`; the orchestrator created them). `scripts/import.sh` runs the importer from the deployed release. `make rehearse` is the new target.
- **`scripts/env-file.sh`**: the allow-list holds every setting the reports name and every setting the server reads (a unit test, `scripts/test/env-file.test.ts`, fails when the server reads one that is on neither the list nor a named "never" list), and the retired keys, including `FACTORY_CHECKPOINT_PASS_MS`, stay listed.
- **`scripts/gameday/`**: the old core's game days drilled spawns, sessions, prompts and the old tables. They are gone (`run.sh`, `collect.sh`, `when-*.sh`, `f2/`), and one drill for the new core replaces them: `setup.sh`, `scratch.sh [--kill-server]` (one scratch Issue from filing to close, read only through `read issue`; green when it closes `done` with its commit on the scratch remote), `kill-server.sh`, `teardown.sh`, `lib.sh`. `verify.sh` calls `capacity get` and `GET /v1/overview` (401 without a token) instead of `spawn list` and `/spawns`.
- **`docs/rewrite/cutover-runbook.md`**: every step of a window in order, each with its command, how to tell it worked and the undo: preflight, closing the old core (drain, wait, stop), the schema moves, the paused start, the import (what it carries and leaves), unpause and narrowing to named repos, the watch list as a table, the end of a window, the way back, later windows, the one-time steps. **`docs/rewrite/client-patches/`**: `iris.patch`, `hermes-agent.patch`, `dotfiles.patch`, each `git apply --check` clean against the client's repo today and revertible with `git apply -R`.
- **`docs/language.md`**: the words of reports 1 to 8 in the tables they belong to (state, outcome, event, triage outcome with its detail words, promote, door route, work repo, queue state, queue reason, claim, owed, window, line, session state, delivery, defer, pass, round, settler, decision status, revision, annotation, page, needs, ship refused, review status, caller, flow, change and cursor) and a table of the 21 events with who sends them. The generated Issue block is untouched (`make check` still verifies it).
- **Tests**: `apps/server/test/import/plan.test.ts` (10: the pure plan on synthetic histories, including the open states live data does not have), `import.test.ts` (10, Postgres: numbers, state, claims, Decision and form, chain, door, second run, append, divergence, conflict, comparison, blobs), `scripts/test/{env-file,deploy-plan,launchers}.test.ts`, `tests/scenarios/cutover/imported.test.ts` (8, skipped unless the rehearsal sets `REHEARSAL_DATABASE_URL`).

## The rehearsal on today's dump (255 Issues, 2771 events)

```
|step|result|seconds|detail|
|restore into a private cluster (role factory, no CREATE on the database)|ok|0.5|255 Issues, 2771 events, schema owned by factory|
|admin: rename to factory_legacy, new empty factory (the role itself may not)|ok|0.4|role refused rename ("permission denied for database shared") and create; old schema 5b517e1cb24b8a (33 tables, 55449 rows)|
|boot the new core through scripts/launch.sh (paused by the settings file)|ok|0.9|/health ok, 11 migrations applied, loops intervalMs 0|
|import|ok|0.7|issues: 255 imported, 0 appended, 0 unchanged, 0 diverged, 0 in conflict|
|import again: nothing changes|ok|0.1|issues: 0 imported, 0 appended, 255 unchanged, 0 diverged, 0 in conflict; issues=255 issue_events=1755 decisions=26|
|compare every Issue, old against new (zero unexplained)|ok|0.0|compared 255 Issues: 212 match, 43 explained, 0 unexplained, 0 carried|
|the old schema is untouched by the import|ok|0.2|5b517e1cb24b8a (33 tables, 55449 rows)|
|scenarios on the imported data (tests/scenarios/cutover)|ok|1.5|8 pass, 0 fail|
|the way back: new schema aside, old schema back, its release boots on it|ok|2.2|old core 089b35c50d5f healthy (ok), /v1/overview 200, 255 Issues readable; numbers continue at 295|
|the next window: forward again, the import carries on|ok|0.5|issues: 0 imported, 0 appended, 255 unchanged, 0 diverged, 0 in conflict; 1 Issues the new core made are still there|
the rehearsal held
```

- **Every old event is accounted for**, 2771 of them: `created` mapped (255), `admitted` 231, `ask` 26, `answer` 22, `block` 12, `close` 18, `drop` 21, `lead_gone` 3, `note` 94, `regression` 21, `ship` 194, `signal` 22, `stop` 43, `unreported` 1, `verified` 173, `wait` 55, `wake` 31 mapped (25 `wake` for the claim dropped); folded: `ask_judged` 20, `github_writeback` 1, `issue_finalized` 257, `prio` 33, `refused` ship 225, `verify_red` 43, `worktree_kept` 8; dropped with a reason: `classified` 249, `classify_failed` 3, `hold_over` 194, `phase` 417, `refused` of other verbs 71, `steward_verify` 2, `transcript_missing` 1. The machine took all 1755 mapped events: **0 refused, 0 ignored**.
- **The 43 explained differences** are the old stops: the old core closed a stop as `dropped`, the language's Cancel is `cancelled`. Everything else (state, wait, attempt, outcome) matches.
- **The old schema is byte-identical** after the rename, the import and the next window's import (row counts and a content hash of all 33 tables).
- **What live data cannot show:** not one Issue was `working`, `waiting` or `queued` today. The open states are proved by the unit and Postgres tests with synthetic Issues, not by the rehearsal (a working Issue gets its claim, a decision wait keeps an open Decision and the form as an artifact, a note that woke a decision wait ends it as an answer and withdraws the Decision, a regression cap, a timed wait, a forced close). Draining first (runbook W1, W2) keeps the live window like today's data.

## `make check` output

```
==> install (bun install --frozen-lockfile)        Checked 46 installs across 102 packages (no changes)
==> format (oxfmt --check)                         All matched files use the correct format.
==> lint (oxlint --type-aware)
==> shellcheck
==> typecheck (tsc --noEmit)
==> boundaries (scripts/boundaries.ts)            boundaries hold
==> retired words (scripts/retired-words.ts)      no retired words
==> Issue diagram is current (issue-diagram.ts --check)
==> generated CLI is current (generate.ts --check)
==> unit tests (bun test apps packages scripts)    966 pass, 0 fail, 5951 expect() calls, 72 files
==> scenarios (bun test tests)                     195 pass, 8 skip (the cutover scenarios: they need the rehearsal's copy), 0 fail
==> check passed
```

(Package 8 ended at 941 unit and 195 scenarios. The final run is the one after the review's fixes: see Review.)

## `DRY_RUN` plans

`DRY_RUN=1 FACTORY_REF=rewrite make deploy` on the mini prints `would deploy 9b358e0af249 (new core (apps/server)) (live: 089b35c50d5f, old core (packages/server))`, `the settings file is accepted by the launcher of this tree`, the plist of `scripts/launch.sh`, `ln -sf …/current/apps/cli/bin/factory.ts …/.local/bin/factory`, the door from the same release, and `on failure … boot the previous release again`. `DRY_RUN=1 make rollback` prints `would roll back <live> (old core (packages/server)) -> <previous> (old core (packages/server))` on the mini today, because the live release is still the old core's. With a live new core, `scripts/test/deploy-plan.test.ts` asserts `would roll back <sha> (new core (apps/server)) -> <sha> (old core (packages/server))`, the old CLI link, the old door, and that a rollback **refuses before stopping anything** when the settings file has a key the old launcher does not know.

## Ports declared, events recorded

No port, no change to `main.ts` or any shared domain file; the one test-harness edit is additive (`startWorldOn` in `tests/scenarios/harness.ts`, `startWorld` now calls it).

The import records these events on Issues, all with the key `import:<n>:…` and the time of the old event: `filed` (factory) and a `noted` with the request text and facts, `settled`, `admitted`, `asked` (lead), `answered` (owner, judge or factory, by who answered), `stalled` (`blocked` by the lead, `unreported` and `wall` by the factory), `deferred`, `lead_gone`, `noted` (owner, steward or factory), `shipped`, `watch_passed`, `regressed`, `closed` (`done` and `dropped` by the lead), `cancelled` (owner, for a stop; also the forced close of an Issue the old core closed and the machine would not), `reopened`, and `woken` where the old core woke a wait without a person. It plans **no effect**: an imported Issue starts nothing by itself (a `watching` Issue gets an open watch row, which the watch loop verifies).

## Review

(see below)

## Open points

1. **Decision taken, for the orchestrator to confirm: the import runs on a paused new core.** The brief orders deploy then import; if the loops ran in between, the planning pass would file plan rows the import is about to mark as filed, and an imported queued Issue could be admitted half-way through. So the runbook starts the new core with `FACTORY_TICK_MS=0` in `~/.config/factory/env` (a documented knob; `/health` shows every loop `intervalMs: 0`), imports, drains the queue, then removes the line and restarts (W5 to W9).
2. **The way back is not `make rollback` alone.** `make rollback` stops and starts in one command, so it would start the old release on the new schema. The runbook stops the new server first, swaps the schemas as the admin, then runs `make rollback`, which finds nothing to stop (B4 to B6). Window 1 has the same order (W3, W4, W5). Documented, rehearsed, but a trap for anyone who runs `make rollback` first.
3. **`FACTORY_REF=rewrite make deploy` must run from a checkout of `rewrite`** (its scripts are the new core's). From a checkout on master the old `deploy.sh` would still re-exec the release's own copy once the release is built, so it works, but its `chmod` of `packages/cli/bin/factory.ts` fails noisily first.
4. **Settings allow-list vs the old rule.** The old header refused "a program the server would run" in the settings file. The brief says the list gets every setting the reports name, and reports 3, 4 and 6 name `FACTORY_CLAUDE_BIN`, `FACTORY_PRETRUST_BIN`, `FACTORY_CLAUDE_ACCOUNT_BIN`, `FACTORY_SYSCTL_BIN`, `FACTORY_AGW_BIN`. I followed the brief; the file is the user's own at mode 0600, like the plist. Say if the old rule should win. `HC_BIN` and `HC_SESSION` (no `FACTORY_` prefix) stay with the plist.
5. **Hermes' filing needs an owner decision.** `hermes-agent.patch` files with `factory signal file --from owner:hermes`, which the server takes as the owner's only under the owner's token; Hermes holds only the read token. Giving it the owner token is a security-policy call (not mine). Without it Hermes cannot file Issues on the new core.
6. **Beszel polling stays off.** The new Beszel source needs `FACTORY_BESZEL_EMAIL` and `FACTORY_BESZEL_PASSWORD`; `.env.tpl` never had refs for them (the old core's source was off for the same reason). Add refs if it should run.
7. **Not run live, so not proved:** `verify.sh` against a live new core, the real `launchctl` path of `deploy.sh` (only `DRY_RUN` and the launcher boot are), and the door's real LaunchAgent start with `.env.door.tpl`. The first window is where they get exercised; the runbook checks each (W5, W11, W12).
8. **Docs that contradict the code until package 9b** (not touched, as the brief says): `AGENTS.md` (the door "holds no factory token"; the settings section), `docs/design.md`, `apps/door/README.md` (same sentence, and `packages/door` in the deploy text), `docs/rewrite/reports/6-checkpoints.md` and `learnings.md` still describe `FACTORY_CHECKPOINT_PASS_MS`, which is retired (the allow-list keeps it so an old file launches). `project.yaml`'s `deploy.hold` keeps its retired word (report 3, point 2).
9. **Words the code uses that the owner's language contradicts** (not put into `docs/language.md`):
   - `held` means two things in intake: quarantined, and a `down` waiting out its heal grace (report 2, point 2).
   - `settling` is a state, a triage detail and a loop's name.
   - `review` is a wait reason (a person's verdict on a Concept or Spec) while the language's **Review** is the lead's own check.
   - `request` survives as a signal kind and `ask`/`asks` as wire names (`read asks`, `/v1/asks`); `humanQueue` is the wire name of open Errands (allow-listed in the retired-word check, for existing clients).
   - The read API's `phase` is a plain word derived from the state, which the language retires as a field.
   - The Decision, ledger and artifact words `status`, `page` and `needs` are used as written in the reports; "Needs you" stays a page title only.
   - `avoidable touch` has a measuring definition in report 8 (an owner-answered Decision not marked worth asking, plus owner `noted`, `woken`, `cancelled`, `reopened`), which is narrower than the language's "one the factory should have settled".
10. **Small import choices to confirm:** a Decision the old core had keeps its question and options; its recommendation is the old default, and `checked`, the options' costs and the consequence say `not recorded: imported from the old core`. All imported options are `reversible: true` (the old core had no such field; only an open Decision could ever matter, and none is open today). A `signal` event on an Issue becomes a `noted` from the factory. The old queue states, projects and runtime tables are not carried (listed in the runbook).
11. **The cutover scenarios are a smoke set, not the full suite.** They run the key routes on the imported data (read API, show, a new Issue past the old numbers, reopen and cancel an imported Issue, a refused note on a closed one, the Decision forms readable, the door's routes, the loops on demand). The scenario suite proper starts its own worlds and cannot be pointed at an existing database; a lead's full cycle on imported data is the live scratch drill (W13).
12. **Two postgres test clusters from other sessions** (`/tmp/factory-pg-*`, started with `listen_addresses=` empty) were still running when I finished; they are not mine and I left them.
