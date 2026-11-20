# Audit: domain model and language (software-factory)

Read-only audit. Snapshot: master at 8fa0a18c, 1413 commits, first commit 2026-10-30 (so the whole repo is 3 weeks old). Nothing was run except rg, wc, git log and small Node scripts that parse files. Where a number comes from my own script (migration parsing, port-method counting) it says so. Nothing from live data except the files the parent left in /tmp/sf-cycle.GqxbyO (loop yield, loops list) and the mini's `~/.config/factory/env` (two settings, read once).

Sizes measured (cat of all .ts): domains 17,152 lines (capacity 3,056 in 18 files; checkpoints 3,056 in 13; loops 5,356 in 26; leads 1,566; work 1,426; quality 1,034; planning 863; intake 795), kernel 931 in 23 files, contract 9,038 in 28 files (read-models.ts alone 2,285).

## 0. What I verified, in one list

- 85 live tables (86 created, 1 dropped: `capacity_ranks`, created 1006, dropped 1056). 85 migrations in 3 weeks. Exactly one `DROP TABLE` and zero `DROP COLUMN` in the whole history: the "expand then contract" rule in AGENTS.md has only ever been half applied (my parse of all .sql; `rg -c "DROP TABLE|DROP COLUMN"` returns only 1056).
- The mini runs `FACTORY_LOAD_RULE=on` and `FACTORY_SLOT_AIM=on` (`~/.config/factory/env`), while the code default of both is `shadow` (apps/server/src/app/planning-settings.ts:147, :160). The shadow branches are dead in production.
- The legacy importer is 2,131 lines (apps/server/scripts/import/plan.ts 883, run.ts 577, import-legacy.ts 106, test/import 288+245, scripts/import.sh 32); last real change 2026-11-07 (cutover day), apart from a mechanical export drop (eee04c8f, 2026-11-17).
- 72 port interfaces with 418 methods in the 8 ports.ts files (my regex count). 43 of the 72 have one method.
- 24 event kinds, 6 states, 11 waits, 4 outcomes, 6 actors, 20 loops (LOOP_NAMES, packages/contract/src/loops.ts:303).

## 1. Concept inventory

Legend: core = the product cannot be described without it; supporting = real mechanism, could be smaller; vestigial = no producer, or kept for a retired reason; collision = same word, several things.

### work (Issue machine)

- Issue (core), State: settling queued working waiting watching closed (core; issue.ts:5), Outcome done dropped healed cancelled (core; `healed` is reachable only from an incident, issue.ts:23), Kind feature bug chore docs incident (core), Size small medium large (supporting: only feeds the light-seat rule and queue order), Origin you application infrastructure github feedback factory (supporting; repeated as SIGNAL_ORIGINS in contract/intake.ts:55).
- Wait (11): timer dependency external are timed or machine waits; decision review errand wait for a person; wall unreported blocked lead_gone regressed are the 5 stalls (issue.ts:45-72). All core, but five stall waits plus the event `stalled` plus the event `lead_gone` plus the event `regressed` is one idea (a machine cause stopped the work) spelled in 8 places. Not a deletion candidate (the steward and wake rules differ per cause) but the biggest reading cost of the machine.
- Event (24, events.ts:23): filed settled admitted lead_started lead_gone seated noted asked answered submitted verdict_given errand_raised errand_done errand_turned_back deferred stalled moved_up woken shipped watch_passed regressed reopened cancelled closed. By occurrence (quoted-string count in src / tests): rare ones are errand_turned_back 8/5, watch_passed 6/9, submitted 12/10, seated 12/10, verdict_given 10/15, errand_raised 11/8, moved_up 13/16. watch_passed is rare in code only because it has one producer; it is core. errand_turned_back and moved_up are the two with the weakest case (see F9, F7).
- Effect (outbox), Cell/Table (the 6x24 transition table, 136 helper uses in 144 cells: most cells are `said(...)` ignores). Core. The totality rule is an AGENTS.md invariant, not a finding.
- Actor: owner orchestrator lead factory steward judge (kernel/events.ts:5). `steward` and `judge` are not principals, they are loops of the factory that act on judgment; also "Caller" (owner orchestrator agent machine signal read, api/policy.ts) is a second principal vocabulary. Two lists of "who": ACTORS (6) and callers (6), overlapping on owner and orchestrator only.

### intake

- Signal (core), Triage outcome filed amended incident held dropped (core), detail words (about 17: new matched replayed repeat joined regression healed quiet unrouted quarantined promoted work_repo no_project not_listened loop_guard no_repo probe settled; supporting, language.md Triage outcome row), Held signal / Promote / Dismiss / Screen / Probe (supporting), Door, Door route, door sources, unrouted (supporting; 3 tables), Incident (core), Trust (supporting), heal grace/settle (supporting; see collision "settle"), seen/writebacks (supporting, 2-3 column tables).
- Signal state in the table: held filed amended incident promoted (+ dismissed after 0991). It overlaps with the triage outcome list but is not equal to it: held/filed/amended/incident are shared words, promoted/dismissed are state only, dropped is outcome only. Two vocabularies for one lifecycle, joined by a CHECK that ties state to issue_id (0200_intake.sql:23-25).

### planning

- Project (core), Plan row (core), Chain/edge (core), prio (supporting), Lane (supporting; resource class inside a repo), Claim (supporting), Replan (supporting; rare, "one open per project"), queue loop's inferred edges and edge removals (supporting; 1036, 1046, 1047 added three tables/columns for judging inferred edges), Warnings (1035).
- contract/lane.ts holds LaneName, but also CheckpointName and SPEC_WAIT_HOURS (lane.ts:11-21): a checkpoint is not a lane.

### capacity

- Admission and Queue reason (15 kinds; core), Queue state run pace drain (core), Claim (core), Account (core, delegated to packages/accounts), Account mode normal drain reserve paused (supporting), Window (core), Seat (collision, below), Seat bonus (supporting), Doctor (supporting), Boot grace (supporting), Disk-by-fit (supporting), Lane (above).
- Test slot (core), Slot aim (supporting; the on/off/shadow mode is vestigial: F2), Step cost (core data), Step class/Process class lead step tenant factory system owner other (supporting; capacity/classes.ts:5), Remote step and Remote hold (supporting; kernel/remote-hold.ts, kernel/remote-pressure.ts, capacity/remote.ts: "steps off the mini", issue 1793/2028), Relearn (supporting), Worktree size, Lead cost (supporting), Queue interval, slot wait, merge window (supporting data).
- Shadow decision (vestigial in production).

### leads

- Lead, Attempt (core), Session state starting working idle compacted walled gone (core), Delivery/send-back (supporting), Quiesce/dormant/revive (supporting), Light seat / Move up / light rule / class-seat judge / light gate (supporting, but heavy: F8), Reviewer row reviewer reviewer-cheap + tripwire (supporting, heavy: F8), API error classes transient and others (apierror.ts, 300 lines; supporting, unverified depth), Brief (core), Type gap (one constant).

### checkpoints

- Artifact (4 kinds): Concept, Spec, Decision, Report. Decision is also its own table (`decisions`, 20 columns, plus `decision_steps`) and also an `artifacts` row since 0999 (kind decision). Concept differs from Spec in exactly one behaviour: a Concept pages the owner at once, a Spec goes through the Spec screen first (app/checkpoints.ts:654-655, :749). Mark Concept supporting-thin.
- Verdict, Annotation, Revision, Collection, Retired artifact, Link (supporting), Spec screen / Needed me / Worth asking / Settler / Taste pass (supporting), Judge (core), Page (core), Recheck (supporting; checkpoint_rechecks).
- Errand family: Errand, Request, Check, Need, Match key, Joined errand, Screen, Still-needed look, Turn away, Turn back, Desk pass, Back at desk, Auto-run, Closed without you, Push, Approve, errand run (1018). That is 17 words, 37 columns on `errands` (28 added after 0600 across 0993 1015 1018 1019 1030 1041; my parse), 7 migrations. Core idea (owner hands) is small; the vocabulary around it is the largest in the repo.

### quality

- Ship (core), Gate/Evidence/Proof (core), Watch/Verify/regress (core), Review status covered not_required uncovered unknown (supporting), Checks/CI (supporting). Smallest, cleanest domain (1,034 lines, 8-method ports).

### loops (a bag, see section 2)

- Loop (20 names), Pass, Round, Steward (stall rules), Settle (triage settle), Queue (edge inference), Hygiene (probes, findings, lifecycle, fixes, deps, upgrades, fix commits), Selfwatch (14 conditions), Overload (4 conditions), Throughput (ledger of improvements), Friction (counts), Retro, Digest, Reaper, Reviews poll, Edge need, Caps, Finding class (class status open probation held), Fix class.

### kernel and contract

- kernel: result, ids, keys, clock, run, scrub, events, agw port; plus domain-ish leftovers (hold, remote-hold, remote-pressure, throughput-limits, digest-scope, edge-need, auto-run, hands, judge-tries, visit, epoch, fresh-for, glob). 
- contract: wire schemas plus domain logic: light-gate.ts (Wilson-interval tripwire, 227 lines), reviewer.ts tripwire (74), seat parsing, hygiene-catalogue (291), kpi-catalog (376), work-words (workOf).

### Collisions (one word, several things), each counted in apps/server/src + packages/contract/src

1. **seat**. (a) The account's lead allowance: language.md "Seat: one lead the accounts may hold at once", host_samples.seats, capacity/seats.ts `seatBonus`. (b) The configuration a lead runs on: contract/seat.ts `Seat = {tier,effort} | {role}`, `ResolvedSeat`, `LeadSeat`, the `seated` event, "light seat", "reviewer seat", read/kpis-seats.ts. Both live in leads-start.ts and read/seats.ts. Highest-cost collision.
2. **class**. finding class (loops/classes.ts, loop_findings.class), fix class (fix-classes.ts, FIX_CLASSES), process class (capacity/classes.ts, 1022_host_classes), hygiene class (leads/light.ts `hygieneClass`), resource class (language.md Lane definition), API error class (leads/apierror.ts `kindOfApiError`), heartbeat class, auto-run class, owner class (language.md "Owner class ... is not a classification field"). Nine senses; rg of `\\w+ class` finds "the class" 33, "a class" 17, "resource class" 9, "held class" 8, "tenant class" 7, "hygiene class" 6.
3. **hold/held**. "held": 511 occurrences. Held signal (quarantined text), Held (screen word for a queued Issue that cannot start), held finding class (ClassStatus), held Replan (planning/replan.ts), held edge (HeldEdge). "hold": the Judge's answer that becomes a timed wait (kernel/hold.ts, event field `answered.hold`), the remote-step hold (kernel/remote-hold.ts, a different clock), `holds` = the checkpoint a wait holds (issue.ts WaitSpec), "holders" of slots and claims (149 occurrences). language.md retires "Hold" for the queue and the watch but the word was left out of retired-words.ts on purpose (retired-words.ts comment), so nothing enforces it.
4. **settle**. 7 senses by count (268 "settled", 112 "settle", 104 "settling", 53 "settleDeps"): (a) an Issue leaving `settling` (event `settled`, loop `triage`, domains/loops/settle.ts); (b) a Decision being settled (`settled_by`, Settler, checkpoints.settle(), and the loop named `settle` in LOOP_NAMES that runs it: main.ts:496-505); (c) intake's heal grace job `settle` (compose-intake.ts:96, app/intake.ts:1389); (d) planning's `POST /planning/settle` (api/planning.ts:335); (e) the Spec screen "settles" a Spec with looks_good; (f) the agw `SettleWorkflow`; (g) the watch's `settledAt`. The loop called `settle` is not the loop that settles Issues.
5. **ask**. event `asked`/verb `issue ask` (a Decision), table `queue_asks` (an agw call about a queue shape), port method `.ask(...)` on four workflow ports, `read/asks.ts` ("what waits on the owner"), "Round = the nth ask of a workflow", "worth asking". language.md says the noun Ask is retired for Decision; the code has `queue_asks`, `readAsk`, `ReadAskList`.
6. **verdict**. ArtifactVerdict (looks_good...), JudgeVerdict, ShipVerdict, CheckVerdict, ClassVerdict, conclusionVerdict, guardVerdict. Different shapes, one word.
7. **finding**. hygiene finding (loop_findings, hygiene probes), selfwatch finding (selfwatch_findings), throughput finding (throughput_findings, 18 columns), review finding class (0993_finding_classes). Three tables with the same name suffix and three different lifecycles. "Friction" is both the loop, the counted waste, and the signal kind a lead files.
8. **wait / stall / defer / hold**. The language is coherent here (Wait = pause with exit, Stall = machine-caused wait, Defer = the lead's verb, event `deferred`) but the steward also uses `deferred` to park a holder behind a queued Issue (events.ts:96-100), and the Judge's "hold" turns a stall into a timer wait with no event of its own (`answered.hold`). So three routes into `timer`: lead defer, steward defer, judge hold.
9. **loop**. language.md: "a named recurring job with a trigger, a budget and one way to act. Its judgment is an agw workflow". LOOP_NAMES has 20; `leads`, `planning`, `watch`, `settle`, `send`, `host`, `reaper`, `reviews`, `desk`, `errands` are state ticks (10 s) that call no workflow (loops.json: intervalMs 10000 for the first five). "Loop" and "pass" are used for both a judgment job and a poll tick.
10. **pass**. loop pass (loop_passes, friction_passes, hygiene_passes), desk pass (desk_pass table), settle pass, planning pass, "first verification pass" (a KPI), "pass" as pass/fail (watch_passed, CheckVerdict). 

Words that are one thing but have two spellings: queue reason vs refusal kind (capacity/admission.ts: "Hold is retired ... this names why"), Review wait vs external wait (language.md), Request vs standalone Errand (1015 and 1042 tables merged them but the CLI and screens keep both words), Held signal vs "quarantined" (triage detail).

## 2. Is "loops" a domain? Capacity? Checkpoints?

### loops: a bag. 26 files, 5,356 lines, one coupling: domains/loops/ports.ts (527 lines) imports 12 of the 25 siblings.

Intra-folder import graph (my parse of `from './x.ts'`): 15 of 26 files import no sibling at all (budget, calls, caps, checkout, classes, digest, edge-need, fix-classes, reaper, retro, reviews, settle, stall, upgrades, hygiene-model's only link is upgrades). The only real clusters:

- Hygiene cluster (6 files, ~880 lines): hygiene.ts (258), hygiene-model.ts (242), hygiene-lifecycle.ts (144), hygiene-fixes.ts (69), dependency-refresh.ts (218), upgrades.ts (155). It owns tables hygiene_passes and loop_findings, and a catalogue in contract/hygiene-catalogue.ts. Together with fix-classes.ts (138) and classes.ts (96, finding-class probation) that is "the hygiene loop": about 1,110 lines.
- Self-observation cluster: selfwatch.ts (494) + selfwatch-model.ts (203) + overload.ts (415) + throughput.ts (606) (throughput imports selfwatch-model). Tables: selfwatch_findings, throughput_findings, host_*_samples, ci_runs. These read the host and the queue and file signals about the factory itself. friction.ts (223), retro.ts (60) and digest.ts (183) are the same family (counted waste, weekly review, project digest).
- The rest belong to another domain: stall.ts (450) and checkout.ts (73), reviews.ts (46), settle.ts (164), queue.ts (193), edge-need.ts (76), caps.ts (114), calls.ts (69) are rules the steward, triage and queue loops use over Issues and chain edges (work/planning); reaper.ts (135) and overload.ts's host half act on host processes (capacity).

Why it is accidental: the folder name is "the loop runner's pure rules" (app/loops/ has the runner, 5,069 lines for 22 files), not a domain. AGENTS.md says "domains/* import only kernel and their own folder", so every loop that touches two domains sits in loops to be allowed to read both through app/. The coupling is in app/loops/*, not in domains/loops.

Proposed split (moves only, each PR one cluster): hygiene/ (hygiene, hygiene-model, hygiene-lifecycle, hygiene-fixes, dependency-refresh, upgrades, fix-classes, classes), improve/ (selfwatch, selfwatch-model, overload, throughput, friction, retro, digest, budget), and move stall/settle/queue/edge-need/caps/checkout/reviews/calls into planning or leads (they decide about Issues and edges), reaper into capacity. After that loops/ports.ts (527 lines, LoopStore 49 methods + LoopReads 26) splits with its owners.

### capacity: two things in one folder

Import graph: slots.ts (576), disk, accounts, lanes, claims, seats, costs, queue-state, leadcost, waits, doctor import nothing; admission.ts imports 8 siblings; ports.ts imports 10. Two sub-systems share a host reading:
- Admission: admission, accounts, boot, claims, disk, doctor, lanes, leadcost, queue-state, seats, waits, host (about 1,900 lines).
- Test slots and steps: slots, slot-aim (imports host), costs, remote (imports costs), classes (process classes, imports leadcost) (about 1,350 lines).
They only meet at memory (host.ts, leadcost.ts). The folder is cohesive enough to keep as one domain; the problem is ports.ts: CapacityStore has 44 methods (readings, claims, assignments, queue states, slots, step costs, merge windows, remote samples, placements, aim, shadow, relearn, worktree sizes, queue intervals). Verdict: a domain, with a god port. Do F2 and F10 before splitting it.

### checkpoints: three things in one folder

- Decisions and artifacts: decision (342), artifact (429), spec-screen (171), recheck (190), page (117).
- Errands: errand (425), triage (234), triage-replay (134), need (128), match (40), request (198), desk (96) = 1,255 lines, one folder-local graph (errand imports decision, match, need, triage).
- ports.ts 552 lines with CheckpointStore: 82 methods across decisions, artifacts, collections, annotations, verdicts, spec screens, errands, pages, rechecks. The adapter checkpoint-store.ts is 1,280 lines, app/checkpoints.ts 1,676, api/checkpoints.ts 918.
Verdict: one domain by the language ("where the owner comes in") but the Errand family is a second domain with its own tables (errands, errand_joins, desk_*), screen, loop (errands, desk) and 17 words. Recommend a folder split (errands/ vs checkpoints/) first, then decide if errands deserve their own port.

## 3. The Issue machine

(domains/work/table.ts 581 lines, events.ts 186, issue.ts 139.)

- 6 states x 24 events = 144 cells; 136 uses of refuse/ignore helpers (rg count over the file, includes the helper definitions), so roughly 100 cells are a one-line "nothing waits for X" ignore. That is the price of totality; not a finding.
- Events that carry several outcomes in optional payload keys: `errand_done` has `turnedAway`, `resolved`, `ran`, `awaits` (events.ts:93-103), four distinct endings of an Errand in one event kind, while `errand_turned_back` is a separate event kind with the same wait-ending effect (table.ts:516 `endsCheckpoint` vs :515 `errandEnded`). Two events and a third spelling of the same thing: "the Errand wait ended without the owner's hands" is turned_away (screen), turned_back (owner), resolved (check), ran (MacBook verb).
- `moved_up` is a second route from "attempt ended, queue again" next to `lead_gone` + restart; it exists only for the light seat and is refused unless `ranOn.rule` is set (table.ts:403). 67 mentions of movedUp/moved_up in src+contract.
- `seated` (owner sets the seat before a lead starts): 12 src, 10 test mentions; legal only in settling/queued, ignored/refused elsewhere. 
- Payload fields marked "old events carry none": filed.seat, filed.lane, settled.size, lead_started.seat/reviewer, deferred... (events.ts:34-35, 52, 61-72). The repo is 3 weeks old and the events were written with these fields absent for the first days; they stay optional forever. Cheap to leave; a reader cannot tell which are optional by design.
- Waits: `lead_gone` and `regressed` waits are counters-exceeded states (MAX_RESTARTS 2, MAX_REGRESSIONS 2, issue.ts:134-137) not different causes; `wall` is the account; `unreported` and `blocked` are lead behaviour. I would keep five (different wake rules) but name them in one table in language.md as a single group (the doc already does).
- Rare: `healed` outcome needs an incident closed before any lead started; 4 outcomes but only done/dropped/cancelled would exist without incidents. Keep (intake incident model depends on it).

## 4. Schema

Method: parsed every CREATE/ALTER in apps/server/migrations into 85 live tables and columns (my script, `create table ... (` plus `add column`), then searched apps/server/src, apps/cli, apps/door, packages for each table and column name (snake and camel).

### Tables never written or read by the running server

- import_issues (0900): no writer in apps/server/src (only the importer script and tests); one reader, read/friction.ts:71 (`SELECT max(imported_at)`), which cuts the friction window. 
- import_events (0900): zero references in apps/server/src, only the importer. 
Columns import_issues.legacy_id, carried_version, import_events.legacy_event, legacy_issue have zero references anywhere under src, cli, door, packages.

### Tables that exist for a mode the mini does not run

- admission_shadow (1024): written only by capacity-store.ts:611, read only by read/capacity-loop.ts:283-297. `on` "records nothing" (docs/architecture.md:172 text).
- slot_shadow (1025): the name is wrong, not the table. It is written every minute under shadow and on (docs/architecture.md:371, 392) and read by selfwatch's `slot_line` (read/loops.ts:475) and the capacity loop. It is the slot-minute ledger. Rename only.
- slot_aim: a one-row state table (id = 1; capacity-store.ts:505-527) for the aim.

### Write-only columns / single-store tables (weak evidence, listed so they can be checked)

- issue_effect_runs.error_kind (0002): one reference, the INSERT (work-store.ts:186); the CHECK ties it to ok.
- api_edge_incidents.recorded_at (1017), review_looks.looked_at (1019), queue_edge_removals.removed_at (1047), artifact_links.linked_at (1042): one or two references, all in the INSERT. Audit timestamps; I do not call them dead.
- capacity_slots, capacity_assignments, intake_seen, intake_writebacks, lead_sendbacks, loop_passes, loop_calls: read only inside their own store (normal; not a finding).

### Expand never contracted

- host_samples holds memory two ways: memory_used_pct, swap_used_pct (1002) and memory_used_bytes, swap_used_bytes, ram_bytes, swap_total_bytes (1044, 2026-11-16). read/throughput.ts:290, :429, :442, :457 does `coalesce(h.memory_used_bytes, h.memory_used_pct / 100 * ram)`. Samples are pruned at 14 days (app/loops/host.ts:92, :175), so from 2026-11-30 every row carries bytes and the coalesce fallback is dead. The pct columns are derivable (ram_bytes known), which is the "facts stored, state derived" rule. The pct columns are still read raw by capacity-store.ts:480-494, read/host.ts:25, read/loops.ts:445, throughput-answers.ts:252.
- errands: reached_owner_at / turned_away_at (0993) plus closed_kind='turned_away' (1015, backfilled by `UPDATE ... closed_kind = 'turned_away' WHERE turned_away_at IS NOT NULL`, 1015:45) plus done_at: three ways to say the Errand ended.
- intake_signals.dismissed_reason, dismissed_by, dismissed_at (0991) vs screen_note, screened_at, screen_attempts, screen_retry_at (0992): fine, but note errands.screen_tries/screen_retry_at/screen_by/screen_note (0993) and spec_screens.tries/retry_at (1029) repeat the same four columns a third time.
- lead_attempts.tier/effort (1046) duplicates what `lead_started` already carried in the event payload (events.ts:57-67). It was added "because no table held" the KPI fact (1046 comment), i.e. a column of a derivable fact.
- Zero DROP COLUMN anywhere. Candidates for a contract migration: the import tables (F1), admission_shadow (F2), memory_used_pct family after 2026-11-30.

### Tables that repeat one mechanism

- Claim an agw workflow call, retry with a backoff, keep the answer: loop_calls (11 cols: key loop issue_id subject round claimed_at lease_until outcome answer detail finished_at, 0700), queue_asks (13 cols: key repo shape round claimed_at lease_until outcome answer applied refused after_shape detail finished_at, 0960). Eight columns are identical in name and meaning. Retry bookkeeping columns also appear on intake_signals.screen_attempts+screen_retry_at, errands.screen_tries+screen_retry_at, spec_screens.tries+retry_at, decision_steps.tries, checkpoint_pages.attempts, intake_pending.attempts (my column scan for retry_at|tries|attempts). The LoopStore port carries both: claimCall/retakeCall/finishCall/lapseOpen and claimQueueAsk/retakeQueueAsk/finishQueueAsk/recordQueueApplied/shapeAsked/lastQueueAskAt/queueAsks (loops/ports.ts).
- One-row state tables: console_visit (1003), desk_pass (1019, 2 columns), desk_presence (1028), slot_aim, capacity_queue_states, loop_passes (2 columns). Three of them (console_visit, desk_pass, desk_presence) describe one thing, "when the owner was last here / whether his MacBook is up" and are read together by the desk pass (adapters/postgres/desk-store.ts, visit-store.ts).
- friction_passes (0950) and hygiene_passes (0970) share filed / over_budget / failed jsonb; selfwatch_findings, throughput_findings, loop_findings are three tables with the same suffix. 

## 5. Ports

Counted from the 8 ports.ts files (my regex over `export interface`): 72 interfaces, 418 methods.

- God ports: CheckpointStore 82, LoopStore 49, CapacityStore 44, IntakeStore 44, LeadStore 32, LoopReads 26, PlanningStore 18, WorkStore 11. Each has exactly one implementation (adapters/postgres/*-store.ts, adapters/leads/store.ts, adapters/intake/store.ts); tests run the real store against a private Postgres (initdb), so there is no in-memory adapter. The interface is not a seam; it is a list of every SQL function the app layer needs. App-layer files use them by type only (rg: 43 files under app/ import a store type).
- Dead method: `LoopStore.lastHygienePass(repo)` (loops/ports.ts:308) has an adapter (loop-store.ts:513) and no caller anywhere (rg over apps, packages, tests returns only the interface and the implementation).
- 43 single-method ports. 11 of them are "call one agw workflow": StewardWorkflow.ask, SettleWorkflow.settle, QueueWorkflow.ask, HygieneWorkflow.ask, DigestWorkflow.digest, FixClassesWorkflow.ask (loops/ports.ts:437-464), JudgePort.judge, ErrandScreenPort.screen, SpecScreenPort.screen, ErrandNeededPort.judge (checkpoints/ports.ts:487-504), ScreenWorkflow.screen, TriageWorkflow.amendOrNew (intake/ports.ts:221, :233). Every one has the same shape `(request, key) => Promise<Result<Answer>>` and a 10-line wrapper in apps/server/src/adapters/agw/ (digest.ts 10, errand.ts 10, fix-classes.ts 10, hygiene.ts 10, judge.ts 10, queue.ts 10, screen.ts 10, spec-screen.ts 10, steward.ts 17, errand-needed.ts 11) that calls the already-generic `AgwPort.run({workflow, input, key, output})` (kernel/agw.ts). Three layers (domain port, wrapper, AgwPort) to bind a workflow name to a zod answer. Method names vary (ask, judge, screen, settle, digest, amendOrNew) with no meaning.
- Others single-method: CheckRunner.run, MacbookVerbPort.run, Runbook.run, Proof.run: four ports named after their one method `run`, each backing a shell command.
- Leaks of adapter shape into the domain: capacity/classes.ts:8-32 (`SnapshotProc`: "top's MEM", "ps", "lsof", "launchctl", fields null "when lsof did not say"), capacity/ports.ts:391-409 ("null when ps, launchctl or lsof could not be read"; "process count of top's header"), loops/overload.ts:275 `parsePs(output)` (parses ps text inside the domain), loops/ports.ts:158 `why: 'top' | 'large' | 'growth'` where 'top' is a rank, not the command. The domain is pure by the boundaries script but it speaks macOS tool output.
- Port methods used only by tests: not found with my method (callers counted from non-adapter, non-ports src files vs tests); the intake IntakeSink methods (receive, subjects, pendingWritebacks, wroteBack, noteRedBranch) are called by adapters/intake sources, which my count excluded, so I do not call them unused; `pendingWritebacks` is called at adapters/intake/github.ts:549.

## 6. packages/contract

- 9,038 lines, 276 `.meta({ id })` schemas. index.ts is a 274-line manual barrel of named re-exports (index.ts:19, :22, :40, :71, :86 ... one per schema), which has to be edited for every new schema.
- fallow's production dead-code pass (snapshot/fallow-dead-prod.json) lists 106 unused exports and 79 unused types in domains + kernel + contract. In contract they are mostly request/response schemas (NewIssueBody, SeatBody, AskBody, SettleBody, PrioBody, JudgeInputWire, CapacityView, QualityView, LoopList, RoleList ...). I spot-checked 15: all are used by tests, the OpenAPI document or a route (apps/server/src/api/*.ts), so they are not dead; the barrel re-export is what fallow cannot follow. In domains the unused are constants and helpers exported for tests (e.g. domains/loops/overload.ts: LOAD_SAMPLES, SLOT_WAITERS, SLOT_WAIT_MINUTES, SLOT_EMPTY_MINUTES, ROUTE_MIN_SAMPLES, parsePs, priorityLine). eee04c8f dropped 390 such exports on 2026-11-17 and 185 are back in the area three days later: the hygiene sweep reopens a cleanup nobody holds at the source (agents export for tests).
- Duplicated shapes between contract and domains:
  - Issue enumerations. STATES in domains/work/issue.ts:5, READ_ISSUE_STATES (contract/read.ts:19), FLOW_STATES (read-models.ts:88), DigestState (kernel/digest-scope.ts:19), and string-literal unions in domains/loops/hygiene-lifecycle.ts:29, domains/planning/queue.ts:16, read/loops.ts:49,142, read/planning.ts:12. KINDS in issue.ts:9, PLAN_KINDS (plan-file.ts:13), FLOW_KINDS (read-models.ts:91), `z.enum(['feature','bug','chore','docs','incident'])` x4 in contract/loops.ts:59,138,151 and read/loops.ts:11, IssueKindName (domains/intake/rules.ts:9), literal unions in loops/settle.ts:9, loops/ports.ts:336. SIZES five places. OUTCOMES in issue.ts:24, read-models.ts:126, read/flow.ts:42, console issue-page.ts:26. ORIGINS vs SIGNAL_ORIGINS (identical six words). Domains may import the contract (events.ts does), so the boundary rule is not the reason.
  - Seat shape `{tier, effort, role?}` is spelled out in domains/work/events.ts three times, issue.ts twice, ResolvedSeat in contract/seat.ts, LeadSeat in roles.ts, and in leads/ports.ts five times.
  - domain logic in the wire package: light-gate.ts (Wilson interval, class-seat judge), reviewer.ts (tripwire), hygiene-catalogue.ts, kpi-catalog.ts, work-words.ts.
  - contract/lane.ts defines CheckpointName and SPEC_WAIT_HOURS, not a lane.

## 7. Findings, ranked by (simplification gained) / risk

### F1. Delete the legacy importer and its ledger

- What is there: apps/server/scripts/import/plan.ts (883) and run.ts (577), apps/server/scripts/import-legacy.ts (106), apps/server/test/import/import.test.ts (288) and plan.test.ts (245), scripts/import.sh (32), docs/rewrite/cutover-runbook.md; tables import_issues, import_events (0900, last touched 2026-11-07); read/friction.ts:60-75 (`frictionWindow`, cut at `max(imported_at)`); 4 test files that INSERT into import_issues (apps/server/test/read-models/models.test.ts:792, kpis-honest.test.ts:114, tests/scenarios/loops/friction.test.ts:125); 5 lines of scripts/retired-words.allow (plan.ts classify, plan.ts park, run.ts park, test/import ... classify, park).
- Why accidental: the migration comment says "nothing in the running server reads them" (0900_import.sql:2-3). The cutover happened 2026-11-07-08; the only production read is a window cut that a constant or the existing throughput epoch can do.
- Proposed change: new migration `DROP TABLE factory.import_events, factory.import_issues` (never edit 0900, it is checksummed); delete the files above; replace `frictionWindow`'s marker with the date of the cutover as a constant (or the `config/throughput.json` epoch the repo already has for counting); remove the 5 allow lines (they fail make check as "matches nothing" once the files go); remove the three test INSERTs. In language.md drop the "import marker" sentence in contract/read-models.ts:828 description.
- Must not change: friction counts and the Improve "since" window for any database that already has the marker (keep the same cut date); retired-word check keeps catching the old words elsewhere.
- Risk low, size M (about 2,300 lines deleted, ~40 added).

### F2. Remove the shadow modes (load rule, slot aim) that production left behind

- What is there: `FACTORY_LOAD_RULE` default `shadow` (planning-settings.ts:29, :147) and `FACTORY_SLOT_AIM` default `shadow` (:46, :160), both set to `on` on the mini. Code: `shadowDecision` and its writer in app/capacity-admit.ts (:740-796), the `shadow` limit in CapacityLimits (:52-53), `ShadowDecision` and `recordShadow` in domains/capacity/ports.ts:137-160, table admission_shadow (1024) with a 14-day prune, `FACTORY_LOAD_CEILING` ("live while the throughput rule is in shadow", planning-settings.ts:73), `AimMode = off | shadow | on` (slot-aim.ts:3-4), the "under shadow" branches in app/capacity-aim.ts:27,64 and domains/loops/overload.ts:88, the shadow section of read/capacity-loop.ts:283-297 and the Console panel that draws it (unverified), docs/architecture.md:172, :365-392 and decisions.md:542.
- Why accidental: shadow is a rollout state ("shadowed first", commit 6b9e88ca 2026-11-14). The switch happened. A mode that is permanently `on` in the only deployment but remains a default for every test and every fresh install makes the default untested path the dangerous one.
- Proposed change: make the throughput rule and the aim unconditional; delete the two env keys and `FACTORY_LOAD_CEILING`; drop admission_shadow (new migration); rename table slot_shadow to slot_minutes (it is the ledger selfwatch's slot_line reads) or leave the name and fix the comment; collapse AimMode to a boolean-free single behaviour; delete the shadow figures from capacity-loop and the retro tuner if they have no reader.
- Must not change: slot_line / load_over_ceiling / gates_passed selfwatch conditions (they read slot_shadow and host_samples.load_ceiling), admission refusals and their messages, the load ceiling the Console shows.
- Risk low-medium (the settings allow-list in scripts/env-file.sh must drop the keys in the same deploy or the start is refused: AGENTS.md says an unknown key refuses the start, a removed key still in ~/.config/factory/env must be removed first). Size M.

### F3. Dissolve domains/loops into the domains they belong to

- Evidence: section 2. 15 of 26 files import no sibling; ports.ts (527) imports 12.
- Proposed change in four PRs: (1) hygiene/ (+fix-classes, classes, 8 files, ~1,110 lines); (2) improve/ (selfwatch, selfwatch-model, overload, throughput, friction, retro, digest, budget); (3) stall, settle, queue, edge-need, caps, checkout, reviews, calls into planning/ or leads/ (name by who owns the Issue decision); (4) reaper into capacity/. Split loops/ports.ts along the same cut (LoopStore 49 and LoopReads 26 methods). Keep app/loops/ as the runner.
- Must not change: no behaviour; boundaries.ts rule "a domain reaches another only through app/" still holds (check that stall.ts and settle.ts do not import siblings of the new folder).
- Risk low (pure moves), size M each, total L.

### F4. Make one word mean one thing: seat, class, settle, hold

- Evidence: section 1, collisions 1-4.
- Proposed change (docs and names first, no stored value changes): (a) seat: keep "Seat" for tier+effort+role; call the account's lead allowance "allowance" (language.md Seat row, capacity/seats.ts `seatBonus` to `allowanceBonus`, `SeatInputs`, host_samples.seats stays as a column name and is documented as "allowance"); (b) class: pick three words: finding class (hygiene/friction), fix class, process class; rename "resource class" in the Lane definition to "resource"; stop saying class for light-rule names (`hygieneClass` in leads/light.ts becomes the finding's probe name); (c) settle: rename the loop `settle` in LOOP_NAMES to `decisions` (it settles Decisions, main.ts:496-505) and intake's job `settle` to `heal` (it waits out the heal grace, signals.ts in planning calls it "heal:"), leaving "settle" for Issues leaving settling; (d) hold: rename kernel/hold.ts to what it is, a Judge "wait" answer (call the event field `answered.until` instead of `hold` only at the next payload version; an optional-key rename needs an event migration, so first only rename the module and docs).
- Must not change: stored event kinds and payload keys (events are immutable facts), CLI verbs agents have learned (`--seat`, `factory issue defer`), the Retires cells.
- Risk low for docs/names, medium for the loop rename (LOOP_NAMES is in the API, the loops table in docs, factory loops --format json, and `FACTORY_LOOP_*_MS` keys). Size S per word.

### F5. Fold queue_asks into loop_calls (and delete 7 port methods)

- Evidence: section 4 "Tables that repeat one mechanism": loop_calls vs queue_asks share 8 of 11/13 columns; LoopStore carries two copies of claim/retake/finish.
- Proposed change: widen loop_calls (loop CHECK add 'queue'; issue_id nullable or replaced by a `scope` text holding the repo; `subject` = the queue shape); copy queue_asks rows in the migration, drop queue_asks last; delete claimQueueAsk, retakeQueueAsk, finishQueueAsk, lastQueueAskAt, shapeAsked, queueAsks from LoopStore (loops/ports.ts) and loop-store.ts:208-250; keep `applied/refused/after_shape` as nullable columns or a jsonb `detail` for the queue case (app/loops/queue.ts:94 is the one user; adapters/postgres/planning-store.ts:171 reads queue_asks).
- Must not change: the queue loop's "same shape is asked once" and "an edge the loop made does not ask again" rules; round and lease behaviour; `FACTORY` replay keys (kernel/keys.ts).
- Risk medium (data move, one reader in planning-store), size M.

### F6. Replace 11 single-method workflow ports and 10 wrappers by one table of workflows

- Evidence: section 5. 
- Proposed change: contract (or kernel/agw.ts) exports `WORKFLOWS = { steward: { name: 'factory-steward', answer: StewardAnswer }, queue: ..., ... }`; app code calls `agw.run(call(WORKFLOWS.queue, request, key))` or a 3-line helper; delete the 10 files in adapters/agw/ except port.ts (98 lines of wrappers), the 12 interfaces (about 50 lines in 3 ports.ts), and the same number of fakes in tests (unverified count). This does not add a layer, it removes two.
- Must not change: the workflow names sent to agw ('factory-ask', 'factory-errand-needed', 'factory-errand', 'factory-fix-classes', 'factory-hygiene', 'factory-queue', 'factory-screen', 'factory-spec-screen', 'factory-steward', 'factory-triage'), idempotency keys, "never call a port inside a transaction".
- Risk low, size S-M (about 300 lines changed, mostly tests that construct fakes).

### F7. Collapse the "owner is here" state into one row

- Evidence: console_visit (1003: id, seen_at, since_at, returned_at), desk_pass (1019: id, at), desk_presence (1028: id, macbook_up, back_at) — all single-row boolean-PK tables used by the desk pass and the Since band (adapters/postgres/desk-store.ts, visit-store.ts, kernel/visit.ts (4 lines)).
- Proposed change: one `owner_presence` row with the 7 columns; delete one of three stores; keep the visit rule (30-minute gap) and the desk pass triggers.
- Must not change: "since you were here" band numbers, the desk pass starting at once when the owner returns after 2 hours.
- Risk low, size S.

### F8. Seat-selection experiments: freeze the measured winner

- Evidence: contract/light-gate.ts 227, contract/reviewer.ts 74, roles.ts TRIPWIRE_* (lines 40-76), domains/leads/light.ts 87, leads/reviewer.ts 60, read/kpis-seats.ts 357, read/kpis-reviewers.ts 247, read/finding-seats.ts 72, read/seats.ts 68, the `moved_up` event (67 mentions), `ranOn.rule`, the `judgeClassSeat` per-class move-up share over the last 20 Issues. About 1,300 lines to decide which of two cheap rows starts a lead or a review.
- Why accidental (partly): each tripwire is an A/B test with a Wilson interval, a minimum sample, a window and a re-open rule, kept live in production code. The language file says the light seat is "read, not switched: a window that breaks either closes it again". That is a controller, not a rule.
- Proposed change: needs the live numbers I do not have: pull `factory read` kpis for the light seat and reviewer-cheap; if the cheap row has held for the window, replace the tripwire with the static rule and delete the Wilson code and the read models that exist only to feed it; if it has not, delete the cheap row. Unverified which.
- Risk medium (owner call: model routing, NL45), size L.

### F9. Merge turned-away / turned-back / resolved / ran into one Errand ending

- Evidence: events.ts:93-103 (`errand_done` with turnedAway, resolved, ran, awaits), events.ts:105 (`errand_turned_back`), errands.closed_kind CHECK (1019_errands_converge.sql:19: done not_needed expired superseded turned_away turned_back), language.md rows Turn away, Turn back, Review wait, Closed without you.
- Proposed change: keep stored kinds, but one verb in code and docs ("end an Errand" with a `by`: owner, screen, check, expiry, newer request) and delete the duplicate effect functions `errandEnded`/`endsCheckpoint` pair in table.ts:305-316,516 by giving `errand_done` a `how` field in new events. Smallest first step: rewrite language.md to define one ending with five reasons and rename code symbols.
- Must not change: lead hears the reason as its next note; Closed-without-you band counts; the screen's turn-away still ends the wait with `awaits` for a pull request review.
- Risk medium, size S (docs) to M.

### F10. Split the god ports along existing app files

- Evidence: section 5. CheckpointStore 82 methods spans the app files checkpoints.ts, checkpoints-errands.ts, checkpoints-settle.ts, checkpoints-specs.ts, checkpoints-recheck.ts, artifact-new.ts, artifact-collections.ts, which already group them; LoopStore mixes digests, reaped processes, host samples, class snapshots, CI ledger, agw calls, queue asks, friction/hygiene passes, selfwatch/throughput rows. Delete `lastHygienePass`.
- Proposed change: no new interfaces beyond the names the code already uses (DecisionStore, ArtifactStore, ErrandStore, PageStore; HostStore, CallStore, PassStore); each is a slice of the same adapter object, so tests and uow wiring (app/unit-of-work.ts) keep one implementation. Do after F3 and F5.
- Risk low, size M.

### F11. Name each constant once: states, kinds, sizes, outcomes, origins, seats

- Evidence: section 6. 
- Proposed change: one export per list in contract (a vocab module beside work-words.ts), derive the zod enums and the string-literal unions in domains/loops, planning, kernel/digest-scope, read/loops.ts, read/planning.ts, read/flow.ts, console, from it; delete ORIGINS/SIGNAL_ORIGINS duplicate and PLAN_KINDS/FLOW_KINDS. About 25 literal sites.
- Must not change: wire schemas of the OpenAPI document (generated CLI breaks otherwise: `make check` regenerates and diffs).
- Risk low, size S.

### F12. Kernel and tiny files hygiene

- Evidence: one-constant files kernel/judge-tries.ts (2 lines), kernel/visit.ts (4), domains/loops/budget.ts (5), domains/leads/type-gap.ts (2); test helpers in production kernel: kernel/clock.ts `fixedClock`, kernel/ids.ts `sequentialIds` (fallow lists both unused in prod); misplaced: kernel/glob.ts (1 importer: domains/quality), kernel/fresh-for.ts (2: apps/server main/compose), kernel/remote-hold.ts and remote-pressure.ts (importers capacity + read + app, belong to capacity if read/ may import its types), kernel/throughput-limits.ts (11 importers across 4 layers: it is where capacity constants live so read/ can see them), two files named edge-need.ts (kernel/ and domains/loops/).
- Proposed change: merge the four one-constant files into the module that uses them (kernel/limits.ts for the two read/ shares), move glob next to its only user, move test clocks to test/support, rename one of the two edge-need.ts.
- Risk low, size S.

### F13. Contract package housekeeping

- Evidence: lane.ts:11-21 holds CheckpointName, SPEC_WAIT_HOURS; light-gate.ts and reviewer.ts are domain code; the 274-line barrel index.ts.
- Proposed change: move CheckpointName and SPEC_WAIT_HOURS to checkpoints.ts; leave logic modules where F8 decides; replace index.ts by `export *` per file (check that no two files export the same name: fallow reported 20 duplicate_exports in prod).
- Risk low, size S.

### F14. Contract migrations that are due (expand then contract)

- Evidence: section 4.
- Proposed change: after 2026-11-30 drop host_samples.memory_used_pct, swap_used_pct (derive from bytes in the readers: capacity-store.ts:480-494, host.ts:25, loops.ts:445, throughput-answers.ts:252 and the coalesce at throughput.ts:290,429,442,457); drop lead_attempts.tier/effort if `lead_started` is the source; drop issue_effect_runs.error_kind if no reader appears. Add to the migration checker (scripts/ or make check) the rule "an expand-only column with no reader after 14 days fails".
- Risk low-medium, size S each.

### F15. Concept as a flag on Spec (lowest)

- Evidence: 52 mentions of concept in src vs 475 for spec; the only behavioural difference is paging at once vs through the screen (app/checkpoints.ts:654-655, :749); Concept results go to DESIGN.md (language.md). artifacts.kind CHECK (0600:58).
- Proposed change: keep stored kind; remove the type distinction in the contract and treat a Concept as a Spec with screen skipped. Gain small; list it because the "four kinds" statement is in language.md and every checkpoint screen has a Concept branch.
- Risk medium (stored kind), size M. Not recommended before F1-F11.

## 8. The ten changes that most shrink what a newcomer must hold

1. F1: delete the importer, import_* tables, friction import-marker (one fewer era; 2,100 lines).
2. F2: delete shadow modes, FACTORY_LOAD_RULE, FACTORY_SLOT_AIM, FACTORY_LOAD_CEILING, admission_shadow (one fewer table, two fewer settings, three fewer mode branches).
3. F3: dissolve domains/loops into hygiene, improve, and the owning domains (the biggest folder stops being a bag).
4. F4: one meaning for seat, class, settle, hold (14 words become 4 clear ones).
5. F8: freeze or delete the seat tripwires (1,300 lines, one event kind, one wait-adjacent concept "moved up").
6. F5: one agw-call ledger instead of two (queue_asks into loop_calls; and name the pattern once).
7. F6: workflows are a table, not 12 ports and 10 wrappers.
8. F9 + F15: one Errand ending, and Concept as a Spec flag (17 errand words to about 10).
9. F10: split CheckpointStore (82), LoopStore (49), CapacityStore (44) by aggregate.
10. F11 + F13: each enumeration and each shared constant exists once in contract.

## 9. One-screen domain map the code could be made to match

- work: the Issue machine. Owns issues, issue_events, effects. Rules: only table.ts changes state; every event has a sender list; a wait names its exit; a stall is a wait a machine ends; the closed outcome is part of the state.
- intake: signals into Issues. Owns signals, incidents, door routes, held signals, screen. Rules: a signal has a trust level and a fingerprint; triage outcomes are the five words; held text never becomes work without the owner or the Judge; the door never takes the repo from the payload; probes are stored dismissed.
- planning: projects, plan rows, chain, queue loop's inferred edges, replans (plus settle and stall rules that decide about Issues). Rules: an edge is satisfied once; a blocker that waits on the owner too long stops holding; the repo is stored as a project name; a plan row is filed once; edges are inferred by rule then by workflow.
- leads: lead sessions, brief, send, quiesce, API errors, role/seat choice. Rules: one lead per attempt, keyed by name; a note is typed once (delivery keys); a light lead moves up at most once; a gone lead restarts twice; the brief is byte-identical.
- capacity: who may start and who may run a step now. Owns claims, accounts' caps (via packages/accounts), host readings, test slots, step costs, remote steps, aim. Rules: the first rule that says no names itself and its numbers; an owed lead is never held up by itself; a slot is a lease; memory and load come from measured samples; the line (stop the line) beats the cap.
- checkpoints: where a person decides. Owns Decisions, artifacts, verdicts, pages, rechecks. Rules: a Decision reaches the owner only after the Judge saw it; every page carries a checkpoint and is never sent twice; a verdict says who gave it; a Spec screen can settle for the owner but never a gate.
- errands (split out of checkpoints): the owner's hands. Owns errands, requests, desk. Rules: it reaches the owner only after the screen; a command an agent can run is turned away; one need joins one errand; a check closes it, never a model.
- quality: ship, gate, evidence, watch. Rules: a gate a lead cannot talk past; a review never refuses a ship; a watch is pass or fail never averaged; a regression goes back to the lead twice.
- hygiene (from loops): probes, findings, lifecycle, fix commits, dependency refresh. Rules: the probe that raised a finding proves the fix; a finding class that is mostly noise stops filing; one dependency finding per repo.
- improve (from loops): selfwatch, overload, throughput, friction, retro, digest. Rules: counting first, a model past a threshold; one subject per condition until it clears; no signal without a budget; the counting epoch cuts every window.
- kernel: result, ids, keys, clock, scrub, run, agw port, and nothing with a domain name.
- contract: wire schemas and the vocabularies (states, kinds, sizes, outcomes, origins, roles) once.

## 10. What I could not check

- Live data: event counts per kind, the share of Issues that use waits, the real rows in admission_shadow, how many Concepts exist, whether reviewer-cheap's tripwire is met (F8), whether the Console reads admission_shadow figures (F2; apps/console not searched).
- Test fakes: how many tests build fakes of the 12 workflow ports (F6) and the port-method fakes in apps/server/test/loops/*.
- app/ and read/ use of each CheckpointStore/LoopStore method beyond a name regex: method names like `artifact`, `errand`, `decision` are generic, so a "zero callers" claim is only made for `lastHygienePass`, which has a unique name.
- Whether `docs/rewrite/*` and `docs/waves` are still referenced (out of my area).
- The meaning of every "(unverified)" above.
