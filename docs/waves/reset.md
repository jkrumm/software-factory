# The reset: one Issue, one lead, one loop

**Goal:** design v3 (`docs/strategy/2026-11-reset/design-v3.md`) live, row by row of its §13, each row proven on the mini.
**Gate (every wave):** `make check` green (a failure in a file the wave did not touch that passes on a rerun of that file
alone is a load flake: record the rerun); `/review` over the wave's range at its routed tier, at most 2 rounds, then
`agw review covered` true; merged on master; `make deploy` and `make verify` green; the wave's own live proof; one entry in
`docs/strategy/2026-11-reset/learnings.md`.

Decisions: `docs/decisions.md` RS1–RS9. Each code wave is one `rd fan` worker (`worker`, Sonnet) in a worktree, briefed with
its row of §13 plus the design section it implements; the program lead reviews the diff, lands it with `rd merge`, deploys
and proves it. One wave at a time: the mini is the bottleneck (load reached 385 on 12 cores on 2026-11-04 from parallel checks
and the iOS simulator). One `make check` or `agw check` at a time; no `xcodebuild` or simulator run before 07:00.

## Wave 1 — Cutover (row 0)            <!-- status: done -->
The lead does this itself; no worker.
- [x] Issue 51: `factory issue stop 51` with the reason "superseded by the reset (RS8)"; its pane `t8h` closed by finalize.
- [x] Issues 52–55: `factory issue stop <id>` each, reason "dropped in the reset (RS8)".
- [x] `factory status` and `factory fleet` show no open Issue of software-factory and the asks count; record both.
- [x] learnings entry.
**Left behind:** 51–55 closed `dropped`, 51's pane and worktree gone (no unlanded commit). No open software-factory Issue; asks 7. No drain: this loop spawns through the queue (learnings).

## Wave 2 — Dependencies (row 3)            <!-- status: active -->
- [ ] `factory issue new --after <id>` (repeatable) writes `issue_deps` in the create transaction; an unknown or closed id is refused.
- [ ] Admission (`issues/admission.ts`) admits only Issues with no open dependency; `releaseDependents` on close stays.
- [ ] `factory issue prio <id> <n>` writes the `prio` event; admission orders by the latest priority, then id.
- [ ] Tests at the lifecycle and admission level; design.md §4 "As built" and AGENTS.md updated in the same commit.
- [ ] Live proof: two scratch Issues, B `--after` A; B stays queued until A closes.
**Left behind:**

## Wave 3 — Parks end (row 4)            <!-- status: pending -->
- [ ] The lead's own `turn_started` ends an `unreported` wait (back to `working`).
- [ ] `lead_gone` starts the next attempt, at most two per Issue; then the Issue parks with a health line and one notification.
- [ ] The Stop send-back (`issues/sendback.ts`) is skipped while the Stop input's `background_tasks` lists a running subagent;
  the hook (`packages/cli/src/hook.ts`, zod-free) carries the field through the spool.
- [ ] A red verify is re-run once before it counts as a regression; the third regression of one Issue parks it.
- [ ] Tests per rule; live proof with a scratch Issue whose lead is killed once.
**Left behind:**

## Wave 4 — The lead (row 5)            <!-- status: pending -->
- [ ] `brief.ts`: the operating contract of design v3 §3 as the brief's fixed part, with the exact CLI syntax (`--phase`, `--question`).
- [ ] `config/roles.json`: `lead` → sonnet/high (keep every other role until Wave 8 of the design's order).
- [ ] Lead cap per account (`FACTORY_LEADS_PER_ACCOUNT`, default 2) in admission, counted over live lead sessions.
- [ ] `SessionStart(compact)` re-injection: the hook names the Issue; the brief says to re-read it after a compaction.
- [ ] Live proof: a small real Issue (pick one from the owner's backlog in `docs/program.md`, or a docs fix) runs end to end
  on Sonnet high with zero owner touch; record wall time, attempts, review tier, window points.
**Left behind:**

## Wave 5 — Asks vs parks, the health line (row 6)            <!-- status: pending -->
- [ ] `/fleet` and `factory status`: asks are `decision` and `blocked` waits, the human queue and `hc` permission prompts;
  parks and the rest go to a health line (design v3 §6: park with reason and age, no hook event for 20 min while working,
  working past the size budget, regression count 2).
- [ ] The sidebar (`dotfiles` board, `config/herdr-app/mods/jk-board`) shows the health line under the asks.
- [ ] A Kuma push heartbeat "tick advanced and the queue moved within 30 min" (homelab `uptime-kuma/monitors.yaml`), and
  `make rollback` documented and tested once with `DRY_RUN=1`.
- [ ] Live proof: the counts before and after; every remaining ask is a decision.
**Repos:** dotfiles, homelab
**Left behind:**

## Wave 6 — Spaces (row 11)            <!-- status: pending -->
- [ ] `~/.config/factory/spaces.json` (ordered `{name, path}`), written by dotfiles `make setup` from a tracked list.
- [ ] The factory reconciles on start and every 10 min: one space per entry by real path, in order, a first tab with
  `factory.key=plan:<repo>` (a login shell), never closed; unknown repos appended on first use.
- [ ] hc-reap and finalize never touch a `plan:` tab or a tab without `factory.key`.
- [ ] Live proof: the app shows every space in order with its `plan` tab; a second reconcile changes nothing.
**Repos:** dotfiles
**Left behind:**

## Wave 7 — `issue_facts` (row 12, the view)            <!-- status: pending -->
- [ ] Migration: the view `factory.issue_facts` over issues, issue_events, evidence, decisions and sessions (design v3 §11);
  no read of `usage.*`.
- [ ] `factory issue facts [--since]` prints it; the four KPIs of §11 computed from it in one query.
- [ ] Live proof: the rows for every Issue since 2026-11-01, and the KPI line.
**Left behind:**

## Stop for the owner

The next rows change the machinery this loop itself runs on (dotfiles `rd`, `/wave`, `wave-gate.py`, hc-reap: row 7) and
then delete server code (rows 8–9). They start after the owner has read the night's learnings. Write the stop into the last
wave's **Left behind** and the handoff.
