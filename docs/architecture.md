# Architecture: what is built

**A modular monolith on Bun: plain TypeScript and zod, Postgres as the only store, domains with no I/O behind ports,
Elysia at the edge, and a generated CLI.** It has been the running factory since the cutover of 2026-11-08. Words
follow `docs/language.md`; the rules a change must keep are in `AGENTS.md`; why something is as it is, in
`docs/decisions.md`; the teaching text is `docs/guide/`. This page says where things are and how they fit; what is not
built is the last section. A rule is one line with the symbol that holds it, and the symbol's docblock has the
reasoning. Paths not starting with `apps/`, `packages/`, `docs/`, `scripts/`, `tests/` or `config/` are under
`apps/server/src/`.

## Layout

```
apps/
  server/     Elysia app: domains, application services, adapters, read models; migrations in apps/server/migrations
  door/       the alert door: loopback, one token (`machine`), posts alerts and refusal reports to the server
  cli/        `factory`: commands generated from the OpenAPI document, plus hook, slot, land and more
  console/    the Console: a Vite and React PWA; the server's second listener serves its build
packages/
  contract/   zod schemas: every request, response and event; the OpenAPI source; the spool format the hook shares
  client/     typed client (Eden) and the CLI's transport, including the change-stream follower
  accounts/   the Claude Code subscription picker and `claude-account` (`packages/accounts/docs/accounts.md`): a pure
              rule over ports; the server reads it in-process (`adapters/planning/accounts-source.ts`)
tests/
  scenarios/  use cases against a real server and Postgres with fake hc and agw: the acceptance suite
  e2e/        Playwright against a seeded server: every Console screen, and the source of the README's screenshots
integrations/ client pieces other machines install: the Claude Code hook entries, the Herdr glance mod, rd's contract
config/       roles.json (tier and effort per role), infra.json (host to repo), throughput.json (the counting epoch)
scripts/      deploy, verify, launch, env-file, merge-guard, and the build's checks (boundaries, vocabulary, README)
deploy/       LaunchAgent templates
docs/         product, language, architecture, operations, decisions, plan format, research, evidence
```

## The server

```
apps/server/src/
  kernel/        Result, ids, clock, keys, the event envelope, agw call types, WORKFLOWS. Imports nothing else
  domains/       pure: types, rules, state machines, ports (interfaces). No I/O, no SQL, no Elysia
    intake/        signal envelope, trust and routing rules, fingerprints, incidents, correlation
    planning/      projects, plans, the chain, queue order; the steward's stall rules, settling, queue edges
    capacity/      accounts and windows, memory, load, repo claims, queue state, test slots, admission
    work/          the Issue: events, the total transition table, effects, the review wait
    leads/         attempts, the brief, notes, session state from hook events, the stop rule, the reaper
    quality/       the ship gate, evidence, the watch and verify
    checkpoints/   Decisions, artifacts and revisions, collections, the owner's pages, rechecks
    errands/       Errands and requests, need, triage by rule, match keys, the desk
    hygiene/       probes and findings, the lifecycle, scripted fixes, dependency refresh, fix causes
    improve/       the loops that watch the factory: selfwatch, overload, throughput, friction, retro, digest, ledger
  app/           use cases: one transaction to claim, the port call outside it, one to record
    loops/         the runner (`passLoop`, `createSaid`) and each loop's pass with its `LoopSpec`
  adapters/      postgres stores, hc terminals, agw, git, ntfy, blobs, intake pollers, the hook socket, uptime, otel
  api/           Elysia route groups, auth and the caller policy
  read/          read models (SQL projections) for the API and the stream
  compose-*.ts   wiring of each domain; `compose-loops.ts` hands each loop its ports and builds the runner;
                 `main.ts` boots, takes the process lock first and shuts down in order
```

**Rules, enforced in `make check` by `scripts/boundaries.ts`:**

- `domains/*` import only `kernel` and their own folder. A domain reaches another only through `app/`.
- Each domain owns its tables. `read/` crosses them and is read-only.
- A port is an interface in its domain; an adapter in `adapters/` implements it; tests use fakes of the same
  interface.
- Only the unit of work, the migration runner and the read models' bounded read (`read/bounded.ts`: read-only, with a
  statement timeout) open a transaction. A port is never called inside one: claim, commit, call, record.
- Every port returns `Result<T, PortError>`; only a programming error throws. `PortError.kind` is `timeout`, `gone`,
  `refused` or `unreadable`.
- An intake poller reads the outside world and hands signals to the sink; it touches nothing else of the server.
- `apps/cli/src/hook.ts` imports only `node:fs` and the spool half of the contract.

## The Issue machine

States (stored; screens show the five words of `docs/language.md` "Where work stands", `workOf` in
`packages/contract/src/work-words.ts`; `scripts/vocabulary.ts` fails `make check` on a state word in a screen's text):
`settling`, `queued`, `working`, `waiting`, `watching`, `closed`. `apply(state, event)` is a total table in
`domains/work/table.ts`: every cell is a transition with its effects, a named refusal or a named ignore, and a missing
cell fails `tsc`. The diagram and the wait table in `docs/language.md` are generated from it.

- **One writer.** `app/` stores the event, the new state (`UPDATE … WHERE id = $1 AND version = $2`) and the effects
  in an outbox in one transaction, then the outbox runs the effects (`app/outbox.ts`): claimed with a lease, retried
  with a doubling delay. A late event that names an old attempt, watch, wait or checkpoint is ignored or refused by
  the table.
- **The owner's pause.** `factory issue pause <id> --reason "..." [--until <iso>]` records `paused`: a working Issue
  waits as `paused` and its lead hears it once; a stall or `timer` wait is replaced by it silently; a second pause
  updates in place; other waits, an unstarted Issue, a watch and a closed Issue refuse. It is no stall (the steward
  and the Judge never see it), a lead's `block`, `defer`, `ask`, `ship` and `close` are refused with the pause named,
  and the repo claim is free. It ends with `woken` from the owner or orchestrator (`factory issue note <id> "..."
  --wake`) or once `until` has passed (the planning pass); the steward's wake is refused.
- **A review wait takes Decisions.** While an Issue waits for the verdict on a Concept or Spec, the lead may raise and
  amend Decisions about it (`wait.decisions`, each linked by `decisions.artifact_id`). The wait keeps its `since` and
  `told` and ends when the verdict is given and every such Decision is answered, in either order (`verdictGiven`): one
  `note_lead` covers both.
- **Model test** (`apps/server/test/work/model.test.ts`): a seeded generator plays random event sequences and checks
  invariants: a machine wait always has an exit that needs no person; a wait on the owner always states what it holds;
  a closed Issue reopens only by its verb, within 30 days.
- No XState, no workflow engine. Events in Postgres plus a row version are the whole mechanism (NL11).

## Signals and triage

Every input is one envelope (`source`, `kind`, `origin`, `trust`, `repo`, `fingerprint`, `title`, `text`, `link`:
`packages/contract/src/intake.ts`) and goes through `receive` in `app/intake.ts`; the answer is a triage outcome
(`docs/language.md`).

- **Sources.** The owner (`factory signal`; Hermes through the narrow `signal` caller as `owner:hermes`), agents
  (`agent:<repo>`), the alert door (Kuma and HyperDX; infra alerts come through it, not a poller), and two pollers:
  GitHub (the owner's new issues and failing checks; anyone else's need the label and are held) and launchd. `repo`
  comes from the route, the door registry or the caller, never from an outside payload. A failing check is filed as an
  `incident`: its fix goes past the repo's `leads` cap, and while it is unsolved only its fix is admitted (stop the
  line).
- **App feedback** is a door source: `POST /feedback/<app>` with the app's token becomes `POST /signals/feedback`
  (`FeedbackRequest`), from `feedback:<app>`, trust `outside`; the fingerprint is the repo (or app) and the title,
  never version or route.
- **A monitor with no route** is placed by the heal pass without the owner (`domains/intake/place.ts`: its name
  holds a project's name, or a `<name> - Push|Door` sibling is routed; `set_by` `factory:name`). One down past 10 min
  with no place is filed in `FACTORY_HOME_REPO` when set, else held after 6 h (`unroutedHeldMs`) as a signal with no
  repo.
- **Backlog sweep.** With `FACTORY_GITHUB_BACKLOG=1` the first GitHub pass after a start also files every open issue
  of each polled project (`writeback: false`; everyone but the label and the owner is `outside`, held). Unset it
  after.
- **Who may file where** (`domains/intake/rules.ts`): a work repo hears only the owner (NL18), an unknown repo no one,
  a project the automatic sources its `signals:` lists. A lead's signal about an Issue the owner filed (origin `you`)
  is held, not dropped, so the owner can promote work it owes a work repo; any other agent signal to a work repo is
  dropped (`work_repo`). The `screen` loop never reads a work repo's signal.
- **Incidents.** Monitoring alerts on one host or dependency inside `FACTORY_INCIDENT_WINDOW_MIN` join one incident
  and one Issue.
- **Amend or new.** A loop's finding (`intake.api.file` with a `LoopFinding`) is matched by its key alone
  (`findingKeyOf`: loop, class, repo, subject): an open Issue of that key takes it as a note, one closed within its
  repeat window counts it as a repeat (24 h from the filing, or `LoopFinding.repeatWindowMs` from the close), else it
  files anew; no title match, no workflow call. Any other signal that clearly overlaps an open Issue's title amends it
  and reaches its lead as a note; otherwise, unless a fingerprint, subject or open incident settles it, the
  `factory-triage` workflow sees the repo's open Issues and those closed in the last day and answers amend `<Issue>`,
  "already settled" (acked `dropped`, stored dismissed by the judge) or neither. `POST /signals` waits for it at most
  `triageWaitMs` (8 s); later it files anew and the run goes on unwatched, and the same signal sent again rejoins it
  by its key. A signal with the retro marker (`Retro: <date> kpi=…`) skips both and files its own Issue. A `down`
  waits out a heal grace as `held`; an `up` inside it is `healed`, and a project's heal rule runs `make restart` in
  its repo (`adapters/intake/runbook.ts`) before an Issue is filed.
- **Quarantine.** An outside signal is held and reaches a lead only when the owner or the Judge promotes it, fenced as
  data. A later outside signal with a promoted one's fingerprint amends the Issue while it is open (`noted`, fenced),
  else is held anew. A quarantined signal can be dismissed (`POST /signals/:id/dismiss`, owner or Judge, a reason of 1 to 500
  characters; `dismissed_by` is `owner`, `judge` or `probe`); only a quarantined signal can be dismissed or promoted. A
  **probe** (`probe: true`) passes the guards, is stored dismissed by `probe`, files nothing and never reaches triage.
- **Screen.** The `screen` loop has the Judge look at quarantined signals; its verdict can only promote, dismiss or leave the
  one signal it was shown (`domains/intake/screen.ts`), and a promoted signal's text stays outside text, fenced in the
  brief.
- **Loop guard.** A change a loop made never fires that loop again.

## Capacity and leads

What runs on this host, and why an Issue waits. The reasons are in [the capacity guide](guide/capacity.md) and [the
leads guide](guide/leads.md). Every setting a settings loader reads, with its default and what it tunes, is in
[settings](settings.md), generated from the loaders. The CLI reads a few knobs of its own, which the table does not
list; the two that pin a step are named under Steps off the mini. Each rule names the symbol that holds it.

**Admission** (`domains/capacity/admission.ts`) is pure and decided again at every claim, in this order:

- **Queue**: `drain` starts nothing.
- **Doctor** (`domains/capacity/doctor.ts`, `adapters/doctor/`): the project's `doctor` target says whether this host
  can run it. A red reading holds the project's Issues queued, with the reason in its first lines, and skips its
  hygiene `check` probe. A doctor that cannot run admits.
- **Boot grace** (`domains/capacity/boot.ts`): for 30 minutes after boot, no lead until the newest samples show low
  load and memory; then one lead every 2 minutes.
- **Load and processes** (`domains/capacity/host.ts`, `hostRule` in `app/planning-settings.ts`): a load ceiling in
  multiples of the cores and a process-count cap, always on. The panic class is a process storm, not memory.
- **Memory**: the swap-out and swap ceilings, then the **learned fit** (`learnLeadCost`,
  `domains/capacity/leadcost.ts`): a repo's lead is the median of its newest ten attempts' peaks, set against the free
  memory of the newest host sample less headroom and less what young leads still take (`leadGrowth`). A falling cost
  is believed after three settled attempts. Refusal kind `memory`.
- **Disk fit** (`domains/capacity/disk.ts`).
- **Lanes and claims**: `lanes` in `project.yaml` caps a resource inside a repo (`domains/capacity/lanes.ts`);
  `leads` in `project.yaml` caps the repo's claims. A fix is never held.
- **Test line and lead aim**: `lineRefusal` (`domains/capacity/admission.ts`, kind `tests`) and `leadAimStep` hold new
  leads; see Test slots.
- **Seats** (`domains/capacity/allowance.ts`): each account has its own lead cap, raised by a bounded bonus while the host
  is idle. The repo's own cap is never raised, and no account goes past its window.
- **Account**: `packages/accounts` alone decides which accounts are open and in what order
  (`adapters/planning/accounts-source.ts`); the server keeps no window limit of its own. An account a turn ended on a
  401 for stays closed until its login Errand closes (`account_auth_marks`). A reading not renewed for ten minutes
  admits nothing.

**Walls and moves.** A lead that runs into an account's limit (`limit_stop`) stalls as `wall` and waits for the
window's reset (`wallResetAt`, `windowOf`). While its account is closed and another is open with room, the steward
moves the lead (`seats.move`, `moveWalled`, `noteLead`): the same session resumes under the other account's
`CLAUDE_CONFIG_DIR`.

**Owed Issues first.** A woken lead is the same session on its admitted account, so the account cap never refuses its
resume; a herd woken at once takes the repo's places oldest wait first.

**API errors** (`domains/leads/apierror.ts`, `kindOfApiError`, `app/leads-api-errors.ts`). Claude Code fires
`StopFailure`, not `Stop`, when a turn ends on an API error: the hook spools `api_error`, and a turn silent too long
has its transcript read (`TranscriptTails`). Transient errors (429, 5xx, a timeout, a 403 `authentication_failed`) get
one `continue` after a growing delay, at most five per incident; three leads failing within five minutes are one edge
incident, staggered (`STAGGER_MS`). An auth error (401, a revoked token) marks the account and raises one login
Errand.

**The lead's life**

- **Start** (`app/leads-start.ts`): claim, worktree `factory/<issue>-<attempt>`, terminal, then the brief
  (`domains/leads/brief.ts`).. The standing orders are byte-identical in every brief, so the prompt cache serves them.
- **Hooks**: `factory hook` appends to the spool and posts to the socket; the server replays the spool with idempotent
  keys. Session state is derived when read, never stored.
- **Notes** (`app/leads-note.ts`): typed once; the delivery key is claimed before the typing. A note from the owner
  binds the lead. The factory's, the steward's and the Judge's notes are data.
- **Quiescing** (`app/leads-quiesce.ts`, `domains/leads/quiesce.ts`): a lead quiet in a wait is ended and marked
  dormant; worktree, branch and session id stay. Never quiesced: a stall, a turn in progress or with background work,
  a lead with a process under it, a slot in its worktree. The wake is `claude --resume` (`HcTerminals.revive`) with
  `--strict-mcp-config` (`HcTerminals.argv`). A live terminal that runs no agent after a restart is a lost lead
  (`followLeads`, `lead_losses`).
- **Stop rule** (`domains/leads/stop.ts`): a lead that stops with nothing reported is sent back once; the next stop is
  let through, since a finished background task can restart it.
- **Finalize** (`app/leads-finalize.ts`): claim back, terminals closed, transcripts archived, worktree and branch
  removed when clean and on the base. On close, every `factory/<issue>-*` branch goes once its work is on origin's
  default (`adapters/git/branches.ts`).

**Backoffs** (`kernel/backoff.ts`). A Judge's answer that reads as a backoff makes the wait a timer: one hour, doubling per backoff, at
most twelve.

### Replan

A Replan is an Issue (`Replan: <project>`) whose lead rereads the plan against the open and recently closed Issues and
proposes changes as a Spec: new, changed or dropped rows, `after` edges to add or remove, Issues to cancel or re-file.
Every non-obvious choice is a Decision raised before the Spec is submitted. The owner files it with
`factory planning replan <project> [--ask "..."]`; the planning pass files one when a timed wait of
`FACTORY_LONG_WAIT_MS` or more has Issues behind it, and when a row with `after_needs: shipped` is held behind a
dropped or cancelled row (trigger `held`: its note names each held row and the Issue holding it; one Replan covers
every held row of the project, and a hold that was answered with "no plan change needed" files no second one). It also
files one when a head has waited on the owner for two hours (an open Decision, a Spec under his review such as an owner
gate's, an Errand) with open Issues or unfiled rows behind it: trigger `stalled`, once per head and wait, its note naming
what the owner is asked and every Issue and row behind the head. A gate holds what needs its answer, and that Replan frees
the rest: per direct dependent its Spec says in one line whether it needs the answer or the head's output, and a
dependent is freed only when its work stands under every answer the owner can give and a revert undoes it. A freed Issue
is an edge removal; a freed row is the head taken out of its `after`, named in the block's `free` list (`plan` lists every
other change to a row). A proposal whose `plan` is empty and that cancels nothing is settled by rule and applied at once,
the plan edit through the ship path; any other change is screened for the owner. Needs you shows on each item what it
holds, and on the head's card what went ahead without the answer. One is open per project at a time; asking again while it is open
adds the words to it as a note. On a verdict of Looks good the lead edits `docs/plan.yaml` through the
project's ship path and applies edge changes and cancellations with `factory issue replan <id> --attempt <n> --body '<json>'`. The server gates
that verb: the Issue must be a Replan its lead works on (current attempt), its latest Spec revision must carry a Looks
good verdict, and every Issue it re-edges or cancels must be an Issue of the Replan's own project (a
blocker may be any open Issue; one exception: a removed edge's dependent may be another project's open Issue when every Issue it
waits after is of this project, since removing the edge only frees it). The whole call is refused otherwise, nothing applied; each op then answers for itself, and
a repeated `call` changes nothing more. The owner-only edge and cancel routes stay shut to a lead: the verb is what an
approved Spec buys. It acts as the orchestrator, so the owner-touch counts stay the owner's alone. Code: `app/planning-replan.ts` (`applyReplan`, `withdrawIssue`), `factory.replans`. The only cancel is `factory issue withdraw`.

**Test slots** (`domains/capacity/slots.ts`). `factory slot run` takes a host-wide slot around each heavy command; a
wait past 45 minutes exits 75. A server that is down grants host-local slots (`~/.local/state/factory/local-slots`),
so repair still runs.

- **Grant**: a base count of slots and a cap above it. A step beyond the base waits while the load tripwire holds
  (`loadTrip`, `SUSTAINED_LOAD_SAMPLES` in `domains/capacity/host.ts`: over the lead ceiling in each of the newest
  five minute samples). While swap grows or the tripwire holds, only the first step runs, base slots included.
- **Fit**: a step's peak is learned per project (`stepNameOf`, `domains/capacity/costs.ts`) as the p80 of its eight
  newest runs; a step with nothing learned is sized by a prior and never refused (`stepPrior`). Free memory is the
  kernel's (`freeMibOf`, `kernel_free_pct`).
- **Order**: `lineOrder`. A small step passes a head that does not fit; a passed head's memory is reserved after ten
  minutes (`reservedStartMs`). Exclusive steps (`exclusiveStepOf`): an `apple` step runs one at a time, whichever repo
  runs it.
- **Aim** (`domains/capacity/slot-aim.ts`, `app/capacity-aim.ts`): once a minute the slot count moves AIMD on the
  kernel's pressure level and swap (`factory.slot_aim`, `factory.slot_shadow`). The lead aim (`leadAimStep`,
  `slot_aim.lead_target`) gates lead admission and fails closed without a pressure reading.
- **Waits**: each wait counts its reason in `factory.slot_waits`; `factory read capacity-loop` shows the split.
- **Results**: each step writes `factory.step_costs` and its JUnit results (`apps/cli/src/junit.ts`,
  `factory.test_results`). Only a run inside a slot reports.

### Steps off the mini

A repo names its steps in `project.yaml` (`docs/project.md`); `remote: true` says a step passes in the step image on
Ubuntu 24.04. The step host is the owner's setting ([settings](settings.md)). One call can be pinned to a host with
`FACTORY_SLOT_HOST=mini|vps`, or kept on the mini with `FACTORY_SLOT_REMOTE=0`; the CLI reads both
(`apps/cli/src/slot.ts`), so they are not in the table.

- **Placement** (`app/capacity-slots.ts` `touchSlot`, `domains/capacity/remote.ts`): the VPS takes a step when
  `decideRemote` finds room and `finishesSooner` holds. A caller may run off the mini when the mini makes it wait, or
  when a slot is free but the VPS is learned to run the step in less time (issue 2668). A step that needs what only
  the mini has (`mac`, `apple`, `secrets`, `services`), or the exclusive step `apple`, never leaves the mini. Sooner:
  the learned VPS run against the expected mini wait (zero when a slot is free now) plus the mini run.
- **Pressure line** (`kernel/remote-pressure.ts`): the VPS's own memory and io stall against a p99 baseline.
- **Why** (`step_placements`): `free`, `no_room`, `not_sooner` or `held`.
- **Run** (`apps/cli/src/remote-step.ts`): the worktree travels as a git snapshot (`commit-tree`) into a bare
  repository on the host. The image is built once per content and revision (`IMAGE_REVISION`). Install runs with
  network, the step without, under a memory ceiling of 1.5 times the learned peak.
- **Results**: the exit code is the step's own. ssh's 255 and docker's 125 to 127 are the host's failure: the step
  goes back to the mini's line. A red on the VPS runs again on the mini, and only that result counts; a green there is
  `disagreed`.
- **Bench** (`kernel/remote-bench.ts`, derived from the ledger): a disagreement benches the step on the mini for an hour,
  doubling up to seven days; the first green VPS run halves it.

## Quality

- **Ship** (`app/quality-ship.ts`, `domains/quality/gate.ts`). The lead names the merged commits, or none and the
  factory finds what the Issue's branches landed (`Commits.landed`, by content: the first default-branch commit that
  holds every file the branch changed, or the first-parent commit that brought a merged branch in). Git must find them
  on the default branch and newer than the Issue's cut (its first attempt's); the lead's word is never taken.
  Refusals: no such commits; an Issue flagged `checkpoint: spec` with no Spec (see Checkpoints); after a Watch
  regressed on the default branch's CI, a ship while that CI is still red for the commit it lands at (`ciStillRed`,
  NL42); a repeat ship after an alert regression that names nothing new while the alert is still down
  (`afterAlertRegression`, `alertStillDown`); under deploy mode `make`, a deploying change while `make version` names
  a commit that does not hold the landed one (`notDeployed`, NL49).
- **Evidence, never a refusal.** Review: recorded when agw's ledger covers the range, its absence with the reason; a
  commit agw routes to light is `not_required` (NL12, NL23); `factory issue ship` prints the range to `/review` when
  it is `uncovered`. Acceptance: one `--acceptance "met: ..."` or `"not met: ..."` line per acceptance line of the
  Issue, normalised, cut at 500 characters, a malformed line refused (422) with the corrected line; a ship that states
  none is friction (`unstated_acceptance`). CI: the pull request the commits landed through and its head's CI (`Ci`
  port, `adapters/quality/ci.ts`; `green`, `red`, `running`, `missing`, `unknown`); red or missing is friction
  (`unproven_ci`). A project that ships by push, or has no `project.yaml`, records no `ci` evidence.
- **Which paths deploy** (`domains/quality/evidence.ts`): its built-in inert paths equal `scripts/verify.sh`'s; a
  project's `deploy.paths` globs narrow that (a path deploys only when a glob names it and it is not inert). The gate,
  the watch's `deployedHolds` and `ProjectChecks.deployPaths` all read it.
- **Watch and verify** (`domains/quality/watch.ts`, `app/quality-watch.ts`). The project's `make verify` and probes
  run on the `watch` loop, so a slow verify never holds the leads' pass. What it runs is the synced `project.yaml`
  (`app/quality-projects.ts`: deploy mode, `hold` as the window, the `make verify` target, URL targets, probes); a
  repo without one is read from its Makefile (`adapters/quality/projects.ts`). Only mode `make` reads `make version`.
  A red check is retried with a doubling delay before it is a regression; a regression returns the Issue to its lead,
  twice, then it stalls. A checkout that cannot be read is rechecked, never passed.
- **Inherited reds.** A `make` target that failed the same way (every failing line, numbers aside, among theirs) in
  the repo's last finished run before the ship, or in the last run of another Issue's watch that regressed in the last
  day and is unanswered, is stored `inherited`: it counts green, is never retried and stays on the Issue's page (one
  red, one owner). A CI red whose merged commit's first parent was red on the same first failing check is inherited
  the same way.
- **CI of a pull-request repo** (`ship:` `via: pr`). Verify reads the default branch's CI for the exact merged commit
  (`mergedSha`: the first-parent commit that holds the ship's commits, never the branch tip): green passes, red is
  red, a run still running or not yet visible within 10 min is neither and is looked at again after
  `FACTORY_VERIFY_RECHECK_MS`; one running past an hour is red; none after 10 min passes with that said. A pending CI
  wins over a red `make verify` until it settles (`outcomeOf`).
- **Reopen** (`app/quality-reopen.ts`) is the owner's, within 30 days of closing.

## Checkpoints

A lead's wait ends at a checkpoint: a Decision, an Errand (a person's hands), a Spec or Concept (a verdict), or a pull
request's review by someone else. Each rule is one line with the symbol that holds it; the reasoning is in
`docs/guide/checkpoints.md`. Paths are under `apps/server/src/` unless shown. The waits are in `domains/work/table.ts`
(`waitHint`); the verbs in `app/checkpoints.ts`, each sub-machine in its `app/checkpoints-*.ts` sibling.

**Decisions** (`domains/checkpoints/decision.ts`)
- A form with a missing field is refused: 422 `missing_field`, nothing stored (`askDecision`).
- A recommendation to keep waiting is refused (`refuseNoOpDefault`); what waits on a person is an Errand.
- Settled in order: the Judge (`factory-ask`), the default after its wait when reversible, then the owner. Three Judge
  tries, 5 minutes apart (`decision_steps.tries`).
- A second ask from the same asker amends the open Decision; `guardVerdict` checks the Judge's answer.
- A lead that built on its default settles it with `factory decision take-default` (`takeDefault`).
- The Judge may send a lead's own Decision back to its lead on its first look (`sendBack`, `mayGoBack` in
  `app/checkpoints-loop.ts`): the step is `back`, the `noted` event that carries `back` is typed to the lead though the
  Issue still waits (`noteWaiting`, `domains/work/table.ts`), and the Decision stays open, out of Needs you and unpaged
  (`sendBackIn`). The lead settles it (`take-default` takes the default, or with none its reversible recommendation) or
  asks again, which amends it; the second look answers or hands it to the owner, never back twice (`sentBackBefore`).

**Errands** (`domains/errands/`, `app/checkpoints-errands.ts`)
- Need is `secret`, `hands`, `approval` or `place` (`domains/errands/need.ts`). A stated need is checked for presence,
  never stored.
- Before the owner sees it: rules, then `factory-errand`, then the owner. Rules: `screenByReview`, `screenByRule`,
  `screenByNeed` (`domains/errands/errand.ts`); `refuseKeyless`, `refuseBotCheck`, `refuseOffMacbook`, `verbFor`
  (`domains/errands/triage.ts`); `declinedMatch` (`app/checkpoints.ts`, `DECLINE_HOLD_MS`); `refuseHostClass`,
  `refuseUndialogable` (`domains/errands/errand.ts`). A refusal stores one `errand_refusals` row.
- The same need joins the open Errand (`matchKey`, `app/checkpoints.ts`); `eachJoined` tells every joined Issue how it
  ended.
- `--check` closes the Errand itself (`runCheck`, `resolveErrand`): exit 1..125 closes `not_needed`; 127 is `broken`
  (`checkVerdict`, `tellCheckBroken`).
- The desk pass (`app/loops/desk.ts`, `domains/errands/desk.ts`) pushes MacBook dialogs through the dotfiles'
  ask-human script (the caller is `pushQueue`, `adapters/shell/ask-human.ts`), for `secret` and `hands` only. A
  `place` waits on Needs you; an `approval` never goes to the MacBook.
- Fixed gate verbs run with no dialog (`askHumanVerbs`); a class the owner granted runs by itself
  (`kernel/auto-run.ts`).
- A done is checked: `finishErrand` reopens an Errand whose check still says needed, and keeps a failed run open
  (`run_*` columns). A command that fails twice ends (`retireFailed`, `MAX_RUN_TRIES`).
- Approve (`app/checkpoints-approve.ts`): the owner runs an `approval` on the mini. It is recorded consent, not a
  barrier.
- Turn back closes the Errand `turned_back`; the lead hears the note. The orchestrator's done needs `confirmedBy` and
  is never for `approval` (`finishErrand`).
- A request is an Errand no Issue raised (`domains/errands/request.ts`, `requestErrand`, `SCREENED_SOURCES`). It
  expires 7 days after filing without a check; a new request with the same `request_key` supersedes the open one.
- Recheck: an Errand or Decision in front of the owner past `FACTORY_CHECKPOINT_RECHECK_MS` (6 h) is looked at again
  (`recheckOpen`, `withdrawalReason`); each look is a `checkpoint_rechecks` row.

**Specs and Concepts** (`domains/checkpoints/spec-screen.ts`, `app/checkpoints-specs.ts`)
- A Spec flag (`checkpoint: spec`, or `gate` for one only the owner's verdict ends) owes a Spec. `shipIssue`
  (`app/quality-ship.ts`) refuses the ship until one exists.
- A Spec goes where `specPathOf` says, by rule alone (NL53): a lead's Spec is its plan, recorded at `artifact submit`
  (`recordedAsPlan`) as settled with no wait and no page; an owner gate's, a filed one, a revision after Changes and a
  Replan that changes a plan row wait and are passed to the owner by `screenSpecs`. `factory-spec-screen` is not called.
- No verdict within `SPEC_WAIT_HOURS` (24 h, `packages/contract/src/lane.ts`): `recheckReviews`
  (`app/checkpoints-reviews.ts`) defaults it to `looks_good` by the factory, or `no_longer_applies` when its Issue
  closed.
- The orchestrator may give a Spec's verdict (`delegateRefusal`), never a gate's or a Report's; the owner's verdict
  replaces it (`replaceDelegatedVerdict`).
- A filed Spec (`factory issue new --spec`) is stored as `filed-spec:<issue>` and starts no wait.

**Reports and collections** (`adapters/postgres/collection-store.ts`, `adapters/postgres/checkpoint-store.ts`)
- A Report with no Issue never waits or reaches Needs you; `artifact link` names the Issues it concerns, `artifact
  retire` hides it. A collection groups pages under one lead page; a page belongs to at most one (`409 refused`).

**Pull request reviews** (`adapters/reviews/pr.ts`)
- A required review by someone else puts the Issue in the `external` wait. The `reviews` loop reads each such pull
  request every 15 minutes and wakes the lead on an approval, a change request, a comment, a merge or a close
  (`factory issue defer --review`).

## Loops and agw

A loop is a named tick (`app/loops/runner.ts`: `LoopSpec`, `passLoop`) with a trigger (an interval, or a kick when
something changed), a budget and single-flight passes; `factory loop list` shows each loop's interval, kicks and
passes. Its deterministic part runs in the server; its judgment is a dedicated agw workflow with its own prompt, tools
and skills (`agent-workflows`), called through the agw port with an idle watchdog (`AGW_IDLE_MS`, 10 minutes: an `agw`
process that prints nothing for that long is killed with its process group; `agw` ends a pending wait every 110 s, so
a live run is never cut by the clock). A call is recorded in `loop_calls` under its key, so the next boot takes it up
again. The clock runs from the loop's last pass (`loop_passes`), not from boot, so a 6-hour loop still passes on a
server that restarts on every deploy.

Every workflow the factory asks is one entry of `WORKFLOWS` (`kernel/workflows.ts`): its agw name, request and answer
schemas, the prefix of its idempotency keys and its retry rule. A caller asks `agw.run(name, request, key)`; the agw
port (`adapters/agw/port.ts`) is the only code that knows `agw`. Each entry has an example in
`packages/contract/fixtures/loops.json`, parsed by `apps/server/test/loops/wire.test.ts` together with the copy
agent-workflows holds when it is checked out. An entry marked `failsWhenUnavailable` answers a failed model run with a
neutral result whose reason starts "<name> unavailable:"; the port reads that reason and turns the answer into a
failed call (`gone`), so the retry runs and nothing is recorded as asked, settled or paged on it.

**The case file.** The port the loops get is wrapped (`casedAgw`, `app/case-agw.ts`): every request of the seven judges
(the Judge, the steward, triage, the queue, the screen, both Errand screens) carries `case` (`JudgeCase`,
`packages/contract/src/case-file.ts`; agw's twin is `factory-case.ts`): the Issue as filed and the notes of its filing,
the owner's notes, the repo's brief (its stored `project.yaml` and the head of AGENTS.md from the main checkout's default
branch, `adapters/git/agents-head.ts`), its open Issues with their first words and open edges, the plan rows around the
Issue, this judge's earlier answers in the repo (outcome `unknown` until the judge ledger reads it) and, for the steward,
the lead's last words (`pane`). The database's parts are one bounded read (`read/case-file.ts`), made when the call is,
so never inside a transaction; every text is scrubbed, and a case over `CASE_MAX_CHARS` loses its oldest open Issues and
precedents first (`fitCase`). The Judge also gets `facts` (the Issue as filed) and `checkout`, the path its read, glob
and grep work in. A work repo's case is sent like any other (NL22); the read surface shows none of it (NL18). A case that
cannot be read is left out and the call goes ahead.

The loops, their default intervals and the workflows their code asks (generated by `scripts/loops-table.ts`; `make
docs-check` fails when it is stale):

<!-- loops-table:begin (scripts/loops-table.ts) -->

| Loop | Interval | Asks agw |
|-|-|-|
| `leads` | 10 s | none |
| `planning` | 10 s | none |
| `watch` | 10 s | none |
| `checkpoints` | 10 s | `factory-ask`, `factory-errand` |
| `send` | 10 s | none |
| `steward` | 10 s | `factory-steward` |
| `triage` | 10 s | `factory-triage` |
| `queue` | 10 s | `factory-queue` |
| `friction` | 15 min | none |
| `hygiene` | 15 min | `factory-hygiene` |
| `screen` | 10 min | `factory-screen` |
| `fix-causes` | 6 h | none |
| `selfwatch` | 5 min | none |
| `ci-ledger` | 15 min | none |
| `host` | 1 min | none |
| `reaper` | 5 min | none |
| `digest` | 3 h | none |
| `errands` | 1 h | `factory-errand-needed` |
| `reviews` | 15 min | none |
| `desk` | 15 min | `factory-errand` |
| `throughput` | 24 h | none |

<!-- loops-table:end -->

What each decides in code and what it files:

- `leads` (`app/leads-tick.ts`): spool replay, start, notes, finalize, the outbox. `planning`
  (`app/planning-pass.ts`): reads projects, files plan rows (`docs/plan.md`) whose `after` rows closed, marks the
  chain, wakes dependency and timer waits whose time has come, files a Replan for a project whose chain head sits in a
  long wait or has waited on the owner for two hours with work behind it (`read/owner-waits.ts`). `watch`: verify and probes (Quality).
- `checkpoints`, `send` (`app/checkpoints-loop.ts`, `app/checkpoints-pages.ts`): rechecks of checkpoints at the owner
  past `FACTORY_CHECKPOINT_RECHECK_MS`, Decision steps (the Judge, `factory-ask`), unscreened Errands
  (`factory-errand`) and Spec revisions that wait (by rule), and the owner's pages.
- `steward` (`app/loops/steward.ts`, `domains/planning/stall.ts`): wake, re-check, requeue, deliver, nudge a quiet
  lead, note a watch whose checkout stays blocked, break a claim deadlock; `factory-steward` says what a stalled Issue
  needs when the rules do not. While a project has a live lead it reads the main checkout once a pass from local refs
  (`domains/leads/checkout.ts`): off the default branch or dirty is a `main-checkout` health line and, when the branch
  is a live lead's, one note to that lead.
- `triage` (`app/loops/triage.ts`): fingerprint, routes, correlation window; `factory-triage` in settle mode names the
  Issues an Issue must wait for (held to evidence, below), in amend mode the open or settled Issue a signal belongs
  to.
- `queue` (`app/loops/queue.ts`, `domains/planning/queue-edges.ts`): per repo, cycles in the chain, queued Issues that
  wait for nothing, the queue's shape (asked once per shape), the sweep of edges the factory added. `factory-queue`
  answers `after` edges and a tie-break order, recorded in `loop_calls` and read by admission after size. One ask per
  repo per `FACTORY_QUEUE_GAP_MS`, three repos a pass; never against the owner's `prio`.
- `friction` (`app/loops/friction.ts`, `domains/improve/friction.ts`): the week's counts (`read/friction.ts`), cut at
  the counting epoch, against rules: a rate per Issue closed with a minimum sample of 10, or a bare count for the
  serious patterns (a lead that stopped reporting, lead lost, undelivered note; a regression is 0.05 per Issue closed
  from 3). One signal per pattern, 5 a pass (`kernel/signal-budget.ts`, shared by all four signal loops). A pass is
  due after a day or 200 closed Issues (`friction_passes`). It files the retro signal when none went out in 7 days
  (`domains/improve/retro.ts`): an Issue whose lead reads `factory retro --days 7`, writes a Report opening with the
  three largest sources of waste (`read/retro-waste.ts`) and files a signal per change with a `Retro:` marker.
- `hygiene` (`app/loops/hygiene.ts`, `domains/hygiene/`, `adapters/hygiene/`): one project a tick, a throwaway
  checkout of its default branch swept by the probes of `packages/contract/src/hygiene-catalogue.ts` (rendered as
  `docs/hygiene.md`; no probe calls a model). A full pass weekly (`FACTORY_HYGIENE_EVERY_MS`: every probe, the
  project's own, then the judgment), a daily pass of the daily probes; an idle repo's full pass is monthly.
  `factory-hygiene` reads stale and recently edited documents against the code (retried every
  `FACTORY_HYGIENE_RETRY_MS`, 3 attempts). At most 5 findings a project and pass, one signal and Issue
  (`batchSignalText`), a row per key in `loop_findings`. A probe with a `fix` (`stale`, bun `deps`) is fixed by script
  first (`adapters/hygiene/fixes/`, `domains/hygiene/hygiene-fixes.ts`); for a pull-request repo the bump lands as a
  pull request on `factory/hygiene-deps` inside the merge window and nothing is deployed (NL44, NL46). `planLifecycle`
  (`domains/hygiene/hygiene-lifecycle.ts`) reads each Issue through its keys: healed and closed when every probe ran
  green and no lead started, a lead told which keys are green, a red key of a done Issue reopens it (twice at most).
  `deps` and `advisories` fold into one finding per repo, filed past the bar of `docs/hygiene.md`
  (`domains/hygiene/dependency-refresh.ts`). A project's settings are `hygiene:` in `project.yaml`
  (`docs/project.md`).
- `selfwatch` (`app/loops/selfwatch.ts`, `domains/improve/selfwatch.ts`, `domains/improve/overload.ts`): twelve
  deterministic conditions, no model; all but `budget_breach` are the factory itself on this repo. The kinds are
  `migration_clash`, `wait_overdue`, `lead_idle`, `inert_regression`, `heartbeat_stale`, `process_growth`,
  `swap_growth`, `process_storm`, `load_over_ceiling`, `slot_line`, `gates_passed` and `budget_breach` (a project's
  `budgets:` against its last 24 hours of `step_costs`, `readBudgetFacts` in `read/throughput-loop.ts`). The host
  kinds read the host loop's rows; the overload kinds (`load_over_ceiling`, `slot_line`, `gates_passed`) carry an
  evidence block (`overloadEvidence`). A subject is its newest row in `loop_findings`: filed once and through the
  finder gate; the same evidence files nothing; changed evidence is filed again, which intake turns into a note on the
  open Issue; a subject that no longer holds is cleared. A red default branch is filed by `signals.github.checks`
  alone. `docs/guide/loops.md` lists the kinds.
- `ci-ledger` (`app/loops/ci-ledger.ts`, `githubCiLedger`): the finished workflow runs of this repo and of every
  stored project, queued, started and finished per run in `factory.ci_runs` (pruned after 30 days). An unreadable repo
  is a note in the pass.
- `screen` (`app/loops/screen.ts`, `domains/intake/screen.ts`): up to 10 quarantined signals not yet screened, one
  `factory-screen` call each outside any transaction. The answer is checked before anything is done (a promote needs a
  known non-work repo, a duplicate must be an open Issue it was shown, else `leave`), then promote or dismiss as
  `judge`. A failed call leaves the signal held with a backoff of `min(10 min * 2^n, 6 h)`, 5 attempts; a quarantined signal
  72 h old (`FINAL_SCREEN_MS`) gets a last look whose `leave` is replaced (`decideFinal`) by promote, for a known
  non-work project, or dismiss.
- `errands` (`app/loops/errands.ts`): hourly over open requests (Errands no Issue raised): past `expires_at` closes
  `expired`; with a `check`, up to 20 a pass, exit 0 keeps it, 1..125 closes `not_needed`, anything else is noted;
  with none, from 24 h old and daily (5 a pass), `factory-errand-needed` reads it and only `not_needed` with a reason
  closes it, by `judge`. Closures not by the owner are listed in `GET /v1/since`.
- `reviews` (`app/loops/reviews.ts`): every 15 min (`REVIEW_POLL_MS`) over Issues in an `external` wait, `gh pr view`
  or `glab mr view` in the repo's checkout: an approval, a change request, a comment by someone else, a merge or a
  close wakes the lead (`woken:<issue>:external:<since>`); a failed read changes nothing.
- `desk` (`app/loops/desk.ts`, `domains/errands/desk.ts`): asks every 15 min whether the desk pass is due (the owner
  back after 2 h, the MacBook answering after it was down, the Console's button, 6 h since the last, a command never
  pushed), then runs checks, a second Errand screen (`rescreenErrand`) and pushes MacBook commands through the
  dotfiles' ask-human script, all of them on a return, one a pass while he is away.
- `fix-causes` (`app/loops/fix-causes.ts`, `domains/hygiene/fix-causes.ts`): every 6 hours, per project, the
  conventional `fix` commits of 35 days on origin's default branch (`adapters/hygiene/fix-commits.ts`) classed by rule
  into `fix_commits` (`FIX_CAUSES`, `docs/product.md`). No model.
- `host` (`app/loops/host.ts`, `domains/capacity/classes.ts`, `adapters/planning/snapshot.ts`): every minute, one
  reading of the host in `host_samples` (load, memory as Activity Monitor counts it, swap, the kernel's pressure level
  and free share, compressor, processes, CPU) beside that minute's capacity facts (`leads`, `queued`, `seats`,
  `load_ceiling`); one `lead_samples` row per attempt worktree (RSS and footprint, `domains/capacity/leadcost.ts`;
  steps under a `factory slot run` are not charged to the lead); and the **class snapshot**, every process joined from
  `top`, `ps -Eww`, `launchctl list` and the cwd `lsof` and given the first class that holds: `step`, `lead`,
  `factory`, a tenant (a VM or a launchd job's label), `system`, `owner`, `other`. It stores `host_class_samples`,
  `host_process_samples` and the hourly `host_class_hours` rollup, and runs the slot aim (`app/capacity-aim.ts`) in
  the same pass. `GET /v1/host` reads it.
- `digest` (`app/loops/digest.ts`, `digestOf` in `domains/improve/digest.ts`): every 3 h, per project with an Issue
  open or closed in 7 days, built in code from the Issues (no port) and stored in `project_digests` when its hash
  differs. `GET /v1/projects/digests` counts work by `workOf` from the Issues now.
- `throughput`: once a day, no model; see The throughput loop.
- `reaper` (`app/loops/reaper.ts`, `domains/leads/reaper.ts`): every 5 min ends the processes of closed lead attempts
  (`lead_finalizations.done_at`; an attempt with no row counts as live). One `ps -Eww` and the `lsof` cwd map give
  each process its `FACTORY_SESSION` and directory; a leak is a process whose session names an attempt closed over 5
  min with no live twin, or whose directory lies in such an attempt's worktree (a kept worktree is exempt from the
  path rule). Unknown processes, pid 1, this server and its ancestors are never touched. SIGTERM first, SIGKILL on a
  later pass; each signal is a `reaped_processes` row.

**Inferred edges** (`checkSettle`, `domains/planning/settle.ts`). A settle answer's `after` edge stands only when the
filed title or text names the blocker (`Issue 1177`, `issue_1177`, `#1177`): a shared file or topic is no evidence. An
Issue the owner ranked at `prio` 400 or above (`RANKED_PRIO`) takes none, and the owner's `--after` is stated, not
inferred. A dropped edge is recorded in the call's detail (`dropped: <why>`); one that stands carries
`planning_edges.inferred_by` (`triage: <reason>`, `queue: <reason>`; null when stated) and the queue reason says it.

**Edge readiness** (`planning_edges.ready_since`, `QueueEntry.readyWithoutEdges`, `recordReadiness`). Each admission
look decides an Issue its edges hold a second time as if they were gone. The first look that finds it admissible sets
`ready_since` on its unsatisfied edges; a look that finds it refused for another reason clears it; a satisfied edge is
never touched. An edge with `ready_since` held idle capacity until `satisfied_at` (not needed); one without held it
while something else would have refused it (needed). Readiness is judged per Issue: two Issues behind one free lead
each read ready.

**Finders** (`domains/improve/finders.ts`). `friction`, `hygiene` and `selfwatch` mute a noisy kind. A
finder is the loop plus the finding's first key segment (`judgment:<kind>` for a judgment), across all repos, and its
state is derived from Issue outcomes, never stored: of its ten newest decided Issues (at least 3), a share of dropped
or cancelled above one half **mutes** it for 14 days after its last Issue closed (it files nothing; the findings it kept
are named in the pass record's `overBudget`). After the mute it is on **probation**: one Issue at a time across repos
until one closes done. Both show on Improve and in `GET /v1/finders`.

**The ledger** (`factory.loop_findings`; `domains/improve/ledger.ts`, `app/loops/ledger.ts`) is the one table of which
Issue a loop's finding opened: loop, repo, class, key, signal, and the figure it was filed against (null when it has
none). Once the Issue closed, the next pass reads the same figure again and stores a verdict: `moved` (it fell; a
throughput figure keeps a 10 % band), `flat`, `worse` or `unmeasured` (dropped, cancelled, or no figure). A key filed
again says `Last time: Issue N at figure X, now Y (moved).` in its signal.

`GET /v1/loop-yield` (`read/loop-yield.ts`) answers per signal-filing loop over 7 and 30 days: passes, signals,
Issues, how they ended, the median time to close and how many done Issues moved their figure.

## API, client, CLI

- **Elysia** with zod through Standard Schema and `@elysiajs/openapi`. Who may call a route is the one table in
  `api/policy.ts`; a walk of the OpenAPI document fails the tests on a route without a row. One contract in
  `packages/contract` builds every body; a body that does not parse is exit 9.
- **The CLI is generated** from the OpenAPI document (`apps/cli/scripts/generate.ts`), one command per operation,
  keeping agw's contract: `--format json|plain`, data on stdout, messages on stderr, exit codes, never a prompt. The
  hook, slot, deploy-lock, merge-lock, land, follow, retro (`GET /v1/retro` plus `apps/cli/src/retro-transcripts.ts`),
  role and issue schema verbs are hand-written. With no `FACTORY_TOKEN` or `FACTORY_READ_TOKEN` it resolves the owner
  token from the deployed release's `.env.tpl` through `secrets-run` (`apps/cli/src/credentials.ts`). Retired commands
  answer with the way to the same thing (`apps/cli/src/retired.ts`). Flag help and client-side validation derive from
  the request body's schema (`apps/cli/src/body-schema.ts`; `--schema` prints it).
- **A restart is waited out** (`packages/client` `sendPatient`, `apps/cli/src/restart-wait.ts`): a call that finds the
  port closed retries with a backoff for up to 90 s (`FACTORY_RESTART_WAIT_MS`), 10 minutes while `data/deploy.lock`
  names a live pid (`FACTORY_DEPLOY_WAIT_MS`); a refused connection is retried for every verb, a reset or timeout only
  for a read, `version_conflict` (409) up to three times. `health get` and the hook never wait. The Console shows
  "Server restarting, reconnecting" and refetches when the stream greets again (`apps/console/src/lib/restart.ts`).
  `scripts/deploy.sh` restarts nothing when the commit is live and healthy (`FACTORY_DEPLOY_FORCE=1` forces), builds
  the newer commit when master moved meanwhile (`DEPLOY_ROUNDS`, 3) and dry-runs the pending migrations in a
  rolled-back transaction (`apps/server/src/migrate-check.ts`) before stopping the old process. Why no gapless
  handover: `docs/decisions.md` NL31.
- **Callers and tokens.** The bearer token alone decides the caller: `owner` (`FACTORY_TOKEN`, required),
  `orchestrator`, `agent` (a lead), `machine` (the door), `signal` (Hermes) and `read`; every other token is optional
  and a caller whose token is unset does not exist. The orchestrator, the owner's delegate, has every owner row except
  eight that are the owner's own judgment or hands (a Decision's worth-asking flag, an artifact's annotations with
  edit and delete, its needed mark, an Errand's approve, a quarantined signal's promote and dismiss). Its events carry the
  actor `orchestrator`; `ownerTouch` (`read/kpis.ts`) counts the owner alone, and its steering is the friction group
  `orchestrator_steer`.
- **Reads** (`/v1/*`, `read/`): needs, flow, chain, Issues, sessions, signals, accounts, queue, loops, friction,
  finders, fix commits, kpis, retro, host, since and the change stream (`read/stream.ts`: it resumes from an
  opaque cursor without losing or doubling a change). `GET /v1/since` (`read/since.ts`) is the Console's "since you
  were here" band; only the owner's read moves the `console_visit` marker (`app/visit.ts`). Health lines
  (`read/lines.ts`) are kinds `door`, `account`, `loop`, `checkout`, `lead-no-agent` and `main-checkout`.
- **Health.** `GET /health` answers from memory: a background probe (`read/health-probe.ts`, every
  `FACTORY_HEALTH_PROBE_MS`, 10 s) holds the database facts, so a request never waits for Postgres. `ok` is false only
  for a stopped factory: no successful leads tick for 20 min (`TICK_DEAD_MS`), no first tick 5 min after a start on a
  host that is not starved, or a database that errors for 5 min. Else it is `ok` with a `reason`: `starting`,
  `deploying` (`scripts/deploy.sh` holds `data/deploy.lock` and appends to `data/deploys.log`, which `GET
  /v1/throughput` sums per day as `deploys.days`), `starved: …` or `failing: …`. The heartbeat also carries
  `routeP95Ms` and `routeSamples` (`api/route-timer.ts`: the p95 of the server's own routes over 5 minutes; routes
  that wait on a port by design, the report reads and the first 120 s after a start are not timed), since `/health`
  alone answered on 2026-11-14 while every database route timed out. The reader outside the server is the dev host's
  Uptime Kuma push monitor, the one filer of slow routes.
- The hook socket is a plain `Bun.serve` unix listener beside the API: its contract (mode 0600, stdout empty bar the
  compaction line) is the hook's, not the API's.

## Perimeter

The API stays loopback. The door and the Console are published on the tailnet by dotfiles-private's `tailscale serve`
rows (the Console on :8797, to its loopback listener); the perimeter is the tailnet ACL by device tag (`tag:mac` and
`tag:phone` to `tag:devhost` on tcp:8797), as Collie's (NL25). There is no per-request identity: anything that reaches
:8797 reads what the owner reads, plus the owner's fifteen write verbs and never a session start. The door holds only
its own token; the Console proxy never uses the orchestrator's. The Console listener forwards exactly eleven answers
(Decisions, artifact verdicts, marks and annotations, Errands done or approved, quarantined signals promoted or dismissed), a
collection's pin and unpin and an account's mode set and clear, guarded against a cross-site page (JSON only bar a
delete, no cross-site fetch metadata, no foreign `origin`, 64 KiB). It starts no session and cancels or reopens no
Issue; promote files one only from a signal already held, dismiss files nothing. The artifact frame (`/frame.html`,
`/frame/*`) is served under its own CSP (scripts, no network, sandboxed); the page's `script-src` stays `'self'`.

## Data

One database, schema `factory`. Migrations in `apps/server/migrations/` apply under an advisory lock with a checksum.
Usage and cost are never copied: they join the `usage` schema at read (`read/usage.ts`), and an Issue's `insights` say
`partial` while a lead is alive.

## The counting epoch and the three answers

`config/throughput.json` holds one ISO time (`FACTORY_THROUGHPUT_FILE` points elsewhere); a missing or bad file stops
the start. Nothing before it counts: throughput, the capacity loop, friction, the ranking's window facts and lead
costs start at `max(asked start, epoch)` and say so as `epoch.cut` (`kernel/epoch.ts`). No row is deleted. A median
over earlier days waits three days after the epoch, the ranking files nothing from a window under a day
(`MIN_RANK_DAYS`), and an improvement filed before it reads `unmeasured`. `read/throughput-answers.ts` writes the
three answers the Throughput page opens on: `host`, `queue`, `cost`. Each read has a test in
`apps/server/test/read-models/` that restates its figures in plain SQL over seeded rows.

- `GET /v1/kpis` (`read/kpis.ts`): seven KPIs with parts, the figures beside them, six history windows.
- `GET /v1/seats` (`read/seats.ts`, `read/seats-model.ts`): the light-seat and cheap-reviewer gates.
- `GET /v1/capacity-loop` (`read/capacity-loop.ts`, `read/capacity-tuning.ts`): closed Issues, idle allowance-hours, slot
  waits, queue by reason, edges, the setting to change first.
- `GET /v1/retro` (`read/retro.ts`, `read/retro-build.ts`, `read/retro-taste.ts`): capacity figures, build minutes per
  repo, the owner's taste, the lead sessions with their transcript paths, the ledger of earlier retro signals; the
  read token gets no path and no words.
- `GET /v1/throughput` (`read/throughput.ts`, `read/throughput-series.ts`, `read/throughput-account.ts`,
  `read/throughput-redact.ts`): host memory and CPU by class, repo and tenant; tests; series; each lead's wall time in
  seven places; the scorecard.
- `GET /v1/sessions` (`read/sessions.ts`, paged by `before`) and `GET /v1/projects` with `/:name`, `/:name/setup`,
  `/:name/hygiene` (`read/project-index.ts`, `read/project-page.ts`, `read/project-setup.ts`).

Rules, one line each:

- Queue order (`orderQueue`, `domains/planning/queue.ts`): inside one project and `prio`, Issues sort by size, aged
  one size per `AGEING_STEP_MS`, then by the `factory-queue` order, then by number. Blockers and `prio` are never
  changed.
- An edge the factory added comes back out when both Issues shipped with no shared path, or the blocker waited on the
  owner past `OWNER_WAIT_MS` (`domains/planning/edge-need.ts`); `checkQueue` (`domains/planning/queue-edges.ts`) runs
  it through `removeInferredEdge` (`app/planning-chain.ts`), which keeps each removal in
  `factory.queue_edge_removals`. A kind of edge stops (`EDGE_STOP_MIN`, `EDGE_STOP_SHARE`, `kernel/edge-need.ts`) on
  the measure `readEdgeNeed` (`read/edge-need.ts`): a shared file is a proxy for need.
- Lead wall time (`read/throughput-account.ts`): seven places, each taking only the time the earlier ones did not:
  owner, step, slot, merge lock, CI, turn, idle.
- Build minutes: CI runs come through `githubCiTimes` (`adapters/selfwatch/github.ts`); a repo whose CI cannot be read
  keeps its check figures under `build.unreadable`. The six capacity figures the ledger compares are
  `CAPACITY_FIGURE_KEYS` (`packages/contract/src/read-models.ts`).

## Tests

- **Unit** where logic is pure and dense: the machine, correlation, the gate, admission, the queue order; a **model
  test** of the machine.
- **Scenarios** (`tests/scenarios`): use cases end to end against a real server and Postgres with fake hc and agw.
  They are the acceptance suite, and a lead runs the ones its change touches as its proof.
- **E2E** (`tests/e2e`): Playwright against a seeded server, every Console screen at three viewports.
- `make check`: the whole gate, listed in `docs/operations.md` "Check tiers".

## The Console

`apps/console` is the owner's window (NL1): Vite, React, shadcn on Base UI, Tailwind 4 with Basalt's tokens, TanStack
Router, Query and Table, a PWA. The server's second loopback listener serves the build, published by
dotfiles-private's serve row (`docs/operations.md` "The Console listener"). It is read-only apart from the fifteen
verbs (Perimeter) and can never spawn a session. The screens are those of `apps/console/src/lib/screens.ts` plus the
pages an Issue, a project, an artifact and a collection each have; `/checkpoints/<id>`, the link of the owner's pages,
lands on its item. `apps/console/README.md` describes each screen and `apps/console/DESIGN.md` is the design bar.

The flow trend (`GET /v1/flow/trend`, `read/flow-trend.ts`) counts running, paused, not started (ready plus held) and
checking per bucket, with the peak and the time-weighted average, from the applied events' `to_state` intervals, never
from samples: 24 hours by the hour, 7 days by the hour (default), 30 days by the day, on UTC buckets.

## The throughput loop

The loop (`app/loops/throughput.ts`, `domains/improve/throughput.ts`, `read/throughput-loop.ts`; its ledger the
throughput rows of `loop_findings`) ranks once a day, with no model, what cost the host's capacity most over the last
7 days in minutes, and files the largest cost per project as a signal. The candidates:

- `failed_run_minutes`: slot-minutes of failed `factory slot run` steps.
- `slot_minutes_per_issue`: slot-minutes per Issue closed `done`, when 25 % above the median of the 14 days before.
- `step_peak_mib`: a step tier whose p90 peak memory is over the project's `budgets.peak` (2 GiB when unset).
- `process_growth_mib`: a process whose footprint grew 1 GiB or more between its first and last notable minute (not
  `postgres`, `kernel_task` or transient scanners: `SHARED_MEMORY_PROGRAMS`, `isKernelTask`, `isTransientScanner`;
  tenants are read below).
- `queued_minutes`: the minutes queued Issues waited, one candidate per binding reason (`WAIT_SUBJECTS`, `waitFacts`):
  `memory` and `account` on this repo, `claim` and `lane` on the repo whose Issues waited. A wait behind an `after`
  edge, a stopped line, a Spec, a drain, the boot grace or the load is not ranked.
- `tenant_class_mib` and `tenant_growth_mib`: launchd jobs and VMs, from the hourly `host_class_hours` rollups, filed
  on the repo that owns the host's configuration (`DEFAULT_TENANT_PROJECT`): the class's 7-day mean over its budget
  (`DEFAULT_TENANT_BUDGET_MIB`), and a tenant whose newest 24 hours run 1 GiB above its own 14-day median.

A cost under 30 minutes is not a finding; a cost the newest 3 days already left behind is not filed; at most 5 a pass
(`kernel/signal-budget.ts`); a project holds one open improvement. The signal carries the measured before, a target
(half of a time figure; the median for the per-Issue ratio; the peak budget for a step), the query that reads it again
and the retro marker (`Retro: <date> kpi=<kpi> before=<n> direction=down`) as its last words.

**The ledger.** A row per filing is `open`, `shipped` once its Issue shipped, or `dropped` when it closed without a
ship. Three days after the ship the loop reads the same figure over those days (`figureOf`, the SQL of the ranking)
and stores the `after`: `moved` when it fell by 10 % of the before, else `flat` or `worse`, `unmeasured` when the
window has no run, Issue or step. A finding that moved is held out of the ranking until the 7-day window has left the
days before its ship; one that did not is ranked again at once with the earlier attempt named (`reopens`). The weekly
retro's ledger (`read/retro.ts`, `ledgerOf`) joins it by signal.

**A binding cap and the disk fit** (NL48; `domains/improve/caps.ts`, `read/cap-facts.ts`, `domains/capacity/disk.ts`).
When an Issue of a repo was queued for `claim` or `lane` in at least 60 minutes of the last 24 hours while an account
seat was idle and the cap is below the default, one signal on the repo names the cap, the comment beside it in
`project.yaml` (`capComment`) and the figures for the resource the comment names (`capReasonOf`). Disk is no cap:
admission refuses a lead as `disk` when the repo's learned worktree footprint (`factory.worktree_sizes`, p80 of ten
attempts) does not fit the free disk less headroom (`diskRefusal`).

`budgets:` in `project.yaml` (`budgetsOf` in `packages/contract/src/project-file.ts`) make a breach a signal the day
it happens through `selfwatch`, not this pass; `peak` is also the step target of the ranking.

## Not built

- **The 30-minute forward** (NL5): an unsolved alert reaching the owner. The server reads none of the old core's
  `FACTORY_ALERT_*` settings.
- **A per-request identity on the Console listener:** accepted (NL25). The tailnet ACL is the perimeter; see
  Perimeter.
- **Client work in other repos:** Argo's factory pages leaving for the Console; Iris rendering an artifact inside it.
