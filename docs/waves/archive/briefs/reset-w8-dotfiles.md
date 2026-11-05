# Reset Wave 8 — dotfiles: the Issue path beside the wave path (row 7, expand)

**Repo:** `~/SourceRoot/dotfiles` (direct to master; work on branch `reset-w8-issue-path` in a worktree
`~/SourceRoot/dotfiles/.claude/worktrees/reset-w8-issue-path`; push the branch, never merge it: the program lead reviews and lands).
**Read first:** dotfiles `AGENTS.md`; software-factory `docs/strategy/2026-11-reset/design-v3.md` §1 (words), §3 (the lead), §8 (spaces,
closing), §12 (What goes, the dotfiles row); `docs/decisions.md` RS1, RS4, RS10.

## Why expand first

Row 7 of design v3 ends `rd wave|fan|merge|close`, `wave-gate.py` and hc-reap's agent rules. Six repos have a wave marked active
in `docs/waves/PLAN.md`; iris runs one right now on `rd wave --child`, `rd fan` and `rd merge`. So this wave **adds** the Issue path and
makes it the documented default; it removes nothing a running chain uses. The contract (the deletions) is the next wave, after the
running chains are converted.

## The change

1. **`rd issue <repo> <title> [--facts @file|-] [--after <id> …] [--key <key>]`** in `scripts/remote-dev.sh`: a thin `factory issue new`
   on the host (the same `factory_host` path and timeout as the other factory calls), under `secrets-run run --env-file=<software-factory>/.env.tpl`
   or the socket, whichever `factory spawn create` already uses there. Prints the factory's line; exit codes passed through. No hc
   fallback: no factory, no Issue (exit with the factory's code and a one-line message). `rd issues` lists (`factory issue list`).
   Usage text and `docs/remote-dev.md` updated.
2. **Deprecation, not removal:** `rd wave`, `rd fan`, `rd merge` print one stderr line `rd <cmd>: deprecated, file an Issue (rd issue); goes
   with reset row 7 contract` and then work exactly as today. `rd work`, `agents`, `read`, `say`, `repos`, `reap`, `close` unchanged.
3. **`/wave` skill → the plan playbook** (`skills/wave/SKILL.md`): the primary section becomes "turn a plan into Issues": each wave or
   step one `rd issue` / `factory issue new` with facts (what, why, acceptance), order by `--after` and `factory issue prio`, follow with
   `factory issue list|show` and `factory status`, answer asks with `factory issue answer`, note with `factory issue note`; the lead of
   each Issue is the factory's (its brief is software-factory `brief.ts`), so the skill never spawns a terminal. The chain and orchestrated
   modes and `roles/{lead,mother,worker}.md` move under a "Legacy (until row 7 contract)" heading, unchanged in substance. The skill's
   description line says Issues first.
4. **hc-reap: the orphaned-shell rule** (`scripts/hc-reap.py`): a terminal with no `factory.key` label, no name, whose program and
   foreground are a login shell, no Claude session label, and no activity for 7 days (use whatever activity time `hc get`/`hc ls` exposes;
   say which) is closed (`hc kill` + `hc rm`). `plan:` tabs and named terminals are never touched. Behind the existing `--dry-run`; tests
   in `hc-reap.test.py`. The agent rules stay for now.
5. **Docs that route work** point at the Issue path first: `config/global.CLAUDE.md` lanes table (add a row "Work for a repo that should
   ship on its own → `rd issue` / `factory issue new`; the factory's lead builds, reviews, deploys and verifies"; keep the others),
   dotfiles `AGENTS.md` where it names `rd wave`, `docs/agent-platform.md` lanes. No sweep beyond that (row 16 is the docs sweep).

## Not in this wave

Deleting anything; `wave-gate.py`; the Herdr board mod; other repos' handoffs; software-factory code.

## Acceptance

- `make check` green in the worktree (one run; on a failure in a file you did not touch, rerun that target alone and record it).
- New tests: `rd issue` against the fake factory (filed, factory down → no hc fallback, exit code passed through), the deprecation line
  for `wave|fan|merge` (stderr only, stdout unchanged), the hc-reap shell rule (closes the 7-day keyless shell, keeps a `plan:` tab, a
  named shell, a shell with a Claude label, a shell running a program).
- A live dry run: `scripts/hc-reap.py --dry-run` on the mini lists what the shell rule would close (paste it in the report).
- Report: the branch, the commits, the test count, the dry-run output, and every place you deviated from this brief and why.
