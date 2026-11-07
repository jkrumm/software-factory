# The rewrite

**The factory pauses, a temporary orchestrator rebuilds the core to `docs/architecture.md` on a branch, the branch
proves itself live with `FACTORY_REF`, and the factory resumes on it and builds the Console.** Owner decision of
2026-11-07 (NL13, NL14). The orchestrator reads this file first after every start or compaction.

## Pause

- `factory queue set drain` before the first package starts: running Issues finish, nothing new is admitted.
- The running server keeps intake, the door, ntfy and health. Signals still become queued Issues, and the 30-minute
  forward (Issue 286) still pages the owner for an unsolved alert.
- Nothing is admitted until the cutover. Urgent work during the pause is the orchestrator's to judge with the owner.

## The orchestrator

- One Claude Code session in its own herdr space and tab, on the opus tier, alive for the whole rewrite.
- **It may start terminals with `hc run`** for the rewrite only: the owner's exception to the two lanes (NL14). Each
  package gets one worker session in its own worktree off the `rewrite` branch, on the sonnet tier, opus only for
  the kernel and the state machine.
- **State lives in files**, never in the orchestrator's context: `docs/rewrite/state.md` (package, terminal, status,
  last commit, evidence) and `docs/rewrite/learnings.md` (where something fell apart and what changed).
- **A worker's brief** carries the package's goal, files, acceptance and out-of-scope lines, and points at
  `docs/language.md`, `docs/architecture.md` and `AGENTS.md`. The worker builds, runs `make check`, reviews its range
  once (`/review`, standard or deep), and reports. It never merges into `rewrite`.
- **The orchestrator integrates:** reads every diff, merges into `rewrite`, runs `make check` and the scenarios, and
  starts the next package. A failed integration goes back to the same worker with the failure verbatim.
- It reaches the owner only for owner classes, through ntfy, and records the answer in `docs/decisions.md`.

## Packages

| # | Package | After | Done when |
|-|-|-|-|
| 0 | **Skeleton**: `apps/` and `packages/` layout, Elysia boots, contract to OpenAPI, generated CLI with `version` and `role get`, lint, format, `tsc`, test and scenario harness, boundary and retired-word scripts, CI | | `make check` green on an empty server; `rd --role` reads the new CLI |
| 1 | **Kernel and work**: Result, ids, clock, keys, events; the total Issue machine, model test, generated diagram | 0 | A missing cell fails `tsc`; the model test holds its invariants over 10,000 sequences |
| 2 | **Intake**: envelope, trust, fingerprint, correlation, amend-or-new, quarantine; every source ported; the door posts signals | 1 | Scenarios: a VPS outage's three alerts make one incident; an owner signal amends an open Issue |
| 3 | **Planning and capacity**: plan files, chain, queue order, accounts, windows, memory, load, claims, slots, `leads: N` | 1 | Scenarios: two leads in one repo; a memory hold names its reason |
| 4 | **Leads**: hc runner, brief in the new words, notes, hooks, spool and socket (contract unchanged), session state, send-back | 1 | Scenarios: start, note, compact, lose a terminal, replay a tick: nothing doubles |
| 5 | **Quality**: evidence, watch, verify, review recorded as evidence | 1 | Scenarios: ship, watch, verify, regression, reopen |
| 6 | **Checkpoints**: decisions with the required fields and worth-asking, the ledger, artifacts with revisions, annotations and verdicts, errands, the owner's line | 1 | Scenarios: a verdict arrives as the lead's next turn; a Decision is settled by policy, Judge, default and owner in turn |
| 7 | **Loops and agw**: steward, judge, triage ticks; the `factory-steward`, `factory-ask` and `factory-triage` workflows in agent-workflows | 2, 6 | Scenarios with a fake agw; one live call of each workflow |
| 8 | **API, read models, CLI parity**: every verb leads, `rd`, Hermes and the Herdr board use; the stream | 2 to 7 | Each client's calls run against the new server |
| 9 | **Cutover**: import Issues, events, decisions and evidence; `FACTORY_REF=rewrite make deploy`; scenarios against the live server; clients switched; plan rows for the Console written into `docs/plan.yaml`; `factory queue set run` | 8 | The factory admits and closes a real Issue on the new core; the old code is deleted |

Packages 2 to 6 run in parallel on separate worktrees once 1 is merged; they touch disjoint domain folders.

## After the cutover

The factory builds the rest through `docs/plan.yaml` with parallel leads: Console v0 (shell, Needs you, artifact page,
then the owner's first look), the full Console (Flow, Issue page, Chain, Improve), surfaces (Herdr glance,
`integrations/`, Argo's factory pages out, Iris scope, Hermes' factory skill), the queue, friction and hygiene loops,
HyperDX per app, and the public launch (MIT, README, demo).
