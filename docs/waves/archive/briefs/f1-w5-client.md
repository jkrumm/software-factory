Branch: f1-w5-client
Title: feat: one space per repo, test slots, panes as clients
Owned files: everything in this worktree except `docs/decisions.md`, `docs/program.md`, `docs/design.md`, `docs/research/**`, `docs/spikes/**`, `docs/evidence/**`, `docs/waves/**` (read them, never edit).
Task:
F1 Wave 5 of `docs/waves/f1.md`, the software-factory half. Read `AGENTS.md`, `docs/design.md` §3 ("One space per repo", "Test slots", "`rd` becomes a client"), `docs/decisions.md` FL6, FL7 and SF11, and Waves 1–4's Left behind in `docs/waves/f1.md` first. The server is live (`make deploy|verify`). Lint and format are oxlint and oxfmt (`make fmt`, `make check`).

A dotfiles worker (`f1-w5-rd`) builds `rd` on top of this in parallel, against the CLI contract below. Keep every name and flag exactly as written; if one cannot work, stop and say why instead of renaming it.

1. **One space per repo (FL6).** The Runner resolves the herdr space by the spawn's `space` path (realpath), never by directory name: two repos with the same basename get two spaces, a second spawn in a repo gets a new tab in its existing space. `space` defaults to `repo`; a fan worker's worktree passes its main checkout as `space`, so its tab lands in the repo's space. A new space for a path that already has one only with `new_space: true`. Fake-herdr tests for each case.
2. **Test slots (FL7).** `factory slot run [--name <label>] -- <cmd> [args…]`: a leased row in `factory.slots` (new migration), `FACTORY_SLOTS` slots (default 2), the lease renewed while the command runs and released on exit or signal; an expired lease frees its slot. It goes over the socket (no token), so any pane and `make` can use it. Fail open: server down, or no slot within `FACTORY_SLOT_WAIT_MS` (default 600000), runs the command anyway with one stderr line. Exit code, stdout and stderr are the command's own. This repo's `make check` runs its test step through it (falling back to the bare command when `factory` is not on PATH, e.g. in CI).
3. **Panes are clients (SF11).** Over the socket: `POST /spawns` with the same body, validation and `FACTORY_REPO_ROOTS` check as the HTTP route, the parent taken from the caller's `FACTORY_SESSION` (sent by the CLI). `factory spawn create` uses the token when `FACTORY_TOKEN` is set and the socket otherwise. Update AGENTS.md's socket paragraph (what it serves now).
4. **The contract `rd` uses** (all `--format json|plain`, agw's exit codes):
   - `factory spawn create <key> --repo <path> --prompt <text> [--role <role>] [--parent <session>] [--space <path>] [--new-space]`: idempotent by key (a second create with the same key answers the existing spawn, exit 0).
   - `factory spawn get <key>`: the spawn's row: state (`queued|held|claimed|started|failed`…), hold reason, account, pane, tab, session.
   - `factory session get <id>`: already there; must include the pane and tab ids.
   - `factory queue get --project <path>`: already there; must include the effective state.
   - `FACTORY_ROLE` in a pane's environment is recorded as the session's role at `session_started` (the hook reads it; the Runner sets it for its own spawns), so the one-active-wave-per-repo rule counts `rd` sessions too.
   Pin the JSON shapes in `packages/contract` and list them in the PR body: the dotfiles worker reads them.
Each item gets a test that would fail on today's code.

Deploy from the branch (`FACTORY_REF=f1-w5-client make deploy && make verify`) and prove live: `factory slot run -- sleep 5` twice in parallel plus a third waits; `factory spawn create` from a pane without `FACTORY_TOKEN` (an `env -u FACTORY_TOKEN` shell with `FACTORY_SESSION` set) queues a throwaway spawn with that parent, and `factory spawn get` shows it started in the repo's existing space. Close the throwaway tab afterwards.
Validation: `make check` (foreground; check `uptime`, it flakes above load ~40).
Finish: commit per logical concern, push `f1-w5-client`, open a ready PR, run `/review` and fix its blocking findings, re-run `/review` on the fix commits until it has no blocking finding, wait for CI in the foreground with `timeout`. Report the PR URL, `make check` and `make verify` output verbatim, the live proof and the contract's JSON shapes. Do not merge.
Never touch files outside "Owned files". If the task needs one, stop and say which file and why.
