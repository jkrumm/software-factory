Branch: f2-w5-status
Title: feat(status): following leads in factory status (F2 Wave 5)
Owned files: `packages/server/src/status.ts`, `packages/server/src/issues/**` (reads and the note verb only), `packages/server/src/http.ts` (the new routes only; the socket routes are `serveHooks` there), `packages/contract/src/**`, `packages/cli/**`, `packages/server/test/**`, `AGENTS.md`, `docs/design.md`, `docs/waves/f2.md` (Left behind lines only, no status flips). Never: `docs/waves/PLAN.md`, `docs/program.md`, `docs/evidence/**`, `lifecycle.ts`'s transition table.

# Brief: F2 Wave 5, following leads in `factory status`

Read `AGENTS.md`, `docs/waves/f2.md` (Wave 5), `docs/design.md` §5 ("Following a lead") and `packages/server/src/status.ts` first. The steps are Wave 5 of `f2.md`.

1. `factory status` and `GET /status` gain a section ISSUES: id, state, repo, lead session, last phase, waiting reason (for `waiting`: decision, wall, dependency, claim), evidence missing, decisions open. Closed Issues do not appear, except one closed in the last 24 h that failed finalize. `--format plain` keeps one screen.
2. `factory issue show <id>`: one Issue's timeline merged from `events` and its inbox, oldest first, with the evidence and decisions. Facts are shown as data.
3. `factory issue note <id> <text>` goes through the session notes of F1 (`POST /sessions/:id/note`'s path, prompt id `issue:<id>:note:<call id>`, `--id` makes a repeat one note); on an Issue with no running lead it is an inbox row and the next brief carries it.
4. `docs/design.md` §4 and §5 and the `AGENTS.md` pointers describe what was built and nothing older: go through both against the code, name each case in the report.

Tests through the CLI and the API. **Gate:** `make check` green, `/review` with findings fixed, one more `/review` pass on the fix commits. **Wait for every review run in the foreground** (`agw run wait <runId>`): never end a turn while a background shell runs, the factory reads your idle prompt as finished and wakes the lead. Push the branch, open a PR (`gh pr create`, no attribution), don't merge or deploy. End with a report: done / deferred, one line each.
