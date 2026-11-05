Branch: reset-w7-issue-facts
Title: feat(issues): the issue_facts view — one row per attempt — and `factory issue facts` with the KPI line
Owned files: `packages/server/migrations/031_issue_facts.sql` (new), `packages/server/src/issues/facts.ts` (new: the read and the KPI query), `packages/server/src/http.ts` (one route, token and socket, as `issue list` is wired), `packages/contract/src/issues.ts` and `packages/contract/src/index.ts` (the response schema), `packages/cli/src/run.ts` (the subcommand, its help line, its plain screen), `packages/server/test/**`, `packages/cli/test/cli.test.ts`, `docs/design.md` (§4 "As built" or §11, wherever the Issue read model is described), `AGENTS.md` (the CLI list in Layout, the Issues paragraph: one clause). Never: `docs/waves/**`, `docs/program.md`, `docs/strategy/**`, any other migration, anything that writes.

# Brief: reset row 12 — `factory.issue_facts`

Read `AGENTS.md` first (Facts are stored, state is derived; One schema; One contract; CLI contract), then
`docs/strategy/2026-11-reset/design-v3.md` §11 (Telemetry) and decision RS9 in `docs/decisions.md`.

## Decided by the program lead (do not re-litigate)

- **A view, not a table.** `CREATE OR REPLACE VIEW factory.issue_facts` in migration `031_issue_facts.sql` (the first view in the
  schema; `db.ts` `migrate()` runs it like any file). Nothing is stored, no trigger, no writer changes.
- **No read of `usage.*`**, not in the view, not in the query. Argo joins `lead_session_ids` with usage-tracker's
  `usage.session_window_share` itself. A test greps the migration and `facts.ts` for `usage.` and fails on a hit.
- **One row per attempt.** `attempt` is stored on no event: derive it. Attempt *n* of an Issue starts at its *n*-th `admitted` event
  (`to_state='working'`, ordered by `at, id`) and runs until the next `admitted` (or open). An event belongs to the attempt whose
  window holds its `at`. Where an event's `payload->>'attempt'` exists (lead verbs, `lead_gone`, `issue_finalized`) it must agree; a test
  covers two attempts. An Issue never admitted (queued, dropped before admission) gets one row with `attempt = 0` and null times past
  `filed_at`.
- **Review rounds are not stored anywhere** (the factory keeps only `derived.review.tier` and `covered`). Leave the column out; say so in
  design.md and in your report. Do not add a writer for it.

## The columns

From `issues` (`012_issues.sql`, `016_issue_lead.sql`), `issue_events` (`012`), `evidence` (`012` + `019`: has `attempt`),
`decisions` (`012`: `key` joins the `ask` event's `key`), `sessions` (`issue_id`, `id = lead-<issue>-<attempt>`, `claude_session_id`):

| Column | Source |
|-|-|
| `issue_id`, `attempt`, `repo`, `kind`, `size`, `lead_tier`, `lead_effort` | `issues`, the derived attempt |
| `filed_at` | `issues.created_at` |
| `admitted_at` | the attempt's `admitted` event |
| `first_commit_at` | the earliest commit time you can read from the attempt's `ship` event `payload->'derived'` (see `Derived`, `issues/evidence.ts:121-135`); if only `mergedAt` (the newest) is there, name the column `landed_at` instead and say so |
| `shipped_at` | the attempt's first `ship` |
| `verified_at` | the attempt's `verified` event |
| `closed_at`, `outcome` | the `to_state='closed'` event in the window; `outcome` from `issues.outcome` for the last attempt, `retried` for an attempt a later one followed |
| `asks` | the attempt's `ask` (decision) and `block` events |
| `parks` | `jsonb` counts of the attempt's waits by reason: `wall` (`limit_stop`), `lead_gone`, `unreported`, `parked` |
| `owner_touches` | the attempt's `note`, `answer` with `payload.who` not `default`/`closed`, `retier`, `reopen` |
| `review_tier` | the last `ship` of the attempt, `payload->'derived'->'review'->>'tier'` |
| `holds`, `verify_first_pass` | number of `ship` events; true when the first hold ended `verified` with no `verify_red` or `regression` before it |
| `reopened` | a `reopen` event after this attempt's close |
| `lead_session_ids` | `array_agg` of `sessions.claude_session_id` for `sessions.id = 'lead-<issue>-<attempt>'` (non-null only) |

Check every event kind against the writers before you rely on it (`lifecycle.ts` `TABLE` :131-215 and `applyEvent` :297-353,
`hold.ts` :215-275, `verbs.ts`); if a kind above does not exist as named, use the real one and list the change in the report.

## The read and the CLI

- `facts.ts`: `listFacts(sql, {since})` (rows with `filed_at >= since`, default all, ordered by `issue_id, attempt`) and `kpis(sql,
  {since})`, **one** SQL query over the view returning the four KPIs of design v3 §11:
  owner asks per Issue (`sum(asks)/count(distinct issue_id)`), Issues verified with zero owner touch (share of Issues with a `verified`
  attempt whose attempts sum `asks + owner_touches = 0`), verify green on the first hold (share of attempts with `holds > 0` and
  `verify_first_pass`), window points per Issue (`null`: Argo's; the field is there and says so). Each with its numerator and
  denominator.
- `GET /issues/facts?since=<iso>`: token API and socket, wired as `issue list` is (`http.ts:410`, `:858-871`, `viaSocket`); the body
  `{ rows, kpi }` built through a new contract schema `IssueFacts`; a bad `since` is 400.
- `factory issue facts [--since <iso>]`: `--format json` prints the body; `plain` prints one tab-separated line per row, then one KPI line
  (`asks/issue 0.00 (0/12)  zero-touch 92 % (11/12)  first-hold 83 % (10/12)  window -`). Help text with the other `issue` verbs.

## Tests

In `packages/server/test/` (a new `issue-facts.test.ts`, the seeding pattern of `issues.test.ts`/`follow.test.ts`: `createIssue`,
inbox `send` + `issuePass`, `FakeClock`): an Issue with two attempts (the first `lead_gone`, the second verified on its first hold) gives
two rows with the right windows and outcomes `retried`/`done`; a red first hold then `verified` is `verify_first_pass=false`; an ask and an
owner note count; a dropped never-admitted Issue is attempt 0; the KPI numbers for that seed, numerator and denominator; `since`
filters. The `usage.` grep test. One CLI test in `cli.test.ts` for `--format json` and the plain KPI line. `db.test.ts` still passes
(the view applies on a fresh cluster).

## Validation

Foreground, one at a time: `bunx tsc --noEmit -p .`, `bunx oxfmt --check .`, `bunx oxlint -c .oxlintrc.json --type-aware packages`, and
`bun test` on each test file you touched plus `db.test.ts`. **Do not run `make check`.** Finish: commit, push `reset-w7-issue-facts`, open a
ready PR. Report the PR URL, validation output verbatim, the column changes against this brief, and what you left out. Never touch files
outside "Owned files": stop and say which and why. Never end a turn on a background shell or a wait.
