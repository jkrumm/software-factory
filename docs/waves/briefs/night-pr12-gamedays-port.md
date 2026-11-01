Branch: f1-gamedays-hc
Title: docs(evidence): F1's last two gamedays, ported to the herdr-core runner
Owned files: `docs/evidence/f1-gamedays/**`, `scripts/gameday/**`, `packages/server/test/restore.test.ts`, `docs/waves/f1.md` (only if it points at these). Never: `packages/server/src/**`, `packages/server/test/support/**`, `AGENTS.md`, `docs/waves/PLAN.md`, `docs/program.md`, `docs/evidence/night-*`.

# Brief: port PR #12 onto the herdr-core runner

PR #12 (`origin/f1-w6-gamedays`, 8 commits, green, 29 commits behind) holds F1's two gamedays: a killed server and a restored
database. It was built on the classic `HerdrRunner` and `herdr` CLI, both gone. F2's gate (Wave 6) reuses its scripts, so port it
instead of losing it. Read `AGENTS.md` ("The runner looks before it acts") and `docs/evidence/f1-gamedays/README.md` on that
branch first.

1. New branch from fetched `origin/master`, the PR's files taken over as they are (one squashed commit keeps the history small;
   the PR body's verdicts go in its message).
2. `packages/server/test/restore.test.ts`: on `HcRunner` and `packages/server/test/support/fake-hc.ts` (`hc-runner.ts`, `hc.ts`).
   The three `test.failing` pins keep failing for their stated reasons, or, if the runner's look-before-it-acts fixed one, it
   becomes a plain passing test and the README says so. That verdict is the point of the port.
3. `scripts/gameday/*.sh`: `herdr tab|pane|agent` calls become `hc` (`hc --help`; `terminal.list`/labels: `factory.key=<key>`).
   `when-child.sh` watches the server's child processes: the server now runs `hc connect` per JSON-RPC call, so the two moments
   `claimed` and `prompt` collapse to one (prompt is `terminal.run`'s last argument, nothing is typed at start). Keep `claimed`
   and `working`; drop `prompt` and say why in the README. `bash -n` and shellcheck clean. Do not run them against the live server.
4. `docs/evidence/f1-gamedays/README.md`: a header paragraph: the evidence was recorded against the classic runner on
   2026-10-30, the test and the scripts were ported on 2026-11-01, what that does and does not prove.

**Validation:** `bun test packages/server/test/restore.test.ts`, then `make check` (through `factory slot run` as `make test` does
already). **Wait for everything in the foreground:** never end a turn on a background shell, a sleep or a "waiting for X"; the
factory reads your idle prompt as finished and wakes the lead. Push the branch, open a PR (`gh pr create`, no attribution, body
says it replaces #12), don't merge. End with a report: done / deferred, one line each, and the verdict on each of the three pins.
