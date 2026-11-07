# Rewrite state

**The orchestrator's ledger: one row per package of `docs/rewrite.md`.** Read with `docs/rewrite.md` after every start or
compaction, before acting. Updated on every start, integration and send-back.

- Branch `rewrite`, made from master at `a3065ce` on 2026-11-07. Master's checkout and the running factory stay untouched.
- Worker worktrees: `../rw-<n>-<slug>` beside this one (under the main checkout's `.claude/worktrees/`), branch
  `rw/<n>-<slug>` off `rewrite`. Briefs: `docs/rewrite/briefs/<n>-<slug>.md`. Reports: `docs/rewrite/reports/<n>-<slug>.md`.
- Watching: a background `hc wait <terminal>` per running worker (wakes on any turn end) plus a session cron at :17 and
  :47 that reads every running worker's screen and steers. Both die with the session: re-arm them after a restart.
- Start a worker with the account dir checked, never a bare `eval`:
  `DIR=$(claude-account pick --lane lead | sed -n "s/^export CLAUDE_CONFIG_DIR='\(.*\)'$/\1/p"); test -d "$DIR"`, then
  `hc run ... -- env CLAUDE_CONFIG_DIR="$DIR" claude ...`. `unset CLAUDE_CONFIG_DIR` is the picker spilling to the work
  account (`--why` says `picked=iu reason=spill`): never start on it; re-pick, and if only spill comes back, wait.
- Status words: `pending`, `running`, `sent back`, `integrated`.

| # | Package | After | Status | Terminal | Branch | Last commit | Evidence |
|-|-|-|-|-|-|-|-|
| 0 | Skeleton | | integrated | t1f1 (removed) | `rw/0-skeleton` (merged, deleted) | 7e6163b (merge), d36d1d5 | `reports/0-skeleton.md`; `make check` on `rewrite` after merge: 83 unit, 6 scenarios pass; rd dry run via the new CLI (worker's evidence) |
| 1 | Kernel and work | 0 | integrated | t1f4 (removed) | `rw/1-kernel-work` (merged, deleted) | fc5a8ac (merge), 9534b98 | `reports/1-kernel-work.md`; `make check` on `rewrite` after merge: 124 unit, 10 scenarios |
| 2 | Intake | 1 | integrated | t1f7 (removed) | `rw/2-intake` (merged, deleted) | df0862a (merge), 8dfda67 | `reports/2-intake.md`; `make check` on `rewrite`: 559 unit, 49 scenarios |
| 3 | Planning and capacity | 1 | integrated | t1f5 (removed) | `rw/3-planning-capacity` (merged, deleted) | 1e84834 (merge), 441c93c | `reports/3-planning-capacity.md`; `make check` on `rewrite`: 721 unit, 85 scenarios |
| 4 | Leads | 1 | integrated | t1f8 (removed) | `rw/4-leads` (merged, deleted) | 3478091 (merge), 650be3a | `reports/4-leads.md`; `make check` on `rewrite`: 336 unit, 37 scenarios; five shared-file conflicts resolved as unions |
| 5 | Quality | 1 | integrated | t1f9 (removed) | `rw/5-quality` (merged, deleted) | e1390ff (merge), bb10eef | `reports/5-quality.md`; `make check` on `rewrite`: 624 unit, 62 scenarios; one outbox runner, real checkout |
| 6 | Checkpoints | 1 | integrated | t1f6 (removed) | `rw/6-checkpoints` (merged, deleted) | 1e5b694 (merge), 4ab823f | `reports/6-checkpoints.md`; `make check` on `rewrite`: 183 unit, 20 scenarios |
| 7 | Loops and agw | 2, 6 | integrated | t1fc (removed) | `rw/7-loops-agw` (merged, deleted) | f637cef (merge), b49162b; agent-workflows 97dac43 deployed | `reports/7-loops-agw.md`; `make check` on `rewrite`: 759 unit, 98 scenarios; six live agw calls in the report; `agw factory-{steward,triage,ask}` answer on the mini |
| 8 | API, read models, CLI parity | 2 to 7 | pending | | | | |
| 9 | Cutover | 8 | pending | | | | |

## Log

- 2026-11-07: ledger opened.
- 2026-11-07: package 0 started in t1f1, worktree `../rw-0-skeleton`.
- 2026-11-07: package 0 integrated at 7e6163b; `make check` green on `rewrite`; worker removed.
- 2026-11-07: package 1 started; first start (t1f3) had an empty CLAUDE_CONFIG_DIR, killed; restarted as t1f4.
- 2026-11-07: package 1 reported (121 unit, 10 scenarios); sent back for numbered Issue ids and the .begin rule.
- 2026-11-07: package 1 integrated at fc5a8ac; packages 2 to 6 started in parallel (t1f7, t1f5, t1f8, t1f9, t1f6).
- 2026-11-07: package 6 integrated at 1e5b694; workers 2 to 5 told to use `--thread rw-<package>` for reviews.
- 2026-11-07: package 4 integrated at 3478091.
- 2026-11-07: package 5 reported; sent back for the integration with package 4.
- 2026-11-07: package 2 integrated at df0862a; package 3 sent back for its wiring into 2, 4 and 6.
- 2026-11-07: package 5 integrated; package 3 still wiring; package 7 briefed, starts after 3.
- 2026-11-07: package 3 integrated at 1e84834; packages 0 to 6 done.
- 2026-11-07: package 7 started in t1fc.
- 2026-11-07: package 7 integrated at f637cef; agent-workflows' red master test filed as factory Issue 292 (old core).
