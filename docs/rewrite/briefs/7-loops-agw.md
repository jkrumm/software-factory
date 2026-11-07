# Package 7: Loops and agw

**Make the factory's recurring work one set of named loops, each a tick with a trigger, a budget and one way to act,
deterministic first, and give the three judgments their own agw workflows: `factory-steward`, `factory-ask` and
`factory-triage`.** Two repos: this one (branch `rw/7-loops-agw`, your worktree) and `agent-workflows` (its own
worktree off its `master`; direct to master, deployed with its `make deploy`). Review: deep, in each repo, with
`--thread rw-7-loops-agw`.

## Read first

`docs/rewrite.md`, `docs/architecture.md` (§Loops and agw, §The server `app/loops`), `docs/language.md` (Steward,
Judge, Loop, Triage, Stall, Wait), `docs/product.md` (principle 1), decisions NL15, NL17, RS12, RS13 (no evals),
`AGENTS.md`, `docs/rewrite/learnings.md`, and the reports `docs/rewrite/reports/{1,2,3,4,5,6}-*.md` (their ports,
stubs and open points name what you replace). The running core's steward and judge: `docs/design.md` §4 "The steward",
"The ask judge"; `legacy/server/src/issues/{steward,judge,judge-input,agw-call,classify}.ts`. In agent-workflows:
`AGENTS.md`, `packages/host/README.md` "Adding a workflow", `docs/factory-input.md`,
`packages/host/src/workflows/factory-ask/` and `factory-classify/` (the shape to copy), `packages/routes/src/table/
factory.ts`, `packages/cli/README.md` (the CLI contract, exit 10 and `agw run wait`), `~/.claude/rules/agent-limits.md`.

## Build, in this repo

1. **The agw port** (`adapters/agw/`): one adapter every caller uses. `agw <workflow> --format json
   --idempotency-key <key>` with the input on stdin; exit 10 is pending, then `agw run wait <runId>` until it is not;
   a **30-minute hang guard**, never a shorter budget (agent-limits). Returns `Result<output, PortError>`. Replaces
   the thin `agwJudge` (package 6) and `stubTriageWorkflow` (package 2). A fake of it for tests (the scenarios'
   `tests/scenarios/fakes/agw.ts` grows).
2. **The loops** (`app/loops/`): a loop is a named tick with a trigger (interval, or an event kick), a budget (items per
   pass, single-flight), and one way to act. Fold the timers that exist today into one loop runner: package 4's lead
   tick (spool, lost leads, outbox), package 5's watch loop, package 6's settle and send timers, package 3's planning
   and admission passes. One setting per loop's interval, `FACTORY_TICK_MS` the default; `/health`'s `tickAt` reads the
   runner. No behaviour of those passes changes; only who schedules them.
3. **Steward:** over stalled Issues (`wall`, `unreported`, `blocked`, `lead_gone`, `regressed`, and package 5's
   blocked checkout). Deterministic first: wake when the cause is gone (re-check), requeue, deliver a pending note.
   When the rules do not say, call `factory-steward` with the Issue's facts; its answer is one of the steward's own
   actions or "raise a Decision" (through package 6's ask use case, so the Decision goes the whole way: policy, Judge,
   default, owner). Every action is an event on the Issue (`woken` and the rest), keyed so a replayed pass does
   nothing twice.
4. **Judge:** package 6's settle step calls the Judge through the agw port with its `JudgeInput`; keep its guard (an
   irreversible option is never the Judge's).
5. **Triage:** intake's triage port asks `factory-triage` when deterministic matching is unsure (package 2's `unsure`
   band) or a request needs its kind, size and likely `after` edges; the answer is checked like the Judge's (a match
   must be an open Issue it was shown).
6. **Nothing stays `settling`** (report 3, open point 4): today an Issue intake files is settled only by `planning
   settle`. The triage loop settles every `settling` Issue: deterministically when it needs no edges (an incident, a
   bug from a check or job, an Issue of a plan row whose edges are known), else after `factory-triage` proposes its
   `after` edges (checked: only open Issues it was shown, no cycle, through planning's use case); the steward settles one
   with no edges once a setting's timeout passes without an answer. Scenario: an owner signal filed as a new Issue is
   admitted without anyone calling `planning settle`.
7. **Loop guard:** a change a loop made never fires that loop again (package 2's `madeBy` on the envelope; the loops
   set it on what they file or note).

## Build, in agent-workflows

8. **`factory-steward`** and **`factory-triage`**: new workflow modules shaped like `factory-ask` (schema, index,
   module, README with its route), on the factory route group. No eval set (RS13). Input and output are zod schemas
   that match exactly what this repo sends and parses; put the same shape in this repo's contract or adapter and test
   both sides against one fixture.
9. **`factory-ask`**: extend it, **backward compatible**, to take package 6's `JudgeInput` (question, recommendation,
   checked, options with cost and reversibility, the no-answer consequence and default, precedents with worth-asking).
   The running factory on master still calls it with today's shape for other repos until the cutover: both shapes must
   work, and its existing tests stay green. The architecture names Haiku high for it: change its route only if the
   route table makes that a one-line, measured change, and say so.
10. Ship it: `make check` there, commit to its master (rebase first; other sessions may push), `make deploy`,
   `make verify`.

## Acceptance

- Scenarios with a fake agw: a stalled Issue whose cause is gone is woken by the steward without agw; one whose rules
  do not say asks `factory-steward` once (replayed pass: still once) and acts on the answer; a steward answer of "raise
  a Decision" reaches the owner only when policy, Judge and default do not settle it; an unsure signal asks
  `factory-triage` and amends the Issue it names; a triage answer naming an Issue it was not shown is refused; a loop's
  own note never fires that loop again; every timer of packages 3 to 6 now runs through the loop runner.
- **One live call of each workflow** (`factory-steward`, `factory-ask` with the new and the old shape,
  `factory-triage`) against the deployed agw, through this repo's agw adapter, with the outputs in your report.
- `make check` green in both repos, outputs in your report.

## Out of scope

`factory-queue`, friction and hygiene loops (after the cutover). The read API and stream (package 8). Changing what a
pass does beyond who schedules it.

## Finish

As `docs/rewrite/briefs/parallel.md` §Finish says, with `docs/rewrite/reports/7-loops-agw.md`, and the agent-workflows
commits and deploy evidence in it. Shared-file edits are yours now (no other package runs beside you), but keep each
pass's own code where its package put it.
