# Rewrite state

**The orchestrator's ledger: one row per package of `docs/rewrite.md`.** Read with `docs/rewrite.md` after every start or
compaction, before acting. Updated on every start, integration and send-back.

- Branch `rewrite`, made from master at `a3065ce` on 2026-11-07. Master's checkout and the running factory stay untouched.
- Worker worktrees: `../rw-<n>-<slug>` beside this one (under the main checkout's `.claude/worktrees/`), branch
  `rw/<n>-<slug>` off `rewrite`. Briefs: `docs/rewrite/briefs/<n>-<slug>.md`. Reports: `docs/rewrite/reports/<n>-<slug>.md`.
- Status words: `pending`, `running`, `sent back`, `integrated`.

| # | Package | After | Status | Terminal | Branch | Last commit | Evidence |
|-|-|-|-|-|-|-|-|
| 0 | Skeleton | | pending | | | | |
| 1 | Kernel and work | 0 | pending | | | | |
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
