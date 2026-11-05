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

## Wave 2 — Dependencies (row 3)            <!-- status: done -->
- [x] `factory issue new --after <id>` (repeatable) writes `issue_deps` in the create transaction; an unknown or closed id is refused.
- [x] Admission (`issues/admission.ts`) admits only Issues with no open dependency; `releaseDependents` on close stays.
- [x] `factory issue prio <id> <n>` writes the `prio` event; admission orders by the latest priority, then id.
- [x] Tests at the lifecycle and admission level; design.md §4 "As built" and AGENTS.md updated in the same commit.
- [x] Live proof: two scratch Issues, B `--after` A; B stays queued until A closes.
**Left behind:** PR #37 merged (`7e616c0`, `272be2f`), deployed `272be2fb1429`, verify green; deep review clean (1 nit fixed), `covered` true. Proof: Issue 60 `--after 59` admitted 6 s after 59 closed; `--after 58` (closed) exit 2. Found: a lead has no no-change end (Wave 4 step 1 now names it).

## Wave 3 — Parks end (row 4)            <!-- status: done -->
- [x] The lead's own `turn_started` ends an `unreported` wait (back to `working`).
- [x] `lead_gone` starts the next attempt, at most two per Issue; then the Issue parks with a health line and one notification.
- [x] The Stop send-back (`issues/sendback.ts`) is skipped while the Stop input's `background_tasks` lists a running subagent;
  the hook (`packages/cli/src/hook.ts`, zod-free) carries the field through the spool.
- [x] A red verify is re-run once before it counts as a regression; the third regression of one Issue parks it.
- [x] Tests per rule; live proof with a scratch Issue whose lead is killed once.
**Left behind:** PR #38 (`3c9b5c0`..`c868256`) and the follow-up PR #39 (`afa38a9`), deployed `a2c4293f559a`, verify green, `covered` true. Proof: a killed lead restarts the Issue after a 10-minute grace with no note (Issue 63), a note finds it at once (Issue 62); attempt 2 carries the owner's note. The `background_tasks` field is real (Claude Code 2.1.318 Stop schema); finished entries do not count. Machine: an IuRoot test storm (load 558) took the server down twice; it recovered by itself (learnings).

## Wave 4 — The lead (row 5)            <!-- status: done -->
- [x] `brief.ts`: the operating contract of design v3 §3 as the brief's fixed part, with the exact CLI syntax (`--phase`, `--question`),
  and the no-change end: work that needs no commit ends with `factory issue drop <id> --reason`, never an ask or a made-up commit (learnings, Wave 2).
- [x] `config/roles.json`: `lead` → sonnet/high (keep every other role until Wave 8 of the design's order).
- [x] Lead cap per account (`FACTORY_LEADS_PER_ACCOUNT`, default 2) in admission, counted over live lead sessions.
- [x] `SessionStart(compact)` re-injection: the hook names the Issue; the brief says to re-read it after a compaction.
- [x] Live proof: a small real Issue (pick one from the owner's backlog in `docs/program.md`, or a docs fix) runs end to end
  on Sonnet high with zero owner touch; record wall time, attempts, review tier, window points.
**Left behind:** PR #40 (`29530e2`, `4a93d6b`) landed as a fast-forward, deployed `4a93d6b3da21`, verify green, deep review clean (3 nits: 2 fixed, 1 intentional), `covered` true. The lead cap waits (30 s recheck) instead of a `lead_cap` hold (the reasons are a CHECK constraint); "asking again replaces the question" is not built and not claimed. Proof: Issue 64 (the hc-spaces flake) ran on Sonnet high, found a real race in `HcRunner.start` (PR #41, deep review, deployed `7245836`), shipped in 16 min, 1 attempt, 0 owner touches; window points not attributable yet. The shared Postgres died under the run (Colima VM), recovered by `make colima-restart` (learnings).

## Wave 5 — Asks vs parks, the health line (row 6)            <!-- status: done -->
- [x] `/fleet` and `factory status`: asks are `decision` and `blocked` waits, the human queue and `hc` permission prompts;
  parks and the rest go to a health line (design v3 §6: park with reason and age, no hook event for 20 min while working,
  working past the size budget, regression count 2).
- [x] The sidebar (`dotfiles` board, `config/herdr-app/mods/jk-board`) shows the health line under the asks.
- [x] A Kuma push heartbeat "tick advanced and the queue moved within 30 min" (homelab `uptime-kuma/monitors.yaml`), and
  `make rollback` documented and tested once with `DRY_RUN=1`.
- [x] Live proof: the counts before and after; every remaining ask is a decision.
**Repos:** dotfiles, homelab
**Left behind:** software-factory PR #42 (`5e8d49d`, `c7081b8`, deep then standard, `covered`), deployed `c7081b8615c0`; dotfiles #61 (`3cc0248`), homelab #19 (`055d9cd`, Kuma `Software Factory - Push` id 269, the URL file on the mini). `factory status`: 7 asks before, 0 asks and 7 health lines after; `/fleet` asks are the human queue plus one digest `reply` (goes in row 8). Heartbeat live (pusher `✓ factory monitor`). `make rollback` tested with `DRY_RUN=1` only. The board's HEALTH section is not seen in the app yet. Found: a docs-only master commit turns a hold's `make verify` red (Issue 66 fixes it; until then no master push during a hold).

## Wave 6 — Spaces (row 11)            <!-- status: done -->
- [x] `~/.config/factory/spaces.json` (`{name, path}`), written by dotfiles `make setup` from `config/herdr-app/groups.json` (the one list; it already orders the sidebar through `jk-spaces`, so the factory never reorders the app doc). Briefs `briefs/reset-w6-spaces.md`, `briefs/reset-w6-dotfiles.md`.
- [x] The factory reconciles on start and every 10 min: one space per entry by real path (inside `FACTORY_REPO_ROOTS`), a first tab with
  `factory.key=plan:<repo>` (a login shell), never closed; unknown repos appended on first use.
- [x] hc-reap and finalize never touch a `plan:` tab or a tab without `factory.key`.
- [x] Live proof: every listed space has its `plan` tab (`hc` labels; the app's order is `groups.json`'s); a second reconcile changes nothing.
**Repos:** dotfiles
**Left behind:** software-factory PR #44 (`ba7984a`, `ed17547`, deep, nit fixed, `covered`), deployed `ed175476713c`, verify green; dotfiles #62 (`241d7c8`, standard, clean, `covered`), `make deploy` done. Proof: 40 `plan:` login shells (`t13t`..`t153`), one per `spaces.json` entry incl. the 8 IuRoot ones (`FACTORY_REPO_ROOTS` defaults to both workspaces; the briefs were wrong to say IuRoot is skipped); the second pass changed nothing. Gaps: in a space that had tabs the plan tab is last, not first (no tab moves); the app's `agent-workflows` and `epos-ai-teamchat-athena` spaces have folder `~/IuRoot`, so the reconcile seeded correct ones beside them and the sidebar shows both twice until the owner closes the old ones; the app was not connected at the proof, so the sidebar is not seen yet.

## Wave 7 — `issue_facts` (row 12, the view)            <!-- status: active -->
- [ ] Migration: the view `factory.issue_facts` over issues, issue_events, evidence, decisions and sessions (design v3 §11);
  no read of `usage.*`. Brief `briefs/reset-w7-issue-facts.md`.
- [ ] `factory issue facts [--since]` prints it; the four KPIs of §11 computed from it in one query.
- [ ] Live proof: the rows for every Issue since 2026-11-01, and the KPI line.
**Left behind:**

## Stop for the owner

The next rows change the machinery this loop itself runs on (dotfiles `rd`, `/wave`, `wave-gate.py`, hc-reap: row 7) and
then delete server code (rows 8–9). They start after the owner has read the night's learnings. Write the stop into the last
wave's **Left behind** and the handoff.
