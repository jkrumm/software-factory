Branch: reset-w6-dotfiles
Title: feat(setup): ~/.config/factory/spaces.json from groups.json; hc-reap leaves plan tabs and the owner's keyless terminals alone
Owned files: a new `scripts/factory-spaces.py` (or `.sh`), `Makefile` (one `_setup-factory-spaces` step called from `setup`, and its test target added to `check`), `scripts/factory-spaces.test.py`, `scripts/hc-reap.py`, `scripts/hc-reap.test.py`, the docs naming hc-reap's rules or `make setup`'s steps (grep `hc-reap` and `_setup-` in `docs/`, `AGENTS.md`). Never: `config/herdr-app/groups.json` (read only), `rd`, `wave-gate.py`, the `/wave` skill, the board, anything of software-factory.

# Brief: reset row 11, the dotfiles half — the space list and a reaper that keeps plan tabs

Read `AGENTS.md` first. Context: software-factory (`~/SourceRoot/software-factory`, design `docs/strategy/2026-11-reset/design-v3.md`
§8, decision RS6) now keeps one space per listed repo with a first tab labelled `factory.key=plan:<repo>` (a login shell the owner starts
a planner in), never closed. It reads `~/.config/factory/spaces.json`: `{ "spaces": [{ "name": "<repo>", "path": "<absolute path>" }] }`.
The factory never reorders spaces: the sidebar order is `config/herdr-app/groups.json` (the `jk-spaces` mod), which stays the one list.

## 1. `spaces.json` from `groups.json`

A script renders `~/.config/factory/spaces.json` from `config/herdr-app/groups.json`: every group's `members` in order, each resolved to
`~/SourceRoot/<name>` if that directory exists, else `~/WorkRoot/<name>` if it exists, else skipped (the factory skips WorkRoot paths itself;
listing them is fine). Duplicates once. Written atomically (temp file + rename), mode 0644, the directory created; a run that would write
the same bytes does not touch the file. `make setup` calls it as one `_setup-factory-spaces` step (the `_setup-*` pattern, Makefile:75-115).
A hermetic test (temp HOME, a fixture groups.json, fake repo dirs): order kept, missing skipped, WorkRoot fallback, idempotent; add it to
`check`.

## 2. hc-reap never touches a plan tab or a keyless terminal

`scripts/hc-reap.py` today reaps agents idle 12 h (clean, pushed) and merged fan branches, by `is_agent` (`:355-356`) and the keep checks
(`:439-489`); it knows nothing of `factory.key`. Change, in the keep checks (first, before any other rule): a terminal whose labels have a
`factory.key` starting `plan:` is kept, and a terminal with no `factory.key` label at all is kept (the owner's own sessions; design v3 §8,
§9). Read how hc-reap gets labels (`hc` JSON) and use the same source. The `claude --bg` rule (24 h) is unchanged. Tests in
`hc-reap.test.py`: a `plan:` terminal idle for days is kept, a keyless idle one is kept, a keyed fan worker that is merged is still
reaped. Update the docs that list hc-reap's rules.

## Validation

`python3 -m py_compile` on the scripts, `make hc-reap-test`, the new test target, `make secrets-lint`; `make check` is known red on
`architecture-check` from other work (three launchd labels); run it with `-k` and report every other target's result. Run the render once
for real and show the resulting file's first entries. Finish: commit, push `reset-w6-dotfiles`, open a ready PR. Report the PR URL,
validation output verbatim, and what you left out. Never touch files outside "Owned files". Never end a turn on a background shell or a wait.
