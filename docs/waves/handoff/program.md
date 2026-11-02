# Program lead handoff

Written by the FV lead (`PLAN.md` Wave 7, rotation `software-factory-w7`), 2026-11-03 01:00. State lives in `docs/program.md` and
`PLAN.md` Wave 7 (one line per landed wave). The previous rotation's page is in git history.

## Running now

| Agent | Repo | Work | Next |
|-|-|-|-|
| `software-factory-fv-w5-reaper` (t9p, hidden child) | software-factory | FV Wave 5, the reaper, PR #36; second fix round (10 findings of the lead's second `/code-review high`, `/tmp/fv-w5-fix2.md` text is in the worker's prompt) | `/code-review high` on its new fix commits in `.claude/worktrees/review-w5` (detached; diff from `302f459`), merge on green CI, `make deploy`, `make verify`, live proof in `dry` (below), `hc kill t9p` |
| Issue leads 48–56 | weatherorb, homelab-private, software-factory, dotfiles | run by the factory | `factory status`; Issue 50's decision answered A (a dedicated tailnet port for Argo, kuma-door's pattern) for 49 and 50 |
| agw mother `agent-workflows-w1-r4` | agent-workflows | decided `agw agents` becomes a `/fleet` client (their Wave 8, after 17) | nothing from us |

## The reaper's live proof (FV Wave 5)

Deployed it runs `FACTORY_REAPER=dry` (default). Read `factory fleet --format plain` REAPER block: every `closed (dry)` entry must be a
worktree session idle 2 h, clean, every commit it made on master, parent not waiting. Check two by hand (`git -C <worktree> log`, `hc get`).
Only then set `FACTORY_REAPER=on` in `~/.config/factory/env` (allowlisted key), `make deploy` (a restart reads it), and watch one pass
close at most 5; the rows show under "Handled for you" in `factory fleet since`. Wrong one: set `dry` again, restart.

## How this lead worked, keep it

- As the previous lead: hidden `rd fan` workers, one server wave at a time, `factory quota refresh` + `get` before each spawn, the lead's own
  `/code-review high` in a detached worktree on every server PR and on each round of fix commits, `gh pr merge --rebase --delete-branch`
  on green CI, `make deploy`, `make verify`, a live proof, `hc kill`.
- **Fix rounds breed bugs.** FV Wave 4 took four rounds (8 + 10 + 9 + 8); round 3's fix (a cursor pinned to the oldest git read) froze the
  cursor. When a round's findings come from the previous fix, send a simplification, not another patch, and read that diff yourself.
- Send review findings with `rd say <worker> "$(cat file)"`, numbered, each with the fix decided. The wake after an `rd say` fires early:
  read the worker's screen (`hc read <pane>`), re-declare `factory session wait --on workers`, end the turn.
- A killed worker still wakes you once (`dead`); collect finished workers with `hc kill` before the wait or the Stop hook refuses.
- dotfiles `make check` is red on `herdr-core-guard-test` while the mini (0.1.15) and MacBook (0.1.16) cores differ (the daily
  `herdr-core-update` converges them); `rd merge --no-check` is right only when that is the one red target. `rd merge` needs a PR.
- The board deploys on the MacBook: `ssh iumac 'cd ~/SourceRoot/dotfiles && git pull --ff-only && make herdr-app-setup'`, proof
  `herdr-app check <mod>` and `herdr-app shot /tmp/x.png` (scp it back and look).

## Open, decide these yourself

- **Budget:** at 01:00 `me2` 55 % (mark 60), `iu` 86 % (mark 90), `me` untouched. The reaper's landing fits; after it, start nothing more
  on `me2` unless `quota get` leaves room for a whole wave plus reviews (a wave has cost 5–8 points with its reviews).
- **FV Wave 5 left:** Hermes answers "what needs me?" from `/fleet` asks (hermes-agent, a worker there; Hermes is token-holding, the
  token goes in its env template, never a tracked file). `agw agents` is agw's (done as a decision). A2 and IR have no plans yet; their
  `docs/program.md` track notes now say they read `/fleet`.
- **Board Wave 2** (dotfiles `docs/waves/fv-board.md`): actions, Apply all, Undo, the away card. Notes for its brief: `caught_up` needs
  `until` (the reading's `until`, `fleet since` prints it); an ask whose repo is a path shows the path (fix: the repo's base name).
- **FV Wave 6, the gate:** needs one real away window after board Wave 3 reports presence (until then the owner is always away).
- Two failed agw spawns (`agent-workflows-seats-on-claude`, `-gateway-opencode`) sit in attention; they are agw's mother's.

## Watch

- Load on the mini runs 25–55; tests time out locally, CI on GitHub is the judge.
- Prompt suggestions in finished workers' input boxes are nobody's words; never act on them.
