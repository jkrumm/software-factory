Branch: reset-w3b-ended-lead
Title: fix(issues): a lead whose terminal is gone is found without a note — the sweep files `lead_gone` for an ended spawn
Owned files: `packages/server/src/issues/lead.ts` (`parkGoneLeads` and helpers), `packages/server/src/spawns.ts` (only if `withEnded` needs exporting or a small helper), `packages/server/test/lead.test.ts`, `docs/design.md` (§4 "As built" only). Never: `docs/waves/**`, `docs/program.md`, `docs/strategy/**`, migrations.

# Brief: reset row 4, the gap the live proof found

Read `AGENTS.md` (Issues, "the witness alone records `runner_restarted` and `pane_gone`", deterministic keys) first.

**Found live 2026-11-05.** Wave 3 (PR #38) made `lead_gone` restart an Issue (`working → queued`, next attempt, at most two,
then a park). But `lead_gone` is filed only by a failed spawn (`parkGoneLeads` sweep in `issues/lead.ts`) or by a note that
finds its lead gone (`noteLead`). Its doc says: "(A spawn that ended is found only by a note, for now.)" Live: Issue 62's lead
pane t135 was killed with `hc kill` at 00:30:44Z; `factory spawn list` showed `lead-62-1 ended`, and the Issue stayed `working`
with no `lead_gone` for 29 minutes, until an owner note found it.

**The change.** `parkGoneLeads` also files `lead_gone` for a `working` Issue whose current attempt's lead spawn
(`lead-<issue>-<attempt>`) is `started` but reads as `ended` (`withEnded` in `spawns.ts`: the session is `dead`, or its pane is no
terminal of the current core). Guards, both required:
- **A grace period**: only when the session has been dead (its last `session_ended`/`pane_gone`, or the spawn's start when it has
  no session) for at least 10 minutes (a constant; name it). A core restart brings terminals back through hc-resume within that
  time, and a restart would otherwise start a second lead beside a resumed one.
- **Never in a pass where the runner restarted** (the witness's `runner_restarted` event, same rule the witness uses for
  `pane_gone`): skip the ended check for 10 minutes after the latest `runner_restarted`.
Same key form as the failed sweep (one per Issue revision, e.g. `lead_gone:sweep:<id>:<revision>`, or a distinct
`lead_gone:ended:<id>:<revision>` — your call, deterministic), payload `{ attempt, detail: 'spawn <key> ended' }`. No `news`
(no note is involved). Update the doc comment that says "found only by a note".

**Tests** in `packages/server/test/lead.test.ts`: a killed lead (session `dead`, past the grace) restarts the Issue with no
note; inside the grace it does not; within 10 minutes of a `runner_restarted` it does not; a live lead never does; a replayed
sweep files one event.

## Validation

Foreground, one at a time: `bunx tsc --noEmit -p .`, `bunx oxfmt --check .`, `bunx oxlint -c .oxlintrc.json --type-aware <changed
files>`, `bun test packages/server/test/lead.test.ts packages/server/test/spawns.test.ts`. **Do not run `make check`** (the lead
runs it at merge; the mini is load-bound).

Finish: commit, push the branch (`git push -u origin reset-w3b-ended-lead`), open a ready (not draft) PR. Report the PR URL and
the validation output verbatim. Never touch files outside "Owned files": if the task needs one, stop and say which and why. Never
end a turn on a background shell or a wait.
