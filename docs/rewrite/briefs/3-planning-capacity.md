# Package 3: Planning and capacity

**Decide what may run and when: projects and their plans, the chain across projects, the queue order, and capacity
(accounts, windows, memory, load, repo claims, test slots, `leads: N`).** Planning records `settled` on an Issue once
its chain is known; capacity records `admitted` when a lead may start. Branch `rw/3-planning-capacity`. Review: deep.

Read `docs/rewrite/briefs/parallel.md` first: its rules hold here and are not repeated.

## Port from

`docs/architecture.md` §The server (planning, capacity), §Loops (Queue row); `docs/language.md` (Project, Plan, Chain,
Wait); decisions NL6, RS5, RS14, and the memory work of Issues 289 and 290; `docs/design.md` §3 "Capacity and
admission", "The queue", §4 "Dependencies", "Priority", "Admission", "Claims", "The plan files its next Issue", §7,
§9 "Projects"; `legacy/server/src/{admission,capacity,memory,quota,slots,queue,spaces}.ts`,
`legacy/server/src/projects/`, `legacy/server/src/issues/{admission,deps}.ts`, `legacy/cli/src/slot.ts`,
`project.yaml`.

## Yours

`domains/planning/`, `domains/capacity/`, `app/planning*.ts`, `app/capacity*.ts`, `adapters/planning/` (reading
`project.yaml` and `docs/plan.yaml` from a repo's default branch, the machine's memory and load), `api/planning.ts`,
`api/capacity.ts`, contract files of the same names, migrations `0300`+. The `factory slot run` verb stays
hand-written in `apps/cli` (its contract: a lease on the host's test slots, a wait past 45 min exits 75, fail open
when the server is down); add it beside `version` and `role` there and nothing else in the CLI.

## Build

1. **Projects:** `project.yaml` parsed with zod (the current `apiVersion: factory/v2` files must parse; the word
   "manifest" is retired, the thing is the project), synced from the default branch, `leads: N`, `signals:` exposed
   to intake through a read port (intake declares `IntakeTopology`; provide the planning side as an adapter it can be
   wired to, list it in your report).
2. **Plans and the chain:** `docs/plan.yaml` rows not yet filed, filed as Issues when the rows they wait for are
   closed in any outcome (RS14), a row may target another repo; `after` edges across projects; cycle check; `prio`
   (the owner's, never overridden); the queue order (dependencies, urgent and incident first, **stop the line** from
   design §8 "Order", `prio`, age). Planning records `settled` on a `settling` Issue when its edges are known
   (`recordIn`). Filing a row goes through the work domain's `fileIn`.
3. **Capacity:** accounts and their windows (from the usage data the running core reads; an account near its limit is
   not picked), memory and load ceilings (Issues 289 and 290: admission reads memory; the reason is named), repo
   claims (`leads: N` plus one urgent), test slots. **Admission is decided again at every claim**, inside one
   transaction, and records `admitted` (`recordIn`), whose `start_lead` effect package 4 runs.
4. **The claim on resume:** the machine has no claim wait (report 1, open point 3). Decide how a resumed Issue gets its
   repo's claim back without a new machine state, implement it on your side, and say which in your report.
5. **The word for a held-back admission.** "Hold" is retired (`docs/language.md`, Watch). A queued Issue that capacity
   does not admit yet is not `waiting`; name the reason it stays queued (memory, load, window, claim, chain) without
   the word "hold", and list the word you chose in open points.

## Acceptance

- Scenario: two leads in one repo with `leads: 2`: both admitted, a third waits for a claim, and frees on a close.
- Scenario: a memory ceiling keeps a queued Issue out, and the reason it names says memory and the numbers.
- Scenarios for: a plan row is filed when its `after` row closes, once (replay-safe); a cycle is refused; stop the
  line admits only the fix in its project; `prio` orders the queue; `factory slot run` leases and frees a slot and
  exits 75 past its wait.

## Out of scope

Starting the lead (package 4 runs `start_lead`). The `factory-queue` workflow (after the cutover). Reading usage by
join for the Console's KPIs (package 8). Intake's correlation (package 2).
