Branch: reset-w2-deps
Title: feat(issues): dependencies and priority are respected by admission — `issue new --after`, `issue prio`
Owned files: `packages/server/src/issues/**`, `packages/server/src/http.ts` (the Issue routes only), `packages/contract/src/issues.ts`, `packages/cli/src/run.ts` (the `issue new` and new `issue prio` commands and their usage lines), `packages/server/test/**`, `docs/design.md` (§4 "As built" only), `AGENTS.md` (the **Issues** paragraph and the CLI list in Layout). Never: `docs/waves/**`, `docs/program.md`, `docs/strategy/**`, `docs/evidence/**`, migrations (none is needed: `factory.issue_deps` exists since `012_issues.sql`).

# Brief: reset row 3 — dependencies and priority

Read `AGENTS.md` first, then `docs/strategy/2026-11-reset/design-v3.md` §2 (the loop, "dependencies are respected") and §7
(admission). Decision RS1 in `docs/decisions.md`: a plan is Issues linked with `--after`.

## What exists

- `factory.issue_deps (issue_id, on_issue)` and the `dep` inbox event (`issues/lifecycle.ts` table, `dep:` row) applied by
  `addDependency` in `issues/deps.ts`: refuses an unknown id, a closed blocker and a cycle; locks the blocker `FOR SHARE`.
- `releaseDependents` (`deps.ts`) on close deletes the rows and wakes a `waiting`/`dependency` Issue left with none. **Keep it.**
- The `prio` event is accepted by the lifecycle (`prio: { queued: recorded, … }`) but nothing produces it.
- Admission `admitIssues` (`issues/admission.ts`) reads each project's lowest queued id (plus urgent ones) and ignores
  `issue_deps` and `prio`.

## The change

1. **`factory issue new --after <id>`**, repeatable. The ids travel in the `POST /issues` body (contract `issues.ts`, zod,
   bounded: at most, say, 20 ints ≥ 1). The server writes the deps **in the create transaction** (`issues/create.ts`), with
   the same refusals as `addDependency` (unknown id, closed id; a cycle is impossible for a new Issue). A refusal fails the
   whole create: nothing stored, a 4xx with the reason, the CLI's matching exit code (agw's table, `packages/cli/src/exit.ts`).
   Reuse `addDependency`'s checks rather than a second copy (extract a helper both call). Idempotent create by `--key` must stay
   idempotent: a repeat with the same key returns the stored Issue and does not add or change deps (state which you chose for a
   repeat with *different* `--after`, and test it).
2. **Admission admits only Issues with no open dependency.** Add `NOT EXISTS (SELECT 1 FROM factory.issue_deps d WHERE
   d.issue_id = i.id)` to the reading. Mind the "project's oldest" rule: a blocked oldest must not hold back an unblocked Issue
   of the same project; the choice is made among the unblocked ones. Since a close deletes its dep rows, "open dependency" = a
   row exists; verify that every closing path (`close`, `drop`/`stop`, `verified`) goes through `releaseDependents`, and add a
   test if one does not.
3. **`factory issue prio <id> <n>`** (n an integer, bounded, e.g. -1000..1000; higher first) writes one `prio` inbox event,
   keyed deterministically (`<issue>:prio:<call id>` like the owner's note: `--id` optional, the CLI generates one), token
   only like `issue note`. Admission orders the project's candidates by **the latest `prio` event's value** (none = 0), then
   id — derived from `issue_events` (or wherever `recorded` puts the row; find it), never a stored column (AGENTS.md: facts
   stored, state derived). Urgent ones stay first. A prio on a closed Issue is refused like the other owner verbs.
4. Tests at the lifecycle and admission level (`packages/server/test/issues.test.ts`, `admission.test.ts`,
   `issues-api.test.ts` patterns): B `--after` A stays queued while A is open and is admitted after A closes; a blocked oldest
   does not block a younger unblocked one; `--after` an unknown or closed id stores nothing; prio reorders two queued Issues
   of one project; the latest prio wins over an earlier one.
5. `docs/design.md` §4 "As built" and AGENTS.md's **Issues** paragraph + Layout CLI list updated in the same commit as the code.

## Validation

Cheap, in the worktree: `bunx tsc --noEmit -p .` (or the repo's tsc target) and
`bun test packages/server/test/issues.test.ts packages/server/test/admission.test.ts packages/server/test/issues-api.test.ts`
plus any test file you touch. Run them in the foreground, one at a time. **Do not run `make check`** — the lead runs it at
merge (the mini is load-bound: one check at a time).

Finish: commit, push the branch (`git push -u origin reset-w2-deps`), open a ready (not draft) PR (GitHub). Report the PR URL
and the validation output verbatim. Never touch files outside "Owned files". If the task needs one, stop and say which file
and why. Never end a turn on a background shell or a wait: run validation in the foreground.
