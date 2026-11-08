Branch: fv-board-w1
Title: feat(jk-board): the Waves tab reads the factory's fleet view
Owned files: `config/herdr-app/mods/jk-board/**`, the dotfiles `docs/` lines that describe the board's sources, `docs/waves/fv-board.md` (Wave 1's checkbox and status only). Never: anything else in dotfiles, any other repo.

# Brief: the board on `/fleet` (dotfiles, track FV, board Wave 1)

Read dotfiles `AGENTS.md`, `docs/waves/fv-board.md` (Wave 1), `config/herdr-app/mods/jk-board/main.js`, and software-factory's `docs/design.md` §11 "The fleet view" and `packages/contract/src/fleet.ts` (the response shape: `repos[]` with plans, waves, sessions; `asks[]` with tier, suggestion, actions; `errors[]`). The fleet view is live on the mini: run `cd ~/SourceRoot/software-factory && secrets-run run --env-file=.env.tpl -- factory fleet --format json` there to see today's real body before you change anything.

1. **One source.** The Waves tab's poll calls `factory fleet --format json` on the mini the way it calls `factory status` today (`secrets-run run --env-file=.env.tpl --`, the token never in argv), instead of `factory status` plus the `PLAN.md` grep: `PLANS`, `MARK`, `parsePlans` and whatever only they feed go. The hc `ls` for the child tree and the on-demand `hc read` stay as they are (the fleet model has `parent`, use it where it replaces a guess, keep `hc ls` only for what the model lacks).
2. **Layout A:** asks on top (count in the tab badge; each ask one line: its `short` or text cut to one line, its repo, its age; `yours` tier first, then the rest by `at`), then repos with a plan or a live session in the left sidebar's groups as today: the plan's `short` or heading, its state (`running|planned|scheduled|stale|done`), the active wave with its status, sessions with their headline when the model has one. Paused / Planned sections keep their meaning, now from the model's plan state; done plans stay hidden. WorkRoot repos (`visible: true`) show like the others.
3. **Colour:** `theme()` tokens only; `working` and `blocked` are the only hues (owner choice). No hardcoded colours.
4. **Failure:** a poll that fails or answers an `errors[]` keeps the last good view and marks it stale after `STALE_MS`, as today; a source error in `errors[]` is one muted line, never a blank tab.
5. No actions yet (board Wave 2 adds them after the factory's Wave 4), no presence (Wave 3).

**Gate:** `make check` green in dotfiles, `/review` with findings fixed, one more `/review` pass on the fix commits. **Wait for every review run in the foreground** (`agw run wait <runId>`): never end a turn while a background shell runs, the factory reads your idle prompt as finished and wakes the lead. Commit on the branch and push it; don't merge to master or deploy (the lead lands it with `rd merge`, deploys and reloads the mod). End with a report: done / deferred, one line each, and the shell command the lead can run on the mini to reproduce one poll.
