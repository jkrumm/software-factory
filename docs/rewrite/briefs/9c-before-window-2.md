# Package 9c: Before window 2

**Fix what window 1 found, so window 2 can run wider and longer.** Read `docs/rewrite/learnings.md` from "window 1"
on (the findings and "What window 2 needs first"), `docs/rewrite/cutover-runbook.md`, `docs/rewrite/reports/
{8-api-parity,9a-cutover-tools,9b-shutdown}.md`, and `docs/rewrite/briefs/parallel.md` for conventions. Branch
`rw/9c-before-window-2`. Review: standard, `--thread rw-9c-before-window-2`. Live systems are read-only for you.

## Build

1. **A signal-only caller for Hermes.** A fifth caller `signal` with its own token `FACTORY_SIGNAL_TOKEN` (optional
   like the others; `.env.tpl` ref `op://mini/software-factory/FACTORY_SIGNAL_TOKEN`; it may not resolve yet, and the
   server must start without it). Its only route is `POST /signals`, and a signal it files has trust `owner` with a
   `from` of `owner:hermes` (any other `from` is refused). Policy rows, the policy test, the settings allow-list,
   `docs/rewrite/client-patches/hermes-agent.patch` rewritten to use it (Hermes keeps the read token for reads), and a
   scenario: the signal token files an owner signal and is refused everywhere else.
2. **The drill's green check** (`scripts/gameday/scratch.sh`): a repo with no deploy whose AGENTS.md says commit, push,
   end the turn closes with `close`, so green is "closed `done` and the commit on the scratch remote", with ship, watch
   and verify checked only when the Issue shipped. Fix the commit lookup that missed `8ea8d58` on the remote (find why:
   the run's own evidence is in `docs/evidence/gamedays/gd-11071639/`).
3. **The runbook's stop steps** (W3, B4, and every `kickstart -k`): read the server's PID from `launchctl print` before
   the stop; after the grace, if that PID still lives, kill that PID (never a pattern), and say so. Correct the three
   commands window 1 found wrong (`FACTORY_REF=rewrite make verify`; the door read is `/health .lines` and `door
   routes`, not `door report`; `admin_sql` through `make -C ~/SourceRoot/vps sql-postgres` with `\connect shared`,
   already in the runbook: keep it). Add a step to W14 for the signal token.
4. **The door after a rollback:** `make rollback` warned that the old release has no `.env.door.tpl`, and a door still
   answered 401. Find which door binary runs after a rollback to the old core and after a deploy of the new one (read
   `scripts/deploy.sh`, the plist templates, `launchctl print` of `com.jkrumm.factory-door`), and make both directions
   start the right door with its own credentials; a test of the plan for each direction.
5. **The deploy plist's stale comment** (`ExitTimeOut` 240 s and the legacy 180 s start budget): say what holds for the
   new core (its 30 s shutdown deadline; 240 stays as the outer bound).

## Acceptance

`make check` green; the policy test covers the new caller; the drill's check has a unit or scenario test on both
shapes (closed by `close`, closed after a ship); `DRY_RUN=1` plans for deploy and rollback name the door they start.

## Finish

As `docs/rewrite/briefs/parallel.md` §Finish says, with `docs/rewrite/reports/9c-before-window-2.md`.
