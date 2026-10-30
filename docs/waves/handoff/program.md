# Program lead handoff

Written at the end of rotation 1, 2026-10-30. State lives in `docs/program.md`; this page holds what that table does not.

## Running now (rotation 2 stopped on the usage limit, 11:10)

| Agent | Repo | State | Next |
|-|-|-|-|
| `argo-w1` | argo | A1 Wave 1, working on `me2` | Review its close-out; it names the `shared` target F1 Wave 1 needs |
| `agent-workflows-w1` | agent-workflows | I1 Wave 1 finished its turn but hit `me`'s 5-hour wall mid-close-out; plan still `active`, tree clean | After 12:40 check it closed out (PLAN flip, push); type "continue" if not. Then review, spawn I1 Wave 2 (R0 is done) |

Rotation 2 done: R0 closed, track D done (one-line `agent-workflows/docs/factory-input.md` repoint still open, exact edit in
`dotfiles/docs/waves/PLAN.md` Left behind), F0 done (skeleton PR #1 merged), F1 planned in `docs/waves/f1.md`.

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
