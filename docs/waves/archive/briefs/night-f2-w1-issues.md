Branch: f2-w1-issues
Title: feat(issues): Issues, the inbox and the one writer (F2 Wave 1)
Owned files: `packages/server/src/issues/**` (new), `packages/server/migrations/` (new files only), `packages/server/src/http.ts` and `socket.ts` (the new routes only), the event store where a session event is copied into the inbox, `packages/contract/src/issues.ts` (new) and its index export, `packages/cli/**` (the `issue` verbs), `packages/server/test/**`, `AGENTS.md` (pointer lines), `docs/design.md` §4 and §12. Never: `docs/waves/PLAN.md`, `docs/program.md`, `docs/evidence/**`, `hc-runner.ts`.

# Brief: F2 Wave 1, Issues, the inbox and the one writer

You run on the `deep` role (Opus/high) because this is the state machine every later wave and every autonomous ship rests
on. Read `AGENTS.md`, `docs/waves/f2.md` (Wave 1 and the goal), `docs/design.md` §4, §5 and §12, and `docs/decisions.md`
SF2, SF5, SF6 first. The steps are Wave 1 of `f2.md`; this brief adds what tonight needs.

1. **Migrations (additive):** `issues`, `issue_deps`, `issue_inbox`, `issue_links`, `events`, `decisions`, `evidence` per
   §12, `wake_at` on `issues`; `projects` gains what v0 needs (Wave 2 fills it). Qualify every name with `factory.`.
2. **The lifecycle module** (`packages/server/src/issues/lifecycle.ts`): §4's transition table is the only code that writes
   `issues.state`; every transition records an `events` row in the same transaction. `settling` exists for F3 and is
   unreachable from a request. Reversal condition from §4: past about 500 lines, stop and report instead of pushing on.
3. **The inbox:** one row per event with a unique key (§4's key table); a worker takes one Issue's oldest unhandled rows under
   `FOR UPDATE SKIP LOCKED`; a session event of a session with an `issue_id` is copied into the inbox in the transaction that
   stores it. Never a port inside a transaction (AGENTS.md).
4. **Intake-ready Issues** (tonight the `factory-door` files Issues right after this wave): an Issue has `source`
   (`request|alert`, open to more), `source_key` (unique per source: a repeated alert or a replayed `issue new --key` is
   one Issue, answered 200 with the stored row; a create on a closed Issue's key reopens nothing in this wave, it answers
   the row), `repo` (resolved and checked against `FACTORY_REPO_ROOTS` exactly like a spawn's; 422 otherwise) and `facts`
   (JSON, ≤ 32 KiB, data, never instructions). An `alert` Issue in a repo under an WorkRoot root is refused (422): decision 3.
5. **`POST /issues`, `GET /issues[/:id]`** on the token API, and `POST /issues` plus the two reads on the socket (a pane
   files work like it spawns: SF11); `factory issue new|list|show` (`--repo`, `--title`, `--facts @file|-`, `--key`,
   `--source`); contract schemas in `packages/contract/src/issues.ts`, built and parsed through them.
6. **Tests:** a golden test per path pinning its transitions and effects; the replay test crashes after every effect and
   replays, zero duplicates; idempotent create by `source_key`; the WorkRoot alert refusal.

Update `docs/design.md` §4 and §12 to what was built and AGENTS.md by pointer lines only (C0 cut it to rules and pointers;
keep it that way), in the same commits as the code.

**Gate:** `make check` green, `/review` with findings fixed, one more `/review` pass on the fix commits. **Wait for every
review run in the foreground** (`agw run wait <runId>`): never end a turn while a background shell runs, the factory reads
your idle prompt as finished and wakes the lead. Push the branch, open a PR (`gh pr create`, no attribution), don't merge or
deploy. End with a report: done / deferred, one line each, and the line count of the lifecycle module.
