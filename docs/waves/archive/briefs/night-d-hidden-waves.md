Branch: night-d-hidden-waves
Title: feat(runner): a spawn asked for as a child is its parent's hidden child, whatever its role
Owned files: `packages/server/src/hc-runner.ts`, the spawn input in `packages/server/src/schemas.ts`/`spawns.ts`/`http.ts`/`socket.ts`, `packages/contract/src/spawn*.ts`, `packages/cli/**` (`spawn create --placement`), `packages/server/test/**`, `AGENTS.md` (pointer line), `docs/design.md` §3. In a dotfiles worktree of fetched `origin/master`: `scripts/remote-dev.sh`, the `jk-board` mod, `skills/wave/**`, their tests. Never: `docs/waves/PLAN.md`, `docs/program.md`, `docs/evidence/**`, anything under `packages/server/src/issues/`.

# Brief: D, hidden orchestrated waves (owner decision 5, 2026-11-01)

Read `AGENTS.md` ("The runner looks before it acts": tab vs worker placement) and `docs/waves/night-2026-11-01.md` first.

**Today:** a `worker`/`mechanical`/`deep` spawn with a parent terminal is its hidden child; every other role is a tab. A night of
an orchestrator plus its waves and their workers is 15+ tabs, and the hidden workers show nowhere (the jk layout replaces the
app's `agents` mod).

**Wanted:** orchestrated waves (a mother's leads, a lead's waves) are hidden children of the orchestrator's terminal; chain
waves and an orchestrator's own successor stay tabs. Who spawned it cannot tell those apart (a lead spawns both its waves
and its successor), so the caller says it:

1. **Factory:** `POST /spawns` (token and socket) takes `placement: "tab" | "child"`, optional; the default is today's rule
   (worker roles child, others tab). `child` with no parent terminal, or a parent that is gone, is a tab (as for a worker
   today). Stored on the row and part of the idempotent replay. `factory spawn create --placement tab|child`. Tests with the
   hc fake for each role × placement, and that a child of any role gets `outlive_parent`, `no_notify` and no tab label.
2. **dotfiles `rd`** (its own worktree, never the dotfiles checkout): `rd wave --child` and `rd fan` unchanged (workers are
   children already); `--child` passes `placement: child` and in the direct-to-hc fallback runs the terminal as a child of
   `$HC_TERMINAL_ID`. The `/wave` skill's orchestrated mode (`skills/wave/SKILL.md`, `roles/mother.md`, `roles/lead.md`) uses
   `--child` for the waves an orchestrator spawns, never for its own successor.
3. **dotfiles `jk-board`:** each tab row lists its hidden children as a tree (name, status, turn), read from hc
   (`terminal.list` with `parent`), and a child's last lines on demand through `terminal.peek`. Keep the board's current refresh.
   Find the mod with `grep -rn jk-board ~/SourceRoot/dotfiles --include=*.json -l`.

Two halves, two PRs. The factory half goes live first (an `rd --child` against an older server would be refused as an unknown
field, or ignored: say which, and make rd fall back to a tab on that error). **Gate:** `make check` green here, the touched
dotfiles suites green, `/review` on both diffs with findings fixed, one more `/review` pass on the fix commits. **Wait for every
review run in the foreground** (`agw run wait <runId>`). Push both branches, open both PRs, don't merge or deploy. Report: done
/ deferred, one line each, and the go-live order.
