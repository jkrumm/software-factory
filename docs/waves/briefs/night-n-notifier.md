Branch: night-n-notifier
Title: feat(notify): the factory reaches the owner through Hermes, the morning digest
Owned files: `packages/server/src/notify/**` (new), `packages/server/src/tick.ts` and `main.ts` (the wiring only), `packages/server/src/issues/**` (the calls that record a notification only), `packages/server/src/http.ts` (the new routes only), `packages/server/migrations/` (new files only, number from the lead), `packages/contract/src/**`, `packages/cli/**`, `packages/server/test/**`, `AGENTS.md` (pointer lines), `docs/design.md` §11. Never: `docs/waves/PLAN.md`, `docs/program.md`, `docs/evidence/**`, `hc-runner.ts`, anything in hermes-agent (no change there is needed; if one is, stop and say which).

# Brief: N, the notifier (owner decision 4, 2026-11-01)

Read `AGENTS.md`, `docs/waves/night-2026-11-01.md` (decision 4), `docs/design.md` §11 and `packages/server/src/issues/` first. Today the factory reaches the owner nowhere: only `factory status` and `jk-board`. The factory never calls a model (SF2): a message is a template, Hermes only delivers it.

1. **A `Notifier` port** with one call `send(message): ok|error`. `HermesNotifier` runs `hermes send --to <target> --quiet` with the text on stdin, a process timeout, `childEnv()`, `FACTORY_NOTIFY_TARGET` (default `slack:#agents`, a channel name is not a secret, and that channel never makes Hermes answer) and `HERMES_BIN`. Check the flags with `hermes send --help` on the mini. A fake for tests. `NullNotifier` when `FACTORY_NOTIFY_TARGET=off`.
2. **An outbox, never a port in a transaction.** Table `factory.notifications (key text primary key, kind, issue_id, text, created_at, sent_at, attempts, error)`. A rule inserts a row with `ON CONFLICT DO NOTHING` in the transaction that decides it; the tick sends unsent rows outside any transaction: claim, commit, call, record. At most 5 per tick, 5 attempts with a backoff, then `failed`, which is a line in `factory status`. A crash between send and record may send twice: at-least-once, said in the design.
3. **What goes out** (one line each, Issue id and repo first, agent text clipped to 200 characters and fenced as a quote, never a secret, no hostnames):
   - `ask`: a `decisions` row is new (`notify:ask:<decision id>`), with `factory issue answer <id>` as the way back.
   - parked: an Issue moved to `waiting` with reason `unreported` or a stuck lead (`notify:parked:<issue>:<revision>`).
   - failed: an Issue's lead spawn failed for good, a finalize failed, a door route refused (`notify:failed:<kind>:<key>`).
   - the hold: a regression sent back to a lead (`notify:regression:<issue>:<n>`).
4. **The digest:** at 07:30 local time (`FACTORY_DIGEST_AT`, `Europe/Berlin`), once per day (`notify:digest:<date>`; a server down at 07:30 sends it at start if before noon): Issues closed, shipped and watching, parked, decisions open, failed spawns, quota per account, what ran overnight (`events` and `spawns` of the last 24 h). Pure function, one golden test. Plain text, under 3000 characters.
5. **The app's toast:** `hc`'s `notify` for `ask` and `failed` beside Slack, best effort, only if it is one call (check `~/SourceRoot/dotfiles/skills/herdr/SKILL.md` and `hc --help`). If it is not, skip it and say so.
6. `factory notify list [--pending]` and `factory notify test` (sends one line through the live path: the lead's proof).

Tests through the port's fake: each kind once, a replay records nothing, a failing send retries and fails, the digest at the boundary of the day and of the server being down, a crash between claim and record.

**Gate:** `make check` green, `/review` with findings fixed, one more `/review` pass on the fix commits. **Wait for every review run in the foreground** (`agw run wait <runId>`): never end a turn while a background shell runs, the factory reads your idle prompt as finished and wakes the lead. Push the branch, open a PR (`gh pr create`, no attribution), don't merge or deploy. End with a report: done / deferred, one line each.
