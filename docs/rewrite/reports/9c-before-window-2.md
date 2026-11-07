# Package 9c: before window 2, report

Branch `rw/9c-before-window-2` on `0676d45` (the brief); six commits plus this report. Live systems were read-only throughout (`launchctl print`, `/health`, the scratch remote, `DRY_RUN=1` plans).

## What changed

- **A signal-only caller for Hermes (build 1).**
  - `apps/server/src/api/policy.ts`, `settings.ts`, `app/intake.ts`: a fifth caller `signal` with `FACTORY_SIGNAL_TOKEN`, optional like the others, at least 16 characters, different from every other token. Its only row is `POST /signals` (`FILE`: owner, agent, signal). `envelopeOfRequest` refuses any `from` but exactly `owner:hermes` for it (`trust_refused`, 403, nothing stored); the one it files has trust `owner`.
  - `.env.tpl` carries `FACTORY_SIGNAL_TOKEN=op://mini/software-factory/FACTORY_SIGNAL_TOKEN`; the token is listed with the other secrets in both child-env strip lists and in the settings-file `NEVER` test.
  - `scripts/optional-refs.sh` (new, sourced by `launch.sh` and `deploy.sh`): the refs that may be unresolved. **The server must start without the token, and it did not: `launch.sh` exits 78 and `deploy.sh`'s `check_refs` dies on any unresolved ref.** Both now drop/warn on an optional ref (`launch.sh` renders a refs-only template without it at `~/.software-factory/env.launch.tpl`, mode 600, and says so once on stderr). Review found the `check_refs` half.
  - `docs/rewrite/client-patches/hermes-agent.patch` files with `FACTORY_TOKEN="$FACTORY_SIGNAL_TOKEN" factory signal file --from owner:hermes …`; Hermes keeps the read token for reads. `git apply --check` passes against `~/SourceRoot/hermes-agent`.
- **The drill's green check (build 2).** Cause of the missed `8ea8d58`: `git log … | grep -q` under `set -o pipefail` returns 141 when `grep -q` stops at the first match and `git` is still writing (reproduced on the live scratch remote: 200 of 200 misses; `--format=%s | grep -q` happened to pass). `scripts/gameday/verdict.sh` (new, sourced by `scratch.sh`): `commit_on_remote` reads the whole log first; `verdict` is green when closed `done` with the commit landed, and an Issue with a `shipped` event must also have a `watch_passed` (where verify runs). A lead's `close` is the normal shape for the scratch repo.
- **The runbook (build 3).** `scripts/cutover/core-stop.sh` (new, run through `bash`: the mini's shell is zsh, which does not word-split the PID list): `core_stop <grace>` and `core_restart <grace>` read the PIDs from `launchctl print` before the stop, wait the grace, and kill any PID that still lives by number (SIGTERM, then `kill -9` after 3 s), saying so on a `reap:` line. W3 (grace 250), W9 and its undo (`core_restart 40`) and B4 (40) use it. Corrected: W12 is `FACTORY_REF=rewrite make verify`; W11 and the watch list read the door through `launchctl print …`, `/health .lines` and `door routes` (`door report` is the door's own POST); `admin_sql` through `sql-postgres` with `\connect shared` was already right and is kept. W14 gains the signal-token step; P3, W13, B6 and the one-time table are updated to match.
- **The door after a rollback (build 4).** Finding: it already started the right door. A rollback renders the door plist from the *previous release*, so it runs that release's `launch-door.sh`: the old core's runs `packages/door` (posts to the hook socket, holds no secret, has no `.env.door.tpl`); a deploy runs the new core's `apps/door` with `.env.door.tpl`. `launchctl print gui/501/com.jkrumm.factory-door` on the live mini (rolled back) shows `releases/089b35c…/scripts/launch-door.sh`, the old release. What was wrong: the `.env.door.tpl` warning was spurious for the old door, and the 401 proof is the same for both doors, so it never said which one ran. `scripts/deploy.sh`: `door_of`, `door_credentials`, `door_plan`, `door_runs_from`; both dry-run plans now print the rendered door plist and `door: <old|new> door (…) from <sha>, launcher …, credentials: …`; `deploy_door` checks the secret only if the release's launcher resolves a template, and its `door OK:` line names the door after confirming launchd runs that release's launcher (warning otherwise).
- **The plist comment (build 5).** `deploy/com.jkrumm.software-factory.plist.template`: the new core ends within its own 30 s deadline (draining aborts a lead start in flight); `ExitTimeOut` 240 stays as the outer bound and for a rollback onto the old core; the 180 s/210 s sentence is gone.

## Tests

- `apps/server/test/policy.test.ts`: the signal token is on exactly `POST /signals`, refused (403) on reads, owner verbs, lead verbs and the door's routes. `settings.test.ts`, `intake/receive.test.ts`: the token's presence, distinctness and `from` rule.
- `tests/scenarios/intake/signal-token.test.ts` (against the real server process): the signal token files an owner signal as `owner:hermes` through the CLI, any other `from` is refused and stores nothing, and it is 403 on nine other routes. `tests/scenarios/clients/replay.test.ts`: the patched Hermes skill's call.
- `scripts/test/gameday-verdict.test.ts`: both shapes (closed by `close`; closed after a ship, with and without the watch), the non-green cases, and the commit lookup on a real bare remote.
- `scripts/test/deploy-plan.test.ts`: the dry-run plan for deploy and for rollback names its door and credentials; `deploy_door` against a fake `launchctl`/`curl`/`secrets-run` for each direction (right launcher in the plist, no warning for the old door); `check_refs` with an unresolved optional ref (warns) and a required one (refuses).
- `scripts/test/launchers.test.ts`: `launch.sh` with and without the optional ref, and a required one still refusing (exit 78). `scripts/test/core-stop.test.ts`: `reap` kills a process that ignores SIGTERM by PID and leaves a bystander alone; `core_pids`, `core_stop`, `core_restart` against a fake `launchctl`; the script run under bash.

## `make check`

```
==> shellcheck
==> typecheck (tsc --noEmit)
==> boundaries (scripts/boundaries.ts)
boundaries hold
==> retired words (scripts/retired-words.ts)
no retired words
==> Issue diagram is current (apps/server/scripts/issue-diagram.ts --check)
==> generated CLI is current (apps/cli/scripts/generate.ts --check)
==> unit tests (bun test apps packages scripts)
 992 pass
 0 fail
Ran 992 tests across 76 files. [71.39s]
==> scenarios (bun test tests)
 201 pass
 8 skip
 0 fail
Ran 209 tests across 34 files. [169.05s]
==> check passed
```

`DRY_RUN=1 FACTORY_REF=rewrite make deploy` prints `door: new door (apps/door) … credentials: FACTORY_DOOR_TOKEN from its .env.door.tpl, and the tokens file`; `DRY_RUN=1 make rollback` prints the door of the release it returns to (on today's live state, rolling back from the old core to the new one prints the new door).

## Ports and events

None declared, no event recorded: this package adds a caller and tooling, no use case. A signal filed by the signal token takes the owner path of `intake.file` (same events as an owner signal).

## Review

`--thread rw-9c-before-window-2`. Round 1 (deep, because `.env.tpl` and `deploy.sh` are sensitive paths): 1 important, 2 nits, 1 pre-existing. Fixed: `check_refs` refusing the unresolved optional token (shared `optional-refs.sh`, test); `core-stop.sh` sourced in zsh would not split the PID list (now run through `bash`, dispatches its own functions); the drill header. Declined: `FACTORY_AGENT_TOKEN`/`FACTORY_DOOR_TOKEN` missing from the child-env strip lists (pre-existing; a lead's terminal receives its agent token through `childEnv`'s extras, which the strip runs after, so listing it would take the token from the lead). Round 2 (standard): clean.

## Open points

1. **`FACTORY_SIGNAL_TOKEN` does not exist yet.** Making it is a MacBook step (value generated there, ref added to `dotfiles-private/headless.refs`, cache reseeded; the traps are in the learnings entry on the two bearers). Until then the server starts without it (`launch.sh` and `deploy.sh` say so) and Hermes cannot file; W14 has the check.
2. **The 401 proof cannot tell the two doors apart**; `deploy.sh` now reads the launcher from `launchctl print` instead. `make verify` still only checks the 401.
3. **A release without a door plist template** leaves the door as it is (unchanged behaviour): rolling back onto such a release would keep the new door running against the old core. Today's old release has the template.
4. The Issue 297 plan row, the triage kind for requests (window 1 list items 4 and 5) are not part of this package.
