# Package 3: Planning and capacity, report

**Done: projects and plans are read from each repo's default branch, plan rows are filed as settled Issues once the rows they wait for close, the chain and the queue order decide who is looked at, and admission records `admitted` with a claim and an account in one transaction, deciding everything again at every claim.** Branch `rw/3-planning-capacity`, on `fc5a8ac`: seven commits and this report. `make check` is green.

## What changed

- **`domains/planning/`** (pure): `project.ts` (`project.yaml` as zod: `apiVersion: factory/v2`, `leads`, `slots.run`, `signals`, `heal`; strict, `jobs`/`ticktick` dropped), `plan.ts` (`docs/plan.yaml`, row states `done|open|filable|waiting` derived from Issues and the clock, a row's `after` may name `<project>:<row>`, cycles within a file refused at parse and across files kept waiting), `chain.ts` (edges, satisfied once, cycle path), `queue.ts` (queue order and the chain's reasons), `sync.ts` (what a repo read becomes: last valid content kept on a broken file, the second directory of a name keyed `<name>~<hash>`), `signals.ts` (intake's view), `ports.ts`.
- **`domains/capacity/`** (pure): `accounts.ts` (standing, 85 % / 95 % reserve, pace, pick), `host.ts` (memory and load ceilings, the swapout rate), `claims.ts` (room in a repo; which waits give a claim back), `admission.ts` (the rules in order), `queue-state.ts`, `slots.ts` (the lease semaphore as a pure function), `ports.ts`.
- **`app/`**: `planning-sync.ts`, `planning-pass.ts`, `planning-chain.ts` (`settleIssue`, `addAfter`, `setPrio`), `planning-views.ts`, `planning-signals.ts`, `planning-settings.ts`; `capacity-admit.ts` (admission pass, queue view, `resumeClaim`, `releaseClaim`, `accountOf`), `capacity-view.ts`, `capacity-queue.ts`, `capacity-slots.ts`.
- **`adapters/planning/`**: `git-projects.ts` (reads from the default branch with `git ls-tree`/`cat-file`, hardened YAML via `yaml`), `host.ts` (`sysctl` memory sampler, `os.loadavg`), `claude-accounts.ts` (`claude-account usage --json`), `process.ts` (a helper process with a timeout that kills its whole group). **`adapters/postgres/`**: `planning-store.ts`, `capacity-store.ts`, and one line in `locks.ts` (`capacity: 7_093_002`, the old core's value). **`read/planning.ts`**: read-only SQL on the work tables.
- **Migrations**: `0300_planning.sql` (`planning_projects`, `planning_edges`, `planning_prios`, `planning_filed_rows`), `0301_capacity.sql` (`capacity_readings`, `capacity_claims`, `capacity_assignments`, `capacity_queue_states`, `capacity_slots`).
- **API and contract** (`api/planning.ts`, `api/capacity.ts`, `packages/contract/src/{planning,capacity}.ts`). Generated commands: `project list|show|sync`, `planning pass|settle|after|prio`, `queue get|set|order`, `capacity get|refresh|admit`. The routes are always mounted; unbound they answer 503, so the OpenAPI document and the generated CLI are the same in every process. `PUT|DELETE /slots/:id` are hidden from the document: they belong to the hand-written verb.
- **CLI**: `apps/cli/src/slot.ts` (`factory slot run [--name] -- <cmd>`), one branch and one help line in `run.ts`. Contract kept: a lease renewed every 10 s, 30 s lease, wait past `FACTORY_SLOT_WAIT_MS` (45 min) exits 75 without running, `FACTORY_SLOT_OPEN=1` runs anyway, 124 past the run limit, 127 for a missing command, open (runs, one stderr line) when the server does not answer.
- **Shared files touched**: `main.ts` (stores, ports, routes), `api/app.ts` (two `.use()`), `contract/src/index.ts`, `operations.ts` (regenerated), `adapters/postgres/locks.ts` (one key). Two existing tests no longer assumed a closed list and now do not: `tests/scenarios/boot.test.ts` compares the applied migrations with the release's own list, and `apps/cli/test/generate.test.ts` checks that `health get` is among the commands and no `slot` group is.
- **New dependency**: `yaml` 2.9.1, exact, the version the old core pinned (hardened options: YAML 1.2 core, one document, duplicate keys refused, no merge keys, 100 aliases). `Bun.YAML` accepts duplicate keys and expands merge keys, so it was not an option.

## `make check`

```
==> install (bun install --frozen-lockfile)
Checked 45 installs across 101 packages (no changes) [6.00ms]
==> format (oxfmt --check)
All matched files use the correct format.
Finished in 12ms on 134 files using 12 threads.
==> lint (oxlint --type-aware)
==> shellcheck
==> typecheck (tsc --noEmit)
==> boundaries (scripts/boundaries.ts)
boundaries hold
==> retired words (scripts/retired-words.ts)
no retired words
==> Issue diagram is current (apps/server/scripts/issue-diagram.ts --check)
==> generated CLI is current (apps/cli/scripts/generate.ts --check)
==> unit tests (bun test apps packages scripts)
 217 pass
 0 fail
 726 expect() calls
Ran 217 tests across 22 files. [8.79s]
==> scenarios (bun test tests)
 29 pass
 0 fail
 168 expect() calls
Ran 29 tests across 5 files. [19.78s]
==> check passed
```

## Acceptance

Scenarios run the real server process and Postgres, real git repos under a repo root, a fake account picker and a fake `sysctl`; none reached `hc` or `agw`.

- `tests/scenarios/capacity/admission.test.ts`: `leads: 2` admits two, the third stays queued with `no claim free in the repo: the repo runs 2 of 2 leads (Issue 1, Issue 2)`, and is admitted after a close; a second pass starts nothing twice (`start_lead` keys `…:1` once). Memory: `the host is short of memory: swapouts 0 MiB/300s (ceiling 2048), swap 100% of RAM (ceiling 75%)`, admitted when memory recovers; a swapout rate over its ceiling from two readings of the counter. Stop the line admits the fix only. `prio` orders before age, and a repeated key records nothing again.
- `tests/scenarios/planning/plan.test.ts`: a row is filed once when its `after` row closes (a cancelled Issue counts), replayed passes file nothing, the row's facts reach the lead as the first note; a plan cycle keeps the last valid plan and shows the error; an edge that closes a cycle is 409 `cycle`, a closed blocker `issue_closed`, an unknown Issue 404, nothing stored; an Issue behind a blocker names it and is admitted after the blocker closes; a broken `project.yaml` keeps the last valid one and files one Issue per content.
- `tests/scenarios/capacity/slots.test.ts`: lease and free, the command's exit code, 75 past the wait (and the line left), `FACTORY_SLOT_OPEN=1`, the next waiter takes the slot, 124 past the limit with the process group killed, the project's `slots.run` resolved at the grant (60000 ms, also from a worktree), open when the server is down, 127 and usage errors.

## Decisions

- **The claim on resume (brief 4): no new state.** A claim is a lead's place in its repo (`capacity_claims`, with the account it runs on). A wait that needs no lead at work gives it back: `decision`, `review`, `errand`, `timer`, and `dependency` (a lead that waits for another Issue of its own repo must not hold the one place that Issue needs). A stall keeps it. The admission pass sweeps claims of Issues that no longer hold one. When a wait ends the Issue is `working` without a claim, so it is **owed** one: admission counts owed Issues ahead of any new lead, so nobody takes the place it waits for, and **`resumeClaim(issue)` is what the `note_lead` effect calls before it types to the lead**. It answers `refused` while the repo is full (`Issue 7 waits for a claim in solo: …`), which the outbox retries with its backoff, so no lead works in a repo without a place. A resume looks at the repo's claims only (never the load, memory or an account's window) and keeps the account it was admitted on. Package 4 calls it from its `note_lead` port; `releaseClaim(issue)` is for its `finalize`.
- **The word for a held-back admission (brief 5): "stays queued", with a queue reason.** The kinds are `chain`, `line`, `finalizing`, `unknown_project` (planning's) and `drain`, `load`, `memory`, `claim`, `window`, `cap` (capacity's), each with a message that names the numbers. "Hold" appears nowhere in the code but as the `deploy.hold` key of `project.yaml`.
- **Admission is one Issue per transaction.** `admitOne`: advisory lock, edges satisfied, a snapshot, the queue evaluated in order (each Issue decided as if the ones before it were admitted), `admitted` recorded with `recordIn` (key `admit:<issue>:<attempt>`), claim and account stored. A pass repeats it until nothing more may start (at most 20). Host and account readings are taken once before the loop, outside any transaction.
- **An account takes one new lead per sample**: an assignment at or after the account's latest sample means the sample does not show it yet. The account is chosen at admission and stored (`capacity_assignments`); package 4's `start_lead` reads it with `accountOf(issue, attempt)`.
- **Stop the line**: while an incident Issue is queued or working in a project with nothing blocking it, only incidents are candidates there. A waiting or watching incident stops nothing. An incident is the fix and is urgent (it may use the one place beyond `leads: N`).
- **Plan rows**: filed with `fileIn` (key `plan:<project>:<row>`), then the row's facts as a `noted` event (the `filed` payload has no room for them), then `settled`. The Issue's `repo` is the target project's absolute path. `stable_days` is retired (NL6): read so an old file parses, flagged in the plan's warnings, never evaluated. The row's optional `kind` (default `feature`) is new.
- **Dependency waits**: the chain wakes a lead that deferred on other Issues once all have closed in any outcome (`woken`, key `woken:<issue>:dependency:<since>`).
- **Failing readings open**: a memory or load reading that fails admits without it and says so in the pass's notes; a failed account poll uses the stored readings, and a reading older than 10 minutes admits nothing.

## Ports declared

- `ProjectSource` (planning; real adapter `gitProjectSource`), `IssueReads` (planning; real `read/planning.ts`), `HostReader` and `AccountSource` (capacity; real adapters). `main.ts` wires the real ones; nothing is stubbed.
- **For intake**: `projectSignals(deps)` in `app/planning-signals.ts` is planning's side of intake's `ProjectSignals` (`find(repo)`, `polled()`); `RepoSignalsView` is intake's `RepoSignals` field for field, so `main.ts` passes it where intake asks for its port. `work` is true for a repo without a `project.yaml`; `sources` are `github`, `checks`, `launchd`. Intake's `IntakeTopology` (hosts) is not provided: `project.yaml` names a host only as `deploy.targets[].host`, and I could not tell if that is the map intake means.
- For package 4: `resumeClaim`, `releaseClaim`, `accountOf` (`app/capacity-admit.ts`).

## Events recorded on Issues

- `filed` (`fileIn`, key `plan:<project>:<row>` or `project-error:<project>:<sha>`), `noted` (the row's facts, a broken file's message), `settled` (`settleIssue`, plan rows, broken project files; key `settled:<issue>` or `plan:…:settled`), `admitted` (admission pass, key `admit:<issue>:<attempt>`), `woken` (dependency wait ended). All actor `factory`.

## Review outcome

`/review` deep, scope `fc5a8ac..HEAD`, thread `rw-3-planning-capacity`, job `rv_zppgoozyc7wzpvbaegd4`, one round. The first prepare was abandoned by another worker's (shared thread); re-run on my own thread as the orchestrator said. The first reply skipped 11 files and was refused; attempt 2 covered all. **Actionable: 2 important, 3 nits**, all fixed in `8ac82fb` and disposed `fixed`:

| Finding | Disposition |
|-|-|
| Cycle check read-then-write without a lock: two concurrent settles could commit a cycle | Fixed: `settleIssue` and `addAfter` take the capacity lock. A test settles A-after-B and B-after-A at once and fails three runs out of three without the lock |
| `runProcess` killed only the direct child and awaited the pipes, so a grandchild holding them (ssh under `git fetch`) kept the call open | Fixed: the program leads its own process group and the timeout kills the group; the pipes then get 500 ms and are let go. Tests assert the call returns in under 2 s, also for a grandchild that left the group |
| `settle` kept edges on an Issue that was not settling | Fixed: edges only for a settling Issue, otherwise `ignored` with 0 edges; test added |
| Contract lists (`QUEUE_REASONS`, `ROW_STATES`, `DEFAULT_SLOT_RUN_MS`) repeat the server's | Fixed: compile-time equality checks in the route files; the server imports the contract's default |
| `slots.run` resolution untested | Fixed: the scenario asserts `runMs` 60000 for the project dir and a worktree, 30 min without a `cwd` |

The reviewer also noted, and I left: `lead_gone` keeps the claim (a `lead_gone` stall is the steward's to end and ends in `queued`, which the sweep frees); `FACTORY_REPO_ROOTS`, `FACTORY_SLOTS` and the other new settings are not on `scripts/env-file.sh`'s allow-list (package 9).

## Open points

1. **New words for `docs/language.md`**: *claim* (a lead's place in its repo, `leads: N` plus one for a fix), *owed* (working without a claim), *queue reason* and *stays queued* (the retired "hold"), *pass* (a planning or admission pass), *window* (an account's 5-hour or weekly reset), *line* (stop the line).
2. **`deploy.hold` in `project.yaml`** is the key the factory's own file uses and it must parse; the language retires "hold" for the watch. A rename (`watch`) needs the files and the schema changed together; I kept `hold`.
3. **Cutover (package 9)**: Issues imported as `working` have no claim and count as owed, so they block admission in their repo until their lead is told something (or `resumeClaim` runs for them). Import their claims or call `resumeClaim` for each. `scripts/env-file.sh` needs `FACTORY_REPO_ROOTS`, `FACTORY_LEADS_PER_ACCOUNT`, `FACTORY_LOAD_CEILING`, `FACTORY_SWAPOUT_CEILING_MB`, `FACTORY_SWAP_CEILING_PCT`, `FACTORY_SLOTS`, `FACTORY_CLAUDE_ACCOUNT_BIN`, `FACTORY_SYSCTL_BIN`, `FACTORY_MEMORY_SAMPLE_MS`, `FACTORY_GIT_TIMEOUT_MS`. The old `slots` and `queue_states` tables are not imported (slots are leases; queue states are one `factory queue set` each).
4. **Who calls the passes**: nothing schedules `planning pass`, `capacity admit` or the account poll yet; the tick (package 4 or 7) calls `planningPass` and `admissionPass` (both in `app/`). A `settling` Issue is settled only by `planning settle` (triage in package 7, plan rows, broken project files); if triage never answers, the steward should settle it with no edges after a timeout.
5. **`/health` tick staleness** is still the tick's package. The pass results carry `notes` (a failed reading or poll) that a health line can use.
6. **Shared test edits**: `tests/scenarios/boot.test.ts` and `apps/cli/test/generate.test.ts` assumed the exact set of migrations and commands; every package would break them, so they now read the release's own list. Other packages' merges may conflict on those two lines.
7. **The generated CLI prints a declared error body on stdout** and exits with its kind (`planning after` on a cycle: stdout `{"error": …, "code": "cycle"}`, exit 5), by package 0's design; package 8 may want the message on stderr.
8. **Slot calls hit the API** (no socket any more); the slot routes carry no token until package 8, like every route.
