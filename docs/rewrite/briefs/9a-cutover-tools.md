# Package 9a: The cutover's tools

**Build everything the cutover needs, and prove it on a copy of the live data, without touching anything live.**
The orchestrator runs the rehearsal and the live windows itself with what you build (`docs/rewrite.md` "The cutover,
in windows", NL24). Branch `rw/9a-cutover-tools`. Review: deep, `--thread rw-9a-cutover-tools`.

## Read first

`docs/rewrite.md` (the windows), `docs/architecture.md` §Data, `AGENTS.md` (deploy, settings, secrets: never `op` on
this machine, `secrets-run` only), `docs/rewrite/learnings.md` (every "for package 9" line is yours unless it says
the orchestrator), `docs/rewrite/reports/{0..8}-*.md` (their package-9 open points; report 8's client list), and the
running deploy: `scripts/{deploy,verify,version,launch,launch-door,env-file}.sh`, `deploy/*.plist.template`,
`.env.tpl`, `docs/design.md` §12 "Data model" and the old migrations in `legacy/server/migrations/`.

## Live is read-only for you

You may read the live database (a `pg_dump` of schema `factory` through `secrets-run`, `SELECT`s) and the running
server's read routes. You may not: deploy, stop or start a service, change the queue, run DDL or writes against the
live database, push to another repo's default branch, or create secrets. Anything that needs one of those is a step
in the runbook you write, for the orchestrator.

## Build

1. **Permissions check first** (read-only), and report it at the top of your report: can the `factory` role rename its
   schema and create a new schema `factory` in the shared database (`has_database_privilege(..., 'CREATE')`, schema
   ownership)? The plan renames the old schema to `factory_legacy` and lets the new core create `factory`. If the role
   cannot, stop that part, write what grant is missing and where it is made (`~/SourceRoot/vps`, `make db-shared`),
   and build the rest against a private cluster where you grant it yourself.
2. **The import** (`apps/server/scripts/import-legacy.ts` or a `factory admin import` verb, owner token only): from
   `factory_legacy` into the new schema, idempotent (a second run changes nothing), in one transaction per Issue:
   Issues with their numbers (the sequence set past the largest, report 1), their events mapped to the new event kinds
   (every old kind and park/hold reason has a mapping or a recorded reason it is dropped), the derived state that
   results, decisions and their answers into the ledger, evidence, projects and plan state, and **claims for Issues
   that are `working`** (report 3, open point 3: otherwise they block their repo). Nothing is deleted from
   `factory_legacy`. A second source: Issues and events the new core recorded in an earlier window carry forward.
3. **The comparison** (`... import --compare`): for every imported Issue, the old core's state, wait or park, attempt
   and outcome against the new core's derived ones; a table of mismatches with a reason each. Zero unexplained
   mismatches is the rehearsal's bar.
4. **The rehearsal harness** (`scripts/rehearse.sh` or a make target): dump the live schema read-only, restore it into
   a private cluster as `factory_legacy`, boot the new server there with migrations, run the import and the
   comparison, run the scenarios against that server, then **rehearse the way back**: the old core's schema restored
   under its name and the old server's code (`legacy/`, or master's release) booting on it. Prints one summary.
5. **Deploy for the new core:** `scripts/deploy.sh`, `verify.sh`, `version.sh`, `launch.sh`, `launch-door.sh` and the
   plists start `apps/server` and `apps/door`; `make deploy`, `make verify`, `make version`, `make rollback` keep their
   contract; `FACTORY_REF=<branch>` still works; `DRY_RUN=1` prints the plan; `make rollback` can return to the old
   core's release. The installed CLI lands at `~/.local/bin/factory` (report 0: `rd` reads that path first).
   `scripts/env-file.sh`'s allow-list gets every new setting the reports list; retired keys stay listed so an old file
   still launches. `.env.tpl` gets `FACTORY_AGENT_TOKEN` and `FACTORY_DOOR_TOKEN` refs (the orchestrator creates the
   items). `verify.sh` and the gameday scripts stop calling retired verbs.
6. **The runbook** `docs/rewrite/cutover-runbook.md`: every step of a window in order with its exact command, how to
   tell it worked, and how to undo it: global drain and waiting for running leads to finish; stopping the old server;
   the schema rename; the deploy with `FACTORY_REF=rewrite`; the import; live checks; the queue on `pace` for named
   repos; the window's watch list (what to look at and how); and the way back (drain, stop, `make rollback`, rename
   back, old queue on). Plus the one-time steps: the two new 1Password items, and the client changes from report 8
   as exact patches (a file per client under `docs/rewrite/client-patches/`), applied by the orchestrator in a window.
7. **The language:** reconcile `docs/language.md` with the code: the new words from reports 1 to 8 (events, waits,
   outcomes, triage details, loops, pass, claim, queue reason and the rest), each in the table it belongs to; a word
   the code uses that the owner's language contradicts goes to your open points, not into the doc.

## Acceptance

- The rehearsal runs end to end on today's dump: import, comparison with zero unexplained mismatches, scenarios green on
  the imported data, the way back boots the old core. Its summary in your report.
- `DRY_RUN=1 FACTORY_REF=rewrite make deploy` and `DRY_RUN=1 make rollback` print a plan that starts the new core and
  returns to the old one.
- The runbook has every step with command, check and undo.
- `make check` green, output in your report.

## Out of scope

Anything live beyond reads (above). Deleting `legacy/` and rewriting `AGENTS.md` and `docs/design.md` (after the
cutover holds). The Console.

## Finish

As `docs/rewrite/briefs/parallel.md` §Finish says, with `docs/rewrite/reports/9a-cutover-tools.md`.
