Branch: f1-w5-rd
Title: feat(rd): wave, fan, say and close go through the factory when it answers
Owned files: `scripts/remote-dev.sh`, `scripts/fan-worktree.sh`, `scripts/wave-gate.py`, `scripts/wave-gate.test.py`, `scripts/remote-dev-*.test.sh`, `scripts/fan.test.sh`, `docs/remote-dev.md`, and the test/shellcheck lines for these files in `Makefile` (no other Makefile change).
Task:
F1 Wave 5 of `~/SourceRoot/software-factory/docs/waves/f1.md`, the dotfiles half. Read that wave, `~/SourceRoot/software-factory/docs/design.md` §3 ("`rd` becomes a client", "One space per repo"), FL1, FL6 and SF11 in `~/SourceRoot/software-factory/docs/decisions.md`, and this repo's `AGENTS.md` first.

A software-factory worker (`f1-w5-client`) adds the server side in parallel. Build against this contract; it is not deployed yet, so tests use a stub `factory` on PATH, as `scripts/remote-dev-factory-env.test.sh` stubs herdr:
- `factory health` (exit 0 = the server answers). Probe it with `timeout 3`; anything else means "not answering".
- `factory spawn create <key> --repo <path> --prompt <text> [--role <role>] [--parent <session>] [--space <path>] [--new-space] --format json`: idempotent by key; works from a pane without `FACTORY_TOKEN` (over the socket); the parent defaults to `$FACTORY_SESSION`.
- `factory spawn get <key> --format json`: `state` (`queued|held|claimed|started|failed`…), hold reason, account, pane, tab, session.
- `factory session get <id> --format json`: state, pane, tab.
- `factory session note <session> <text> [--id <id>]`: held while the session works, typed at its next prompt, confirmed by its next turn.
- `factory queue get --project <path> --format json`: the effective queue state (`run|pace|drain`).
- `FACTORY_ROLE` in a pane's environment becomes the session's role.

1. **`rd wave` and `rd fan`:** when the factory answers, create the spawn (`--role wave|worker` as today's `--role` resolution, key = today's agent name, `--space` = the main checkout for a fan worktree) and wait, bounded (120 s), on `factory spawn get` until `started`; print today's line (agent, space, pane, account). `queued`/`held` → print the hold reason and exit 0 with "queued: <reason>" (the factory starts it later; today `rd` dies with "paused"). `failed` → exit non-zero with the reason. Not answering → today's path, unchanged, plus `FACTORY_ROLE` in the pane's `--env`.
2. **`rd say`:** factory answers → `factory session note <agent> <text>` (the factory holds it while the agent works); otherwise today's path.
3. **`rd close`:** resolve the tab through `factory session get <agent>` (pane → tab), not the tab's name, so a fan tab or a first tab named `1` closes too. Today's refusals stay: agent working, checkout dirty, anything unpushed. Not answering → today's path.
4. **`wave-gate.py`:** refuse to spawn when `factory queue get --project <repo>` says `drain` (message names the scope). Server down → the check is skipped with one stderr line (fail open).
5. Every branch above gets a case in the hermetic suites (stub `factory` answering, holding, failing, absent). `docs/remote-dev.md` says which path `rd` takes when.
A dead factory must never stop the waves that would repair it: every factory call is bounded and falls back.

Validation: the suites you touched (`/bin/bash scripts/remote-dev-wave.test.sh`, `…-say.test.sh`, `…-factory-env.test.sh`, `scripts/fan.test.sh`, `python3 scripts/wave-gate.test.py`) and `make check` (foreground; check `uptime` first).
Finish: commit per logical concern, push `f1-w5-rd`, open a ready PR, run `/review` and fix its blocking findings, re-run `/review` on the fix commits until it has no blocking finding, wait for CI in the foreground with `timeout`. Report the PR URL and the validation output verbatim. Do not merge, and do not live-test against the deployed factory: the lead proves it after both halves land.
Never touch files outside "Owned files". If the task needs one, stop and say which file and why.
