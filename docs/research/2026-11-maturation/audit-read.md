# Audit: read models, KPIs and their consumers

Repo: ., read-only, 2026-11-20. Data: snapshot/data-kpis.json (window 2026-11-13 to 2026-11-20), data-friction.txt, data-loops.json, data-loop-yield.json. Nothing was run (no make, no tests); every number is from the snapshots or from rg/sed/git log. "unverified" marks what I did not check.

## Summary

1. No KPI is acted on by code. No loop, gate or tripwire reads a KPI value or target. The only code that reads KPI_CATALOG is the copy step (apps/server/src/read/kpi-fields.ts:1-18) and the Console. The code that does act on the same facts is the friction loop, with its own thresholds, its own denominator (Issues closed, not filed) and numbers that disagree with the KPI targets.
2. 28 KPIs are about 7 questions. Four KPIs (asks, owner_decisions_per_100, recommendation_taken, the decision part of avoidable_touches) count the same five events this week.
3. The headline improvement is mostly a denominator effect. avoidable_touches fell 0.228 to 0.101 to 0.038, but the touch counts are 29, 83, 58 (history x n) while Issues filed went 127, 822, 1545.
4. The Improve and Throughput pages overlap. Improve's capacity section repeats the queue-by-reason and memory tables that Throughput shows from a second read model.
5. Roughly 2,000 to 2,600 lines are removable across server, contract and Console in 6 pull requests, listed at the end.

---

## 1. Consumer map

Consumers searched: apps/console/src (lib/queries.ts hooks and their users), apps/server/src (domains, app, read), apps/cli/src, integrations/, scripts/, docs, tests. "Generated CLI verb" means every read has one for free (apps/cli/src/generated/operations.ts, 2833 lines, read.* ops at lines 1600-2811).

| Read (route, verb) | Consumers | Evidence |
|-|-|-|
| /v1/needs | Console (needs-you, overview band, palette, shell), Herdr glance, Hermes skill | queries.ts useNeeds; integrations/herdr/jk-glance/main.js:12,29; hermes SKILL.md:67 |
| /v1/overview | Hermes skill, Herdr glance, scripts/verify.sh, selfwatch reproduce text, cli follow.ts | SKILL.md:66; main.js:29; selfwatch.ts:191 |
| /v1/issues, /v1/issues/:id | Console, glance, Hermes | queries.ts useIssueCards, useIssue |
| /v1/sessions, /v1/sessions/:id | Hermes (--live), glance | SKILL.md:75; main.js:30 |
| /v1/flow | Console (index, project work, sidebar, strip counts, palette), glance, Hermes | useFlow |
| /v1/flow/trend | Console index only (components/flow/trend-chart.tsx) | useFlowTrend; routes/index.tsx:8 |
| /v1/chain | Console chain and issue aside, Hermes | useChain; SKILL.md:72 |
| /v1/since | Console needs band | useSince |
| /v1/projects, /digests, /:name, /setup, /hygiene, /plan | Console project pages | useProject* hooks |
| /v1/machine, /v1/host | Console strip, glance (machine) | useMachine, useHost; main.js:31 |
| /v1/kpis | Console Improve and Accounts (useKpis, accounts.tsx), the retro bundle (read/retro.ts:312) | queries.ts useKpis |
| /v1/friction | Console Improve, Hermes SKILL.md:77, friction signals' "Reproduce:" line (domains/loops/friction.ts:217) | useFriction |
| /v1/capacity-loop | Console Improve only; text hints in throughput.ts:168, overload.ts:71, retro bundle (internal call) | useCapacityLoop |
| /v1/throughput | Console Throughput, retro bundle, throughput loop's READ command (domains/loops/throughput.ts:129) | useThroughput |
| /v1/finding-classes, /loop-yield, /fix-commits | Console Improve only | useFindingClasses/useLoopYield/useFixCommits |
| /v1/retro | the retro CLI (apps/cli/src/retro.ts:82) run by the weekly retro lead; nothing else | rg across repo |
| /v1/health (read health) | Hermes skill only (SKILL.md:78) plus tests | read/health.ts 125 + health-probe.ts 54 lines |
| **/v1/asks** | **nobody** (only apps/server/test/read/api.test.ts:194,286 and tests/scenarios/clients/replay.test.ts:201,404) | rg "read asks\|/v1/asks" finds no non-test caller |
| **/v1/changes** | **nobody but tests** (the stream's catch-up; Console uses /v1/stream via lib/live.ts:24) | tests/scenarios/read/read.test.ts:131-155, replay.test.ts:335 |
| **/v1/waits (read waits)** | **docs only**: one cite in docs/decisions.md:394 (NL41), docs/architecture.md:899 | rg |
| /v1/session (single) | cli retired.ts:17 mapping only | |

Reads with no consumer besides the generated CLI verb: asks, changes (stream catch-up), waits. Health and retro have exactly one consumer each (Hermes; the weekly retro lead).

Fields of big read models the Console never renders (name not found anywhere in apps/console/src; a rough regex check, so a field may still be read by the retro or a loop, which I did not verify per field):
- ThroughputModel: 47 of 168 field names, among them hostSamples, hostClassSamples, queueIntervals, leadAttempts, stepCosts, mergeWindows, testResults, flakyTests, flakeRate, localToCi, mergeLock, deploys, collector. Several are the raw stored rows the series are derived from.
- CapacityLoopModel: 17 of 63 (shadowMore, shadowFewer, whenMore, whenFewer, whenSame, slotAim, moreSlots, moreSlotsWithWaiter, loadRule, loadPerCore, processCap, perDayP90, swapoutMib, firstAt, leadsRunning, ...). Slot-aim shadow-mode figures; slot aim is now live ("slot aim 3 to 3 (on)" in data-loops.json host summary), so the shadow comparison is probably finished (unverified).
- Kpi object: the Console renders only definition (routes/improve.tsx:219), parts, history, value, target, n. It never renders decision, numerator, denominator or targetSource (rg "kpi\.(decision|numerator|denominator|targetSource)" in apps/console/src: 0 hits). They are served on every /v1/kpis response and in the retro bundle, and rendered into docs/product.md.
- KpiBlocks (seats/reviewers/tripwire): lightAttempt, leadAttempt, followUpAttempt, lightFinishMs, movedMs, leadMs, classShare, targetWatches are not rendered.

---

## 2. The 28 KPIs

Facts: kpis snapshot above. "Code reads it" = grep of the key in apps/server/src/domains and app: no hits for any key (verdict_changes_share appears once, as prose in the retro brief, domains/loops/retro.ts:53; quota_at_reset once as a comment, adapters/planning/accounts-source.ts:105). "Console" = rendered as a card on Improve (all 28), grouped into Off target / No target / On target / Not measured (routes/improve.tsx:351-393).

History caveat that applies to all: 6 weekly points, the factory went live 2026-11-08, so points 1-3 are empty for almost every KPI and point 4 (2026-10-30 to 11-06) is the pre-launch week with n=104-285. Only two full weeks (points 5 and 6) exist. "Stable enough to mean anything": none has more than 2 comparable points yet. Window growth is 127 to 822 to 1545 Issues filed, so per-Issue rates drift with the denominator.

| KPI | Target | n now | History (w4,w5,w6) | Decision, taken by code? | Overlaps / verdict |
|-|-|-|-|-|-|
| avoidable_touches | at most 0.07 (met, 0.038) | 1545, 58 touches | 0.23, 0.10, 0.04; counts 29, 83, 58 | no; friction loop files "touch:*" patterns on its own rates | 5 of 58 are decision_answered = same 5 events as owner_decisions_per_100. Denominator includes ~212 hygiene Issues/wk. KEEP as north star. |
| asks | at most 0.07 (met, 0.004) | 6 events | 0.08, 0.01, 0.00 | no | 6 events = the 5 owner answers + 1 orchestrator answer. DEMOTE. |
| specs_per_100 | watch | 105 specs | 0, 2.07, 6.80 | no | rising because the Spec path was off before. DEMOTE. |
| owner_decisions_per_100 | watch | 5 | 7.09, 1.22, 0.32 | no | 5 events again. DEMOTE. |
| errands_reached_per_100 | watch | 77 | 0, 1.8, 5.0 | no | parent of the next four. KEEP as one guardrail. |
| errands_no_secret_no_hands | watch | 11 of 77 | -, 0.00, 0.14 | no | a part of the parent (parts place+approval). DEMOTE. |
| errands_auto_run_share | watch | 0 of 77 | -, 0, 0 | no | zero by construction until the first class shipped 2026-11-19 (kpi-catalog.ts targetSource). DEMOTE. |
| errands_turned_away | watch | 15 of 54 | -, 0.09, 0.28 | no | denominator differs (raised, not reached). DEMOTE to part. |
| recommendation_taken | watch | 2 of 5 | 0.22, 0.10, 0.40 | no | n=5. Cannot mean anything. DEMOTE. |
| specs_not_needed | at most 0.2 (met, 0.053) | 5 of 95 | -, 0.00, 0.05 | no KPI read, but friction does act on the same mark: spec_unneeded rule (domains/loops/friction.ts:89, min 2, no rate) | has a target and a monitor. KEEP. |
| verdict_changes_share | watch | 44 of 95 | -, 0.63, 0.46 | the retro lead reads the verdicts directly (retro-taste.ts) | DEMOTE (taste lives in the retro bundle). |
| first_verification_passes | at least 0.9 (met, 0.964) | 1338 | 0.86, 0.95, 0.96 | friction acts on regression at 0.05 per closed Issue (friction.ts:68-72), stricter than the KPI | KEEP. |
| first_watch_dwell_p50 | watch | 1338 | 7.8 min, 5.1 min, 10.0 min | no | exists only to qualify the pass rate. DEMOTE to part of first_verification_passes. |
| refusals | at most 0.25 (met, 0.089) | 138 | 0.61, 0.23, 0.09 | friction acts on refusal at rate 0.1 per closed (friction.ts:55) | target is 2.5x looser than the rule that files it. DEMOTE (friction is the monitor). |
| cycle_p50 | watch | 1604 | 0.9 h, 2.0 h, 1.4 h | no | KEEP, owner sets a tripwire. |
| queue_wait_p90 | watch | 1655 | 4.4 h, 8.3 h, 4.5 h | no (capacity aim acts on its own inputs, not this) | KEEP; absorbs the next three as parts. |
| queue_capacity_share | watch | 1887 | 1.00, 0.66, 0.79 | no | same question as queue_wait_p90.parts, answered differently (see section 5). DEMOTE. |
| idle_capacity | watch | 167 h | -, -, 0.90 | no | catalog says "high by construction"; one data point. DEMOTE. |
| working_share | watch | 6448 | 0.65, 0.64, 0.58 | no | part of cycle (12 parts already). DEMOTE. |
| dropped_after_lead | watch | 1526 | 0.20, 0.07, 0.03 | no; friction has touch:cancelled | DEMOTE. |
| nudges_acted | watch | 143 | 0.46, 0.30, 0.56 | no; a steward-loop yield | DEMOTE (belongs with loop yield). |
| fix_commits | watch | 1171 | 340, 1068, 378, 664, 393, 1171 | no | swings 3x week to week, counts every project's default branch, not the factory. Own band on Improve already. DEMOTE. |
| window_points | watch | 1545 | -, 1.15, 1.35 | no | KEEP only as the cost number (see below). |
| cost | watch | 1545 | -, 2.59, 3.86 | no | catalog: "dollars are notional" (flat-rate Max). DEMOTE to parts of window_points. |
| quota_at_reset | watch | 4 resets | 0.98, 0.94, 0.97 | picker in packages/accounts reads its own ledger, not this KPI (unverified) | stable but n=4. KEEP with a target. |
| issues_closed_per_day | watch | 7 days | 0, 17, 114, 229 | no | 229/day is mostly hygiene Issues (hygiene closed 202 of 212 in 7 days, data-loop-yield). Not a goal. DEMOTE. |
| test_slot_wait_p50 | watch | 7947 | 75 ms, 51 ms | capacity loop tunes slots from slot_waits itself (catalog says so) | 51 ms median is not a signal. DEMOTE. |
| minutes_over_ceiling | watch | 10008 | 0.00, 0.09 | selfwatch alerts on the same facts: load_over_ceiling, 10 consecutive minutes (domains/loops/overload.ts) | DEMOTE. |

Decision-taken test: the catalog states "a KPI that drives none is dropped" (kpi-catalog.ts header; docs/product.md:64). Of 28 decisions, each is a human reading the page; none is executed. They are guidance prose (the `decision` strings are not rendered by the Console, so even the human never sees them there).

Five errand KPIs: errands_reached_per_100 is the parent; no_secret_no_hands and auto_run_share are two of its parts and turned_away has a different denominator. Collapse to one KPI with 5 parts (it already has 5 parts; reached.place + reached.approval is a part sum, kpis.ts errandsReached).

asks vs owner_decisions_per_100 vs recommendation_taken: all count owner-answered Decisions this week (6, 5, 5). Cause: avoidable_touches counts decision_answered where worth_asking IS NOT TRUE (kpis.ts:114-120), but the catalog says the worth-asking click "the owner never gave" (kpi-catalog.ts, recommendation_taken targetSource). So every owner-answered Decision is counted as avoidable by construction, and also appears in three other KPIs.

cycle vs queue wait vs working share vs idle vs queue_capacity_share: cycle_p50 (filed to closed), queue_wait_p90 (filed or reopened to admitted), working_share (time by state, 12 parts) and queue_capacity_share (queued time split) are one decomposition: cycle = queue + work + waits. Present as one KPI (cycle) with the split as parts, not five cards.

### Proposed set (north star + 6 guardrails)

| Key | Target | Who acts when it breaks |
|-|-|-|
| avoidable_touches (north star) | at most 0.07 per Issue (existing, owner-signed 2026-11-07). Change the denominator to Issues filed by owner/orchestrator/signal sources, excluding hygiene and loop-filed, or report the absolute weekly count beside it | friction loop (touch:* patterns) files; align friction's touch thresholds to this target (see section 3) |
| first_verification_passes | at least 0.9 (existing) | friction loop's regression rule (needs the same number); the light-seat gate reads the same first-pass data |
| specs_not_needed | at most 0.2 (existing) | friction spec_unneeded rule; the Spec screen is judged by it |
| errands_reached_per_100 | owner sets after 3 full weeks (now 5.0, history 0, 1.8, 5.0); aim is falling | the lead of dotfiles adds an auto-run class or the screen gets a rule (parts: secret/hands/place/approval, turned away, auto-run) |
| cycle_p50 | at_most 3 h as a tripwire (1.5x the worse full week, 2.0 h); owner decision, no basis yet | capacity tuning (queue_wait_p90 parts name the reason) |
| queue_wait_p90 | at_most 8 h tripwire (worse full week 8.3 h); owner decision | raise a cap/seat or change a chain; parts: capacity, chain, drain, production red, working/waiting split |
| quota_at_reset | at least 0.9 (data 0.94 to 0.98; docs/accounts.md simulation 91-100 %) | owner adds a subscription when this holds with a long queue |

That is 1 + 6 on the table; 21 leave it.

### What each demotion loses
- asks, owner_decisions_per_100, recommendation_taken: lose a "silence vs success" floor (specs_per_100 + owner_decisions near zero meaning checkpoints are silent). Keep as parts of avoidable_touches: {decision_answered, recommended}. Silence detection is then one line in the card.
- specs_per_100, verdict_changes_share: lose a Spec-path-silent signal; the retro bundle already carries taste (retro-taste.ts) and Spec counts via friction.
- errands_no_secret_no_hands, errands_auto_run_share, errands_turned_away: nothing, if they become parts of errands_reached_per_100 (reached.* already computes them).
- refusals, dropped_after_lead, nudges_acted: nothing: friction (refusal 0.1, touch:cancelled) and loop-yield already carry them; steward nudges move to the steward's yield.
- first_watch_dwell_p50: becomes a part of first_verification_passes; one number kept for "pass over instant watches is not evidence".
- fix_commits: keeps its own band (FixCard, routes/improve.tsx:284) and /v1/fix-commits; leaves the KPI table.
- working_share, queue_capacity_share, idle_capacity: become parts of queue_wait_p90 / cycle_p50, once the two definitions of "held by capacity" are made one (section 5).
- window_points, cost: one "Cost" part list under quota_at_reset; seats blocks keep cost per seat.
- issues_closed_per_day: stays on the Flow page / capacity-loop (`closed_per_day`, capacity-tuning.ts:34), which has the epoch cut; the KPI copy has none.
- test_slot_wait_p50, minutes_over_ceiling: stay on Throughput and selfwatch (already alerts on overload).

---

## 3. Monitoring: does anything alert when a KPI crosses its target?

No. Evidence:
- Target comparison exists only in the Console: apps/console/src/lib/improve.ts:75-98 (meets/targetStatus) and routes/improve.tsx:351-393 ("Off target" section, "N of M targets met"). A person has to open Improve.
- Server: rg for `.target` finds no consumer of KPI targets outside kpi-fields.ts. The retro compares a *recommendation's* before/after (read/retro.ts:152-215 figureOf, ledgerOf), not targets.
- The weekly retro lead (a Claude session, filed by the friction pass: domains/loops/retro.ts:1-60, app/loops/friction.ts:126) reads `factory retro` (kpis with history) and judges. Whether it flags off-target KPIs is its prompt's call; the brief says "the numbers against last week", not "targets". Whether the retro has run and what it filed is unverified (retro signals are not in loop-yield: YIELD_LOOPS = friction, hygiene, selfwatch, throughput, read-models.ts:991).
- The friction loop is the only code that acts, with its own numbers and denominator (per Issue closed, 7 days; domains/loops/friction.ts:45-100):

| Pattern | Friction files at | KPI target | Gap |
|-|-|-|-|
| owner notes (touch:noted) | 0.5 per closed, min 5 | avoidable_touches at most 0.07 per filed (notes alone are 45/1545 = 0.029) | notes could be 17x the KPI-target rate and file nothing |
| avoidable_touch group | 0.15 per closed | 0.07 | 2x |
| refusal | 0.1 per closed, min 3 | 0.25 | friction is stricter than the target |
| regression | 0.05 per closed, min 3 | first pass at least 0.9 (regression 0.1) | friction is stricter |
| touch:cancelled | 0.4 per closed | none | |

So the targets (0.07, 0.25, 0.9) and the friction rules (0.15/0.5, 0.1, 0.05) are two parallel threshold systems with different denominators. This week every target is met and friction filed 30 signals anyway (data-loop-yield.json: friction 7d signals=30, mostly stall 10, regression 3, unreviewed_ship 3), so the KPI table and the filings do not track each other.

Can go off target with nobody noticing: all 23 watch-only KPIs by definition (no target), plus asks (at most 0.07, no friction rule on it), and avoidable_touches between 0.07 and 0.15 per closed Issue (the owner-signed 0.07 has no teeth). first_verification_passes between 0.90 and 0.95 is caught by friction regression before it breaches.

Proposal: one threshold table. Take friction's rule table as the single place that acts, and generate the KPI targets of the kept 7 from it (or the reverse), same denominator. Delete targetSource prose for the rest.

---

## 4. Seats, reviewers, edges

Not finished experiments; live control loops, 2 to 3 days old.
- Seats (kpis-seats.ts, 357 lines; first commit 475691a0, 2026-11-17, last 647a150e, 2026-11-18): the tripwire gate decides whether triage's small Issues start on the light seat (compose-leads.ts:34 readTripwire, domains/leads/light.ts:32 judgeLightGate). config/roles.json has `light` (haiku high). docs/decisions.md NL33, NL38, NL40, NL45, NL46, NL50 (2026-11-17 to 11-19). Live data: light 227 Issues (14.8 %), moved up 24 %, first pass 0.952 vs lead 0.963 (data-kpis.json seats).
- Reviewers (kpis-reviewers.ts, 247 lines; 9f1eed14, 2026-11-17): reviewer-cheap (haiku high) reviews half the reviews (parity of the Issue number) until reviewerTakesAll (compose-leads.ts:84, leads-start.ts:296). Tripwire now: enough=true, passOk=true, regressOk=false, takesAll=false: the A/B is mid-flight. Findings per review 2.60 cheap vs 0.91 plain (the two seats are not comparable on this number, kpis-reviewers).
- Edges (kpis-attempts.ts readInferredEdges, 0b96072c 2026-11-17): the block is display only (consumer: Console edgeWords, lib/improve.ts:879). The sweep that acts, sweepEdges (domains/loops/edge-need.ts), does not read it. Needed share 71 % (37 of 52 settled).
- attemptSeats (kpis-attempts.ts, 162 lines, ead4af68 Console commit 2026-11-17): cost and first pass by tier x effort. Duplicates two other breakdowns: `cost.parts` by seat (13 parts, kpis.ts seatParts) and `seats.rows` by light/lead/filed. Three seat breakdowns for one question.
- Odd row: the "filed" seat is $16.26 per Issue (167 Issues) vs lead $2.79; it is unexplained in the table and may be dominated by Opus attempts (opus: 133 attempts, $20.17 each in attemptSeats). unverified.

Verdict: seats and reviewers earn their code today but belong to a decision lane (the light gate and cheap-reviewer takeover), not to the KPI model; they should leave /v1/kpis and ride on /v1/finding-classes or their own read, so that kpis stops being the place where gate state lives. attemptSeats and edges are measurement with no actor: delete or fold.

---

## 5. Duplicated SQL and logic

- "The counting epoch and the three answers" (docs/architecture.md:915): the three answers are host / queue / cost: three questions on the Throughput page (read/throughput-answers.ts), not three counts of one thing. No change needed to them. The real duplication is that the epoch (config/throughput.json, 2026-11-15) binds readThroughput, readCapacityLoop, window facts and lead costs but not /v1/kpis (rg epoch in kpis*.ts: no match, only SQL "extract(epoch ...)"). So "Issues closed per day" comes out twice: kpis-flow.ts:220 (no epoch cut, comment says so) and capacity-tuning.ts:34 `closed_per_day` (epoch-cut). The retro bundle carries both. Also three vocabularies for "the figure a retro recommendation moves": KPI_KEYS (28), CAPACITY_FIGURE_KEYS (9, read-models.ts:2088) and FRICTION_MARKER_KEYS (retro.ts figureOf); the throughput loop has a fourth meaning of kpi (domains/loops/throughput.ts:183-301: failed_run_minutes, slot_minutes_per_issue, step_peak_mib, process_growth_mib, queued_minutes, tenant_*). "KPI" is used for four different families. CAPACITY_FIGURE_KEYS overlap KPIs: closed_per_day = issues_closed_per_day; minutes_over_ceiling_per_day = minutes_over_ceiling; slot_wait_p90_ms vs test_slot_wait_p50; idle_seat_hours_* vs idle_capacity.
- Queued time is defined several ways:
  - kpis.ts:177 queueWaits (filed/reopened to admitted)
  - kpis-flow.ts:49 queuedTime and :71 idleHours (to_state=queued from issue_events + planning_edges)
  - kpis.ts:481 queueWaitParts, retro-waste.ts:48-52, capacity-loop.ts:119-125 (queue_intervals clipped to the window: `least(coalesce(to_at,...)) - greatest(from_at,...)` written 4 times)
  - throughput-answers.ts:255, throughput-series.ts:50,58, throughput-loop.ts:292 (queue_intervals again)
  Concrete inconsistency in one card pair of the snapshot: queue_wait_p90.parts say capacity 3.97e9 ms vs chain 2.02e9 ms (capacity/(capacity+chain) = 0.66), while queue_capacity_share says capacity 8.36e9 vs chain 2.29e9 (0.785). Same question, two answers, both on the Improve page.
- Interval-from-next-event CTE `lead(at) OVER (PARTITION BY issue_id ORDER BY version)` over all of issue_events: kpis-flow.ts:52,77,106; retro-waste.ts:32,63; throughput-account.ts:120,165 (7 sites). It scans every applied event, then filters by window. Not verified against EXPLAIN.
- percentile: stats.ts:4 is the shared one (null on empty); throughput-loop.ts:47 redefines it (returns 0 on empty, sorted input). SQL percentile_cont is written 30+ times (capacity-loop 8, throughput.ts 13, throughput-account 6, cap-facts 4...). Window type: kpis.ts:44 exports Window, kpis-attempts.ts:8 declares its own, stats.ts windowOf.
- Each KPI's prose exists five times: catalog (kpi-catalog.ts 376 lines: label, numerator, denominator, decision, targetSource), the `definition:` string in kpis.ts/kpis-flow.ts (long prose per KPI), the Console MEANING (lib/improve.ts:460-506), KPI_HINT/KPI_ICON/KPI_ORDER (improve.ts:153-185, 508; improve.tsx:107-143), and docs/product.md's generated table (28 rows). The test (packages/contract/test/kpi-catalog.test.ts, 44 lines) holds only table vs catalog.
- HISTORY_WINDOWS=6 (read-models.ts:346): every /v1/kpis call and every retro bundle runs kpisOf for 6 windows (kpis.ts:811-840), 3 of which precede the factory's go-live. route-timer.ts:43 documents /v1/retro at 9.7 s for 1 day and over 87 s for 7 days (2026-11-19), and exempts retro, throughput and kpis from the slow-route alert (REPORT_READS). Not verified which part dominates.

---

## 6. Console: Improve and Throughput

routes/improve.tsx 1305 lines, lib/improve.ts 885, test 442. Panels (line ranges are the component spans):
- 28 KPI cards (KpiSections 340-393, KpiCard 181-232): 7 of 28 map to the sharper set (25 %), cards ~215 lines + MEANING/KPI_HINT/KPI_ORDER in improve.ts (~150 lines).
- Friction 395-476 (80): maps to north star (touches) and monitoring. keep.
- Loop yield 477-541, Held finding classes 542-568: maps to loop effectiveness, no KPI. keep, but they are loop reports, not KPIs.
- Fix commits 284-339, 569-655 (~140): maps to a demoted KPI.
- Capacity 656-1057 (~400): CapacityCards, CapacityTables with Steps by peak memory, Queue waits by reason, Edges by shared files, Lead cost per repo, CapacityReaped. Overlaps Throughput (queue by reason 607-638 "What each reason cost"; Where it goes 472-503; steps by host 819). Maps to queue_wait_p90's parts at most.
- Edges 1058-1079, Reviewers 1080-1128, By seat 1129-1260 (~200): no KPI of the 7; these are the seat gate states.
So of ~1100 panel lines (excluding the page shell), about 15 % serve the proposed set directly (7 cards, friction, parts of queue).

routes/throughput.tsx 1003 lines: Answers 251-350 (host, queue, cost; three questions) and a Detail fold of 14 tables (Classes, Tenants, Processes, Timeline, Reasons, LeadTime, Scorecard, RemoteSteps, StepsByHost, Improvements). Maps to proposed KPIs only through queue_wait_p90 (Reasons, LeadTime). The page's real consumer is the throughput loop (it files Issues from findings: domains/loops/throughput.ts) and the Improvements ledger, so it is a diagnostic page for a loop, not a KPI page. Two Console pages (Improve/Capacity and Throughput) fetch two models (capacity-loop, throughput) for overlapping content.

Screens with data no decision hangs on: Improve's "Edges by shared files" and "Lead cost per repo" (capacity-loop), "By attempt seat", "Inferred chain edges", the 17 shadow-mode capacity fields, Throughput's Timeline (CPU, memory, swap, pressure, load: selfwatch alerts on the same facts) and RemoteSteps/StepsByHost (unverified who decides on them).

---

## Proposed changes (each one PR, one agent)

Ordered by simplification / risk.

### P1. Delete the unconsumed reads: /v1/asks, /v1/waits, and fold /v1/changes into the stream (S to M)
- What is there: asks has no non-test caller; waits one doc citation (NL41, 2026-11-14 one-off); changes is the stream's catch-up and only tests call it.
- Change: remove read/asks.ts (96) and its use in lines.ts/reader.ts if unshared (unverified), read/wait-census.ts (154), WaitCensusModel (read-models.ts:710-777), routes (api/read.ts:144-160, api/read-models.ts:491-505), regenerate operations.ts, tests; keep /v1/changes only if replay clients need it (check tests/scenarios/clients/replay.test.ts first).
- Must not change: /v1/stream, /v1/needs, issue cards.
- Risk low, size S (about 450 lines incl. generated and tests).

### P2. Delete the edges block and attemptSeats from /v1/kpis (S)
- Change: remove kpis-attempts.ts readInferredEdges/readAttemptSeats (the file is 162; costOfAttempts is used by kpis-seats.ts:22, so keep that 40-line helper), InferredEdgeKpis (read-models.ts:661-677), AttemptSeatRow (445-468), the keys in KpiModel, EdgeSection (improve.tsx:1058-1079), the "By attempt seat" block (1210-1260), edgeWords/attemptSeatCells (improve.ts), the test kpis-attempt-seats.test.ts (151).
- Must not change: sweepEdges and the light/reviewer gates; seats.tripwire.
- Risk low, size S (about 450 lines).

### P3. Cut the KPI table from 28 to 7 and fold the rest into parts (M)
- Change: KPI_KEYS 28 to 7 (read-models.ts:300-330); delete 21 catalog rows (kpi-catalog.ts 376 to about 150); delete the matching kpi({...}) blocks in kpis.ts (about 12 blocks, about 180 lines plus helpers errandsAutoRun, orchestratorSteering consumers excluded) and kpis-flow.ts (408 to about 200); regenerate docs/product.md; Console KPI_ORDER/MEANING/KPI_ICON/KPI_HINT entries (about 90 lines) and 21 fewer cards; errands_reached_per_100 gains parts {no_secret_no_hands, auto_run, turned_away}; avoidable_touches gains parts {decision_answered, noted, cancelled, woken}; queue_wait_p90 gains working_share and capacity/chain parts from one definition; first_verification_passes gains the dwell part. Keep computing what the friction loop and the retro import (avoidableTouches, issuesFiled, ownerVerdict in kpis.ts; REGRESSION_CAUSES in kpis-flow.ts).
- Must not change: the stored facts, avoidableTouches semantics used by friction (friction.ts:5), the catalog test (still one decision per KPI), the retro marker `kpi=` for existing ledger entries (retro figureOf must keep resolving old keys: map removed keys to parts or leave ledger entries "unknown").
- Risk med (retro ledger and the Console tests, improve.test.ts 442 lines), size M (net about -900 lines).

### P4. One owner decision: thresholds, denominator, targets (S, decision first)
- Change: one table. Either set KPI targets from friction's THRESHOLDS or friction's rates from the KPI targets (same denominator: filed or closed), drop `targetSource` prose for the 7 kept down to one line. Choose the denominator for avoidable_touches that excludes loop-filed Issues (hygiene filed 212 of 1545 this week, data-loop-yield.json).
- Must not change: owner-signed 0.07; friction's min counts.
- Risk low, size S. Needs the owner's tripwire numbers for cycle_p50 and queue_wait_p90 (proposed 3 h and 8 h are mine, no basis).

### P5. Merge the two "queue time" definitions and the shared SQL (M)
- Change: one function queuedHoursByKind(sql, window) in read/ used by kpis.ts:481, retro-waste.ts:48, capacity-loop.ts:119-125; one intervalsOf(states) CTE used by kpis-flow.ts (3), retro-waste.ts (2), throughput-account.ts (2); delete throughput-loop.ts:47 percentile in favour of stats.ts; delete kpis-attempts.ts Window. Replace queue_capacity_share and idle_capacity (kpis-flow.ts:49-100) with queue_wait_p90 parts.
- Must not change: epoch cut on throughput reads; /v1/capacity-loop and /v1/throughput shapes.
- Risk med (many tests, subtle clip semantics), size M (net about -250).

### P6. Console: one capacity page (M)
- Change: delete Improve's CapacityTables (766-991) and CapacityReaped (992-1012) where Throughput shows the same (queue reasons, steps by memory, lead cost per repo), keep the three CapacityCards that map to queue_wait_p90 parts; stop fetching /v1/capacity-loop on Improve. Optionally move seats/reviewers off Improve to a "Seats" fold fed by /v1/finding-classes. Then drop the 17 unrendered shadow-mode fields (shadowMore ... processCap) if the slot-aim shadow phase is over (confirm: slot aim is "on", data-loops.json host summary).
- Must not change: /v1/capacity-loop for the retro and the throughput loop's READ text.
- Risk med, size M (about -700 lines in the Console, -150 server/contract).

### P7. Stop serving unrendered per-KPI prose (S)
- Change: remove `decision`, `numerator`, `denominator` and `targetSource` from the served Kpi (they stay in the catalog and docs/product.md) and delete the duplicate `definition:` prose per KPI in kpis.ts/kpis-flow.ts, rendering the Console popover from the catalog's numerator/denominator. After P3 this is about 7 strings.
- Risk low, size S.

---

## Estimated lines removed

| PR | Lines (server+contract+Console+tests, generated included) |
|-|-|
| P1 unconsumed reads | about 450 |
| P2 edges and attemptSeats | about 450 |
| P3 KPI table 28 to 7 | about 900 net |
| P4 thresholds | about 50 (docs prose) |
| P5 shared SQL | about 250 net |
| P6 capacity page | about 850 |
| P7 prose | about 150 |
| Total | about 3,100 gross, 2,000 to 2,600 net of what moves to parts |

Estimates are from file and range sizes, not from a dry run.

## Could not check
- Whether the weekly retro has run and what it recommended (retro signals are absent from loop-yield; no /v1/retro snapshot).
- The cost of each read (EXPLAIN); the 87 s retro figure is from the route-timer comment, route-timer.ts:43.
- Per-field consumption of ThroughputModel/CapacityLoopModel by the retro and loops (checked only against Console source).
- Whether read/asks.ts and read/lines.ts are shared with issue cards before deleting asks.
- The meaning of the "filed" seat at $16.26 per Issue.
- docs/accounts.md picker behaviour (did not read), and whether Herdr glance reads any KPI (it reads needs, overview, issues, machine, flow only, per main.js:29-35).
