# Cutover runbook

**Every step of a window in order: the command, how to tell it worked, how to undo it.** The orchestrator runs it
(`docs/rewrite.md` "The cutover, in windows"). The rehearsal (`make rehearse`) runs the same steps on a copy of the live
data; what it proved and where it differs from live is at the end. Everything below runs on the mini.

Conventions: `<rw>` is the checkout on branch `rewrite` (its `scripts/` are the new core's: deploy from there, not from a
checkout still on `master`). `admin_sql <file>` is the database admin's psql, defined once:

```bash
admin_sql() { # <file in <rw>/scripts/cutover>: vps' own target (Docker runs through Makefile targets only)
  { printf '\\connect shared\n'; cat "$1"; } | make -s -C ~/SourceRoot/vps sql-postgres
}
```

```bash
# the new core's CLI with the owner's token (the deployed release's .env.tpl); the old core's CLI needs none (it speaks on the socket)
fx() { secrets-run run --env-file="$HOME/.software-factory/current/.env.tpl" -- factory "$@"; }
# a psql as the factory role, the credential resolved in the child
pg() { secrets-run run --env-file="$HOME/.software-factory/current/.env.tpl" -- sh -c 'PGPASSWORD=$FACTORY_DB_PASSWORD exec psql -X -h 127.0.0.1 -U factory -d shared -At "$@"' sh "$@"; }
```

From W5 to B4 every `factory …` below is `fx …`; in W1 to W3 and B7 it is the old CLI, bare.

The `factory` database role owns its schema but holds **no CREATE on the database**, and renaming a schema needs both
(the rehearsal proves it: `permission denied for database shared`). So the rename and the new empty schema are the admin's
step. Nothing in `~/SourceRoot/vps` changes: `scripts/setup-shared-db.sh` stays as it is, and its `make db-shared` does not
touch a schema's name.

## Before the window (no live effect)

| # | Step | Command | It worked when | Undo |
|-|-|-|-|-|
| P1 | The rehearsal holds on today's data | `cd <rw> && make rehearse` | the last line says `the rehearsal held`; import `0 unexplained`; scenarios pass; the old core boots on the way back | none needed |
| P2 | The plans | `cd <rw> && DRY_RUN=1 FACTORY_REF=rewrite make deploy && DRY_RUN=1 make rollback` | the deploy plan says `new core (apps/server)` and `the settings file is accepted`; the rollback plan says `-> … (old core (packages/server))` | none needed |
| P3 | The tokens resolve | `for k in FACTORY_AGENT_TOKEN FACTORY_DOOR_TOKEN; do secrets-run read op://mini/software-factory/$k >/dev/null && echo "$k ok"; done` | both `ok` (created 2026-11-07, in `headless.refs`, cache seeded) | none needed |
| P4 | Admin access works | `docker ps --format '{{.Names}}' \| grep -x postgres` and `echo 'select 1' > /tmp/one.sql && admin_sql /tmp/one.sql` | the container is named, `select 1` answers | none needed |
| P5 | A restore point of the live schema | `PGPASSWORD=$(secrets-run read op://mini/vps-dev/SHARED_FACTORY_DB_PASSWORD) pg_dump -h 127.0.0.1 -U factory -d shared -n factory -Fc --no-privileges -f ~/.software-factory/data/backups/pre-cutover-$(date +%Y%m%d).dump && chmod 600 ~/.software-factory/data/backups/pre-cutover-*.dump` | the file exists, `pg_restore -l <file> \| grep -c 'TABLE DATA'` prints 33 | `rm` it (it holds the private text of IuRoot Issues: delete it after the cutover has held) |
| P6 | The settings file for a paused start | `install -m 600 /dev/null ~/.config/factory/env` only if it does not exist; then `grep -q '^FACTORY_TICK_MS=' ~/.config/factory/env \|\| echo 'FACTORY_TICK_MS=0' >> ~/.config/factory/env` | `stat -f %Lp ~/.config/factory/env` is `600`; the line is there | delete the line (step W9 does) |
| P7 | The window's repos are named | the orchestrator picks `<repo-a>` and `<repo-b>`, own repos, **never `software-factory`** until the cutover holds (its master is the old core: a lead's ship would `make deploy` the old core over the new one); a repo is its directory name | written into the window's learnings entry | none needed |

P6 matters twice: the new core starts with its loops off so nothing is admitted before the import is in, and the old
core's launcher **refuses a settings file with a key it does not know** (exit 78, a loop under KeepAlive). `make rollback`
checks that before it stops anything and names the key; the way back removes the line first anyway.

## Window 1 (and every first step of a later window)

### Close the old core

| # | Step | Command | It worked when | Undo |
|-|-|-|-|-|
| W1 | Drain the whole old queue | `factory queue set drain` (the old CLI, still linked) | `factory queue get` prints `global drain drain …` | `factory queue set run` |
| W2 | Wait for running leads to finish | `until [ "$(factory --format json read overview \| jq '.counts.working')" = 0 ]; do sleep 30; done` (the owner may `factory issue stop <n>` a lead that will not finish) | `.counts.working` is `0` and `factory read sessions --live` lists none | W1's undo |
| W3 | Stop the old server | `launchctl bootout gui/$(id -u)/com.jkrumm.software-factory` and `while pgrep -f 'bun packages/server/src/main.ts' >/dev/null; do sleep 2; done` | no `bun packages/server/src/main.ts` process (a shutdown may take up to 240 s) | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jkrumm.software-factory.plist` (the old plist is still in place) |

The old door keeps running; the sources that alert while the server is down get a 503 and retry (Kuma does). The new core
binds the old hook socket path and refuses to steal a live one: W3 comes first.

### The schema

| # | Step | Command | It worked when | Undo |
|-|-|-|-|-|
| W4 | The old schema steps aside, the new core gets an empty one | `admin_sql <rw>/scripts/cutover/schema-swap.sql` (`ALTER SCHEMA factory RENAME TO factory_legacy; CREATE SCHEMA factory AUTHORIZATION factory;` in one transaction) | `pg -c "select count(*) from factory_legacy.issues"` prints the Issue count, and `pg -c "select count(*) from pg_tables where schemaname='factory'"` prints `0` | before the new core ever ran: `DROP SCHEMA factory; ALTER SCHEMA factory_legacy RENAME TO factory;` as the admin. After it ran: the way back below |

### The new core, paused

| # | Step | Command | It worked when | Undo |
|-|-|-|-|-|
| W5 | Deploy `rewrite` | `cd <rw> && FACTORY_REF=rewrite make deploy` | the last line is `deploy OK: <sha> (new core (apps/server)) healthy; factory -> ~/.local/bin/factory`; `door OK` (a warning that the door does not answer is not a failed deploy: read it) | the way back below (`make rollback`); a failed health check rolls back by itself |
| W6 | Migrations applied, loops off | `curl -s localhost:7793/health \| jq '{status,version,loops: [.loops[] \| {name,intervalMs}]}'` and `make version` | `status ok`, `version` is the sha, every loop `intervalMs: 0` (off) | the way back |
| W7 | The new queue starts drained | `fx queue set drain` | `fx queue get` prints `global drain drain` | `fx queue set run` |

### The import

| # | Step | Command | It worked when | Undo |
|-|-|-|-|-|
| W8a | Import | `bash ~/.software-factory/current/scripts/import.sh` | `issues: N imported, 0 appended, 0 unchanged, 0 diverged, 0 in conflict`; `machine on the mapped events: … 0 refused` (a refusal is listed with its reason: read each); the sequence line shows the largest old number | the import adds rows to `factory` only; to redo from nothing: the way back, then W4 again (the new schema is dropped in the rehearsal's way: rename it aside, do not delete) |
| W8b | Again: nothing changes | `bash ~/.software-factory/current/scripts/import.sh` | `0 imported, 0 appended, N unchanged` | none needed |
| W8c | Compare | `bash ~/.software-factory/current/scripts/import.sh --compare` | exit 0: `0 unexplained`, `old events without a disposition: 0`. The explained rows are the old stops (a stop closed as `dropped`, the language's Cancel is `cancelled`) | none needed |
| W8d | The old schema is as it was | `pg -c "select count(*) from factory_legacy.issues"` equals the count in P5's dump | equal | none needed |

An Issue that is `diverged` or in `conflict` is listed with the reason and left as it is; stop the window and read it
(in window 1 there are none: the new schema was empty).

### What the import carries

| Carried | Into | How |
|-|-|-|
| Issues, with their numbers | `issues`, `issue_events` | each old Issue's events replayed through the new machine at the time they happened; the repo is its directory name; the request text and facts become the first note; a stop closes as `cancelled`; `issue_numbers` is set past the larger of both cores |
| Every old event kind | `import_events` | `mapped`, `folded` into another table, or `dropped` with the reason; `import.sh` prints the count per kind and what the machine said to each mapped event |
| Decisions and their answers | `decisions`, `artifacts`, `artifact_revisions`, `decision_steps` | the form's fields the old core never had say `not recorded: imported from the old core`; the form is revision 1 under `FACTORY_DATA_DIR/blobs`; an open Decision stays open |
| Ships, reviews, watches, checks, refused ships | `quality_ships`, `quality_evidence`, `quality_watches`, `quality_checks` | from the ship, verified, verify-red and regression events; a `watching` Issue gets an open watch, so verify runs at once |
| Priorities, the chain, plan rows filed | `planning_prios`, `planning_edges`, `planning_filed_rows` | a plan row already filed is not filed twice |
| Claims of `working` Issues | `capacity_claims` | otherwise they block their repo |
| The door's registry | `intake_door_routes`, `_sources`, `_unrouted`, `intake_subjects`, `intake_seen` | the repo as its directory name |
| GitHub write-backs, finalized attempts | `intake_writebacks`, `lead_finalizations` | |

Left in `factory_legacy`, not carried: the queue states (the window sets them: W7, W10), the projects (read again from each
`project.yaml`), sessions, prompts, session events, effects, spawns, the issue inbox and effects, test slots, quota readings,
the fleet digest, notifications and the witness. Nothing is deleted from `factory_legacy`, and nothing is written to it.

### Unpause, narrow, check

| # | Step | Command | It worked when | Undo |
|-|-|-|-|-|
| W9 | Loops on | remove the `FACTORY_TICK_MS=0` line from `~/.config/factory/env`, then `launchctl kickstart -k gui/$(id -u)/com.jkrumm.software-factory` and `until curl -fs localhost:7793/health >/dev/null; do sleep 1; done` | `/health` shows every loop with an interval above 0 and a `lastOkAt` after the first pass (`jq '.loops'`), `.status ok`, `.tickAt` moves | put the line back and kickstart again |
| W10 | Only the named repos run | `fx queue set pace` (global), then for every other repo: `for d in ~/SourceRoot/*/ ~/IuRoot/*/; do n=$(basename "$d"); case $n in <repo-a>\|<repo-b>) ;; *) fx queue set drain --project "$n" ;; esac; done` | `fx queue get` shows the global `pace` and `drain` for every other project; the named two are not listed. (A queue state is the more restrictive of the global and the project's own.) | `fx queue set run` globally and `fx queue set run --project <p>` for each drained one |
| W11 | The door is the new door | `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'x-factory-probe: 1' -H 'content-type: application/json' -d '{}' http://127.0.0.1:8796/alert/kuma`; `fx door report` | `401`; the sources report their tokens accepted | the way back re-installs the old door |
| W12 | The live checks | `make verify` (from `<rw>`) | `verify: all checks passed` | none needed |
| W13 | The scratch drill | `bash scripts/gameday/setup.sh` (adds the scratch repo; set its queue to run: `fx queue set run --project factory-gameday`), then `bash scripts/gameday/scratch.sh` | `run gd-…: GREEN`: filed, admitted, built, shipped, watched, verified, closed `done`, the commit on the scratch remote. Later windows add `--kill-server` | `bash scripts/gameday/teardown.sh` |
| W14 | The clients | apply the patches of `docs/rewrite/client-patches/` (below) | each client's own check passes | `git apply -R` per patch |

### The watch list (the whole window)

| What | How | Good looks like | Act when |
|-|-|-|-|
| Health and the heartbeat | `curl -s localhost:7793/health \| jq` every few minutes; `.lines` is the door's health, `.loops` each loop | `status ok`, `tickAt` under a minute old, no loop `failing` | `status` not `ok` for 2 minutes, a loop failing twice in a row |
| The loops | `fx loop list`; `fx loop run <name>` runs one pass now | each loop's last pass recent, no error | a pass that errors: read `~/Library/Logs/software-factory.err.log` |
| The event log | `fx follow` (the change stream, one line per change) in a terminal | events arrive for the named repos only | events for a drained repo |
| Refusals | `pg -c "select kind, result, left(detail,90), count(*) from factory.issue_events where at > now() - interval '1 hour' and result <> 'applied' group by 1,2,3 order by 4 desc"` (`pg` above) | none, or a refusal that names a stale attempt | a refusal that repeats: a lead that does not know a verb (the brief) |
| Stalls | `fx --format json read overview \| jq '.counts'`; `fx read flow` | `waiting` only on timers and Decisions | a `wall`, `unreported`, `blocked`, `lead_gone` or `regressed` wait older than the steward's minimum stall (2 min) that the steward did not end |
| Decisions that reach the owner | `fx read needs`; `fx page list` | each carries recommendation, what was checked, cost per option | a Decision with a missing field, or one that pages for a reversible choice |
| Memory and load | `fx capacity get` | no memory wait; load under the ceiling | a lead held for memory with no named exit |
| Leads | `fx read sessions --live`; the Herdr app | one lead per named repo (`pace`) | a terminal with no Issue, an Issue with no terminal |
| Quality | `fx read friction`; `fx read kpis` | first-pass watch rate near the old core's | a ship refused for a reason the lead cannot fix |
| Logs | `tail -f ~/Library/Logs/software-factory.err.log` and `…out.log` | quiet | any stack trace |
| The door | `fx door report`; `/health .lines` | sources accepted | a source refused (a stale token) |

### The window ends

**It ends when a real Issue (not the scratch one) of a named repo was admitted, built, shipped, watched and verified, or at
the first finding that needs a fix.** Then, in this order:

1. Write the learnings entry in `docs/rewrite/learnings.md` (what held, what did not, what changes on `rewrite`) and the
   `docs/rewrite/state.md` row, and commit the fix on `rewrite` before the next window.
2. Either stop (the way back) or, when it held, widen at the next window (below).

## The way back (a window's normal end)

The new core's schema is **kept**, renamed `factory_rewrite`; nothing either core recorded is deleted.

| # | Step | Command | It worked when | Undo |
|-|-|-|-|-|
| B1 | Drain the new core | `fx queue set drain` | `fx queue get` is `drain` | `fx queue set pace` |
| B2 | Wait for the running leads | `until [ "$(fx --format json read overview \| jq '.counts.working')" = 0 ]; do sleep 30; done` (or `fx issue cancel <id>` a lead that will not finish) | `.counts.working` is `0` | none needed |
| B3 | Settings the old launcher refuses are gone | remove `FACTORY_TICK_MS`, and any other key added in this window, from `~/.config/factory/env` | `DRY_RUN=1 make rollback` (step B6) says `the settings file is accepted by …` | put them back |
| B4 | Stop the new server | `launchctl bootout gui/$(id -u)/com.jkrumm.software-factory` and wait until `pgrep -f 'bun apps/server/src/main.ts'` finds nothing | no process | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jkrumm.software-factory.plist` |
| B5 | The schemas swap back | `admin_sql <rw>/scripts/cutover/schema-back.sql` (new `factory` → `factory_rewrite`, `factory_legacy` → `factory`), then `pg -f <rw>/scripts/cutover/old-sequence.sql` (the old Issue numbers continue past every number the new core used) | `pg -c "select count(*) from factory.issues"` is the old count; `old_issue_numbers_continue_at` is at least the largest `issue_<n>` of `factory_rewrite` | `admin_sql <rw>/scripts/cutover/schema-forward.sql` |
| B6 | The old release starts | `cd <rw> && DRY_RUN=1 make rollback` (read it: `-> … (old core (packages/server))`), then `make rollback` | `rollback OK: <sha> (old core (packages/server)) healthy; factory -> ~/.local/bin/factory`; the old door is back | `FACTORY_REF=rewrite make deploy` after `schema-forward.sql` |
| B7 | The old queue is on | `factory queue set run` (the old CLI; `factory queue get --project <path>` for the project states the old core kept) | `factory queue get` is `run`; `factory read overview` answers | `factory queue set drain` |
| B8 | The clients go back | `git apply -R` each patch of `docs/rewrite/client-patches/` that was applied | each client's check passes | re-apply |

Order matters: the new server is **stopped before** the swap and the old one is **started after** it. `make rollback` stops
and starts in one command, which is why B4 and B5 come first (it finds no service to stop and starts the previous
release on the right schema).

## Later windows

Same steps, with these changes. The old core ran in between and recorded on its schema; the new core's own schema is
`factory_rewrite`.

| # | Step | Command |
|-|-|-|
| L1 | W1 to W3 | drain, wait, stop the old server |
| L2 | The new core's schema is `factory` again | `admin_sql <rw>/scripts/cutover/schema-forward.sql` (old `factory` → `factory_legacy`, `factory_rewrite` → `factory`) |
| L3 | Settings for a paused start (P6), deploy (W5), loops off (W6), queue drained (W7) | as above |
| L4 | Import carries on | `bash ~/.software-factory/current/scripts/import.sh`: an old Issue the old core touched since is **appended** (its new old events), one the new core also worked is listed `diverged` and left as the new core has it; `--compare` still exits 0 (an Issue the new core worked since is `carried`, not compared) |
| L5 | W9 to W14 | widen the queue: more repos `run` instead of `pace` (`fx queue set run --project <p>`), longer, then overnight |

The cutover is done when a window holds its criteria with every repo on `run` for a day: then `legacy/` is deleted and the
docs describe the new core (package 9b, after the cutover holds).

## One-time steps

| What | State | Command or where |
|-|-|-|
| `FACTORY_AGENT_TOKEN` and `FACTORY_DOOR_TOKEN` in 1Password | **done** (2026-11-07) | `op://mini/software-factory/…`; refs are in `.env.tpl` (and the door's in `.env.door.tpl`) |
| The admin path for the schema swap | needs nothing new | `~/SourceRoot/vps`, superuser `psql` in the `postgres` container (`admin_sql` above) |
| The door's sources | unchanged | `~/.config/factory/door-tokens.json` stays; `factory door token new <source>` only for a new source |
| The settings file | P6 | `~/.config/factory/env` (mode 0600), allow-list in `scripts/env-file.sh` |
| Beszel polling | not on | needs `FACTORY_BESZEL_EMAIL` and `FACTORY_BESZEL_PASSWORD` refs in `.env.tpl`; the old core had none either, so the poller stays off as it was |
| Hermes may file | **owner decision** | `docs/rewrite/client-patches/hermes-agent.patch` files with `factory signal file --from owner:hermes`, which needs the owner's `FACTORY_TOKEN` in Hermes' tool environment; the read token cannot file. Without that, Hermes cannot file Issues |

### Client patches (applied in a window, after W12)

A file per client in `docs/rewrite/client-patches/`; each is a `git apply` patch from the client repo's root and reverts with
`git apply -R`. They are not applied by the rewrite's `make check` and the clients' default branches are not touched
until the orchestrator applies them in a window.

| Client | Patch | What | Check after |
|-|-|-|-|
| Iris | `iris.patch` | `AnswerAck` reads the new reply (`issue.id` is `issue_<n>`); a repeated answer (409) is the old `duplicate: true` | `cd ~/SourceRoot/iris && make check` |
| Hermes | `hermes-agent.patch` | the fleet skill files with `factory signal file --from owner:hermes` (owner decision above) | the skill's own dry file against the scratch repo |
| dotfiles | `dotfiles.patch` | the Herdr board stops calling `fleet --refresh`; `rd`'s `factory_host` runs under `secrets-run` with the owner's token; the test stubs it; the `wave` and `remote-dev` skills and the doc teach `issue cancel`, `read overview`, `issue defer` | `cd ~/SourceRoot/dotfiles && bash scripts/remote-dev-factory.test.sh` |

Not patched because they need nothing: Argo (no call), agw's `agents` (`read overview`, `read sessions --live` are the same),
`config/settings.template.json` (the hook verbs), `hooks/test-slot.ts` (`slot run` with no token runs unslotted with one
stderr line; give the callers `FACTORY_TOKEN` when slots should be held again), `devhost-health-check.sh` (`/health` keeps its
heartbeat names).

## What the rehearsal proved, and where live differs

`make rehearse` on today's dump (255 Issues, 2771 events): restore, the admin step with the role refused first, a paused new
server, the import (1755 events applied by the machine, none refused), the second run (nothing changes), the comparison
(212 match, 43 explained as old stops, 0 unexplained), the old schema byte-identical (counts and a content hash), 8
scenarios on the imported data, the way back (the old release `master` boots on the restored old schema and answers), and
the next window (the import carries on, an Issue the new core made stays).

Live differs in what the dump cannot show: **no Issue was `working` or `waiting` in today's data**, so the import of an open
Issue is proved by unit and Postgres tests (`apps/server/test/import/`) with synthetic Issues (a working Issue gets its
claim, a decision wait keeps an open Decision with its form as an artifact, a note that woke a decision wait in the old core
ends it as an answer and withdraws the Decision), not by the rehearsal. Drain first (W1, W2) keeps live like today's data.
Also: the rehearsal's old core runs with its pollers, digest and notifier off and fake `hc` and `agw`; the live way back
starts them as they were.
