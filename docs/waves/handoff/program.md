# Program lead handoff

Written at the end of rotation 1, 2026-10-30. State lives in `docs/program.md`; this page holds what that table does not.

## Running now

| Agent | Repo | Wave | Next when it closes |
|-|-|-|-|
| `dotfiles-w2` | dotfiles | R0 Wave 2, the last | Review. R0 done unblocks D and I1 Wave 2 |
| `argo-w1` | argo | A1 Wave 1 of 6 | Review, spawn Wave 2. It names the target that creates `shared`; F1's plan uses the same one |
| `agent-workflows-w1` | agent-workflows | I1 Wave 1 of 3 | Review. Wave 2 waits for R0 |

All three are orchestrated: they stop at their close-out and you spawn the next. Review as in `docs/program.md`.

## Watch

- **Account:** `argo-w1` runs on `me2`, 91 % of its week at handoff, reset 11-01 18:00. `me2` still gets picked as a home
  account until 95 %. If a long wave there is about to reach the wall, close it out early and respawn it elsewhere.
- **`me`'s 5-hour window** is at 48 %, reset 11:40, with two waves on it.
- **`rd close` refuses non-`wave <n>` tabs.** `dotfiles-w1`'s tab is named `1`, and the two `fan plain` / `fan effect` tabs
  are left open, finished. `rd reap` will take them. Their worktrees stay until the skeleton is built from `spike/plain`.
- **A suggestion in a prompt box is not a typed prompt.** `/code-review high` sat in the plain worker's input and nobody
  wrote it.

## Decisions taken in this rotation, in case you wonder

- **Plain TypeScript.** The rule decided it; `docs/spikes/2026-10-30-effect/verdict.md`. Do not reopen it.
- **The release-age cooldown stays.** `~/.bunfig.toml` refused `effect@4.1.0`; the spike ran on 4.0.6 instead of adding an
  exclude. Pins in the skeleton must clear it too.
- **The database is named `shared`,** fixed in `docs/design.md` §2, because F1 and A1 both need it first.
- **`usage` owns the session entity,** `factory.sessions` holds what the factory started, joined on the Claude session id.
- **`UserPromptSubmit` is added to FL5's hooks,** as the only proof a typed prompt arrived.
- **The owner's call, not raised:** `jkrumm.com`'s Agent Infrastructure guide still embeds the warden-era diagram. The
  guide's text was left alone; R0 Wave 2 only repairs its `make diagrams` path.
