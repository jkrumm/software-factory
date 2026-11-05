Branch: reset-w5-health
Title: feat(fleet): asks are decisions, parks and machine failures go to a health line; the heartbeat on /health; make rollback
Owned files: `packages/contract/src/index.ts` (the status schema), `packages/contract/src/fleet.ts`, `packages/server/src/status.ts`, `packages/server/src/issues/attention.ts`, `packages/server/src/fleet/model.ts`, `packages/server/src/fleet/index.ts` (only what a health item needs read), `packages/server/src/fleet/triage.ts` (only what moving lines out of asks breaks), `packages/server/src/review/limits.ts` (`reviewAttention` only), `packages/server/src/notify/outbox.ts` (`notificationAttention` only), `packages/server/src/http.ts` (`GET /health` only), `packages/server/src/health.ts` (new, if you want one module for the health line), `packages/cli/src/run.ts` (the plain output of `status` and `fleet`), `Makefile` (the `rollback` target), `scripts/rollback.sh` (new) or `scripts/deploy.sh` (only a rollback entry point), `packages/server/test/**`, `packages/cli/test/**`, `docs/design.md` (§3/§11 "As built"), `AGENTS.md` (the fleet view paragraph, the Layout's `scripts/` line, `make rollback` in Validate). Never: `docs/waves/**`, `docs/program.md`, `docs/strategy/**`, `docs/evidence/**`, migrations, other repos.

# Brief: reset row 6 — asks vs parks, the health line, the heartbeat

Read `AGENTS.md` first, then `docs/strategy/2026-11-reset/design-v3.md` §1 (the words Ask and Park), §2 ("What reaches the
owner"), §6 (the health line) and decision RS3 in `docs/decisions.md`.

## What is there today (mapped 2026-11-05, check it)

- `factory status` (`status.ts` `buildStatus`, `:59`) returns `attention: string[]`, concatenated from `attention()` (`status.ts:22-50`:
  `blocked <id> for N min`, `stuck`, `walled`, note failures, `spawn <key> failed`), `issueAttention()` (`issues/attention.ts:19-95`),
  `notificationAttention()` (`notify/outbox.ts:227`), `digestAttention()` (`status.ts:53`), `reviewAttention()` (`review/limits.ts:62-84`).
- `/fleet` (`fleet/model.ts` `assemble`, asks block `:235-356`) turns every attention line into an ask of source `factory` (minus
  `isMachineNoise`, `:141-158`), plus `hc` permission prompts, `wait` sessions waiting on the owner, `decision` rows and the human `queue`.
- Issue `size` (`s|m|l`) is stored by Classify and read nowhere; `stuck` (45 min, `sessions.ts:17`) looks at turn start and the
  worktree mtime, not at hook events; the regression count lives only in `issue_events` (`lifecycle.ts` `movedBefore`, `MAX_REGRESSIONS`).
- `GET /health` returns `{status, version, reason, tick: {lastSuccessAt, lastError}}`. No `make rollback`: `scripts/deploy.sh`
  keeps releases under `~/.software-factory/releases/<sha>`, `current` is a symlink, `PREV_FILE` holds the previous sha, and
  `roll_back()` (`:190-225`) is used only when a fresh deploy fails `/health`.

## 1. Two lists: asks and health

**An ask is a decision only** (RS3): a `decision` row, an Issue waiting `blocked`, a session's `blocked` permission prompt (hc),
a session waiting on the owner (`wait`), the human queue, and a review held at the deep cap (its `allow` is the owner's call).
**Everything else that needs attention is a health line**: every park (`wall`, `lead_gone`, `unreported`, `parked`, with reason and
age), `stuck`, `walled`, a failed spawn, a failed note, a notification not delivered, a review that needs a human because attempts
failed, a lead that did not start, a worktree not made or kept, a finalize that failed, an alert that starts no lead, a wait for the claim,
digest failures. A line is one or the other, never both, and **a health line never becomes an ask**.

- `factory status`: keep `attention` for the asks' lines and add `health: string[]` (contract in `packages/contract/src/index.ts`,
  the server builds through the schema, the CLI parses with it). The plain output prints a HEALTH section after the asks.
- `/fleet`: `asks` holds only the asks above; add `health: FleetHealth[]` to the fleet contract (`fleet.ts`): `{ id, kind, text,
  repo, issue?, session?, since }` with a stable `id` (reuse `lineKey`), `kind` one of `park|silent|over_budget|regressions|machine`.
  Drop what moving the lines out of asks makes dead in `model.ts`/`triage.ts` (`isMachineNoise` likely goes: noise becomes a health line
  or is dropped as it is today). Keep the rest of triage working; row 8 deletes it.

## 2. Three new health lines (design v3 §6)

- **Silent lead:** an Issue `working` whose lead session has no hook event for 20 minutes (the last stored event of that session,
  any kind). Text: `Issue <id>: no hook event for <n> min`.
- **Over budget:** an Issue `working` longer than its size's budget: s 2 h, m 6 h, l 24 h, unknown size m. Count from the latest
  `working` transition of the current attempt. Text: `Issue <id>: working <n> h, budget <b> h (size <s>)`.
- **Regressions:** an open Issue with exactly 2 `regression` events (the third parks it: then it is a park line). Read from
  `issue_events` as `lifecycle.ts` counts them; reuse its helper, do not store a count.

Derived when read (facts stored, state derived); no migration. Constants named, one place.

## 3. The heartbeat on `/health`

Add `heartbeat: { ok: boolean, reason: string | null, tickAt, queueMovedAt }` to `GET /health` (unauthenticated, loopback, as now):
`ok` is true when the last successful tick is less than 30 minutes old **and** no spawn has been due (`queued`, no hold, or
`waiting` with `resume_at` past) for more than 30 minutes without a change of status. `queueMovedAt` is the newest status change
of any spawn (or null). `reason` names the failing half. A dotfiles pusher (next brief, not yours) posts it to Uptime Kuma, so keep
the field names stable and document them in design.md §3. One bounded query, no new table.

## 4. `make rollback`

`make rollback` swaps back to the previous release (`PREV_FILE`), using `deploy.sh`'s own swap (symlink `current`, the plist's
release path, the CLI link, `SHA_FILE`, the door), restarts the service and waits for `/health` with the old version, like a deploy.
`DRY_RUN=1 make rollback` prints the plan and changes nothing (as `DRY_RUN=1 make deploy` does). Refuse (exit non-zero, one line why)
without a previous release on disk. A test for the dry-run plan if `deploy.sh` has a test pattern; else shellcheck clean and say so.
**Never run `make rollback` without `DRY_RUN=1`**: the lead tests the real one.

## Validation

Foreground, one at a time: `bunx tsc --noEmit -p .`, `bunx oxfmt --check .`, `bunx oxlint -c .oxlintrc.json --type-aware <changed
files>`, `shellcheck` on changed scripts, `bun test` on each test file you touched (status, attention, fleet-model, fleet-triage,
http, cli, the new health tests). **Do not run `make check`**: the lead runs it at merge (the mini is load-bound).

Finish: commit, push the branch (`git push -u origin reset-w5-health`), open a ready (not draft) PR. Report the PR URL, the
validation output verbatim, the final split (which line went where) as a table, and anything you left out. Never touch files
outside "Owned files": if the task needs one, stop and say which and why. Never end a turn on a background shell or a wait.
