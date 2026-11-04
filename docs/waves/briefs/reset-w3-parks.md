Branch: reset-w3-parks
Title: feat(issues): every park can end — a lead's turn ends `unreported`, `lead_gone` starts the next attempt, a red verify is re-run once
Owned files: `packages/server/src/issues/**`, `packages/server/src/rules.ts` (the `stopCheck` input pass-through only), the server file that takes the hook's stop check over the socket (find it from `askStopCheck` in `packages/cli/src/hook.ts`), `packages/cli/src/hook.ts`, `packages/contract/src/spool.ts`, `packages/contract/src/issues.ts`, `packages/server/test/**`, `packages/cli/test/**`, `docs/design.md` (§4 "As built" only), `AGENTS.md` (the **Issues** paragraph, the hook rule only if its contract changes). Never: `docs/waves/**`, `docs/program.md`, `docs/strategy/**`, `docs/evidence/**`. A migration only if a fact cannot be derived from stored events; say why in the commit.

# Brief: reset row 4 — parks end

Read `AGENTS.md` first (Issues, Hooks "spool first, then post", "Facts are stored, state is derived", "Every effect has a
deterministic key"), then `docs/strategy/2026-11-reset/design-v3.md` §2 ("every park can end") and §6, and decision RS3 in
`docs/decisions.md`: `wall`, `lead_gone` and `unreported` are parks, and every park can end without a drop.

The lifecycle table is `packages/server/src/issues/lifecycle.ts` (`TABLE`): today `unreported` and `lead_gone` move
`working → waiting` and nothing but `stop` moves them back; `turn_started` ends only a `wall` (`only: 'wall'`, matched on
`wall_session`). `lifecycle.ts` is the one writer of `issues.state`: every change below goes through it.

## The change (four rules, one test file section each)

1. **The lead's own `turn_started` ends an `unreported` park** (`waiting → working`). Only the session that parked it
   (the `unreported` inbox row carries `session`, `issues/sendback.ts`) and only a turn that started after the park; a
   worker's turn or an older turn says nothing (mirror the `wall` guard). The owner already heard of the park; say in the
   design doc whether the end is notified (default: no).
2. **`lead_gone` starts the next attempt, at most two per Issue.** Count the earlier `lead_gone` restarts from
   `issue_events` (derived, not stored). Fewer than two: the Issue goes back to `queued` so admission makes the next
   attempt through the existing path (`admit:<issue>:<attempt+1>`; admission already waits for the last attempt's
   `finalize`, and finalize keeps a worktree with uncommitted changes). The next attempt's brief (`brief.ts`) names the
   previous attempt's branch and, if finalize kept it, its worktree, so the new lead can pick the work up; check what a
   reopen's brief already says and reuse it. The third `lead_gone`: the Issue parks (`waiting`, `lead_gone`) as today, with
   the one notification parks already get (`lifecycle.ts` "The owner hears of a park"). Keys stay deterministic: a replayed
   tick never makes two attempts.
3. **The Stop send-back is skipped while a background subagent runs.** Claude Code's Stop hook input may list running
   background tasks. **First verify the field's real name and shape** (`agw web read https://code.claude.com/docs/en/hooks
   --ask "What fields does the Stop hook input JSON carry, in particular about background tasks or subagents still running?"
   --format plain`, and a real Stop input if you can capture one). If no such field exists, do not invent one: leave this
   rule out, say so in one line, and do the other three. If it exists: `hook.ts` (zod-free; imports only `node:fs` and
   `@software-factory/contract/spool`; stdout empty) carries a boolean "a background task is running" in the spool line and
   the stop check's body; `issueStop` (`issues/sendback.ts`) neither sends back nor parks while it is true. The workers
   rule in `rules.ts` `stopCheck` is unchanged (it counts factory children, which background tasks are not). The hook's wall
   time test (`packages/cli/test/hook.test.ts`) must still pass.
4. **A red verify is re-run once before it counts as a regression; the third regression of one Issue parks it.** The check
   after the hold is `verifyHold` in `issues/hold.ts`: today a red result files a `regression`. Change: the first red of a
   hold files a second `verify` (its own deterministic key, e.g. `…:rerun`), and only a red re-run files the `regression`.
   Count an Issue's regressions from `issue_events`; the third one moves the Issue to `waiting` with reason `parked` (an
   existing park reason) and a line saying "regressed three times" instead of back to `working`, with the park's one
   notification.

Tests per rule at the lifecycle level (`packages/server/test/issues.test.ts`, `lead.test.ts`, `evidence.test.ts` or the file
that tests `verifyHold`, `rules.test.ts`/`socket.test.ts` for the stop check, `packages/cli/test/hook.test.ts`): the park ends
on the lead's next turn and not on a worker's; two `lead_gone` restarts make attempts 2 and 3, the third parks; a send-back is
skipped with a running background task and happens without one; a red-then-green verify closes the hold `verified`, a
red-red files one regression; the third regression parks. `docs/design.md` §4 "As built" updated in the same commit.

## Validation

Cheap, in the worktree, foreground, one at a time: `bunx tsc --noEmit -p .`, `bunx oxlint -c .oxlintrc.json --type-aware
<changed files>`, `bunx oxfmt --check .`, and `bun test <each test file you touched>`. **Do not run `make check`**: the lead
runs it at merge (the mini is load-bound, one check at a time).

Finish: commit, push the branch (`git push -u origin reset-w3-parks`), open a ready (not draft) PR (GitHub). Report the PR URL,
the validation output verbatim, and for rule 3 what the Stop input really carries. Never touch files outside "Owned files". If
the task needs one, stop and say which file and why. Never end a turn on a background shell or a wait.
