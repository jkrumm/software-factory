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
  `hc run ... -- env CLAUDE_CONFIG_DIR="$DIR" claude ...`.
- Status words: `pending`, `running`, `sent back`, `integrated`.

| # | Package | After | Status | Terminal | Branch | Last commit | Evidence |
|-|-|-|-|-|-|-|-|
| 0 | Skeleton | | integrated | t1f1 (removed) | `rw/0-skeleton` (merged, deleted) | 7e6163b (merge), d36d1d5 | `reports/0-skeleton.md`; `make check` on `rewrite` after merge: 83 unit, 6 scenarios pass; rd dry run via the new CLI (worker's evidence) |
| 1 | Kernel and work | 0 | sent back | t1f4 `rw-1-kernel-work` (opus high, account me) | `rw/1-kernel-work` | 58f7abc (report) | report `reports/1-kernel-work.md`; sent back for issue_<n> ids and the tighter .begin rule |
| 2 | Intake | 1 | pending | | | | |
| 3 | Planning and capacity | 1 | pending | | | | |
| 4 | Leads | 1 | pending | | | | |
| 5 | Quality | 1 | pending | | | | |
| 6 | Checkpoints | 1 | pending | | | | |
| 7 | Loops and agw | 2, 6 | pending | | | | |
| 8 | API, read models, CLI parity | 2 to 7 | pending | | | | |
| 9 | Cutover | 8 | pending | | | | |

## Log

- 2026-11-07: ledger opened.
- 2026-11-07: package 0 started in t1f1, worktree `../rw-0-skeleton`.
- 2026-11-07: package 0 integrated at 7e6163b; `make check` green on `rewrite`; worker removed.
- 2026-11-07: package 1 started; first start (t1f3) had an empty CLAUDE_CONFIG_DIR, killed; restarted as t1f4.
- 2026-11-07: package 1 reported (121 unit, 10 scenarios); sent back for numbered Issue ids and the .begin rule.
