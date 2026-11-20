# Audit: how the factory takes signals in and improves itself

Scope: intake (domains/intake, app/intake.ts, adapters/intake, apps/door), the loops (domains/loops, app/loops, adapters/hygiene, adapters/selfwatch, hygiene catalogue), live snapshots in /tmp/sf-cycle.GqxbyO. Read-only. Nothing was run except rg, jq, sed, git log and one `factory read retro` that hung and was abandoned (so no live DB figure beyond the snapshots).

Size of the area (wc -l): domains/intake 795, app/intake.ts 1529, adapters/intake 1538, apps/door 690, domains/loops (the files named in the brief plus overload) 4089, app/loops 5069, adapters/hygiene 4319, adapters/selfwatch 393, the matching read/ models 3682 (read/ has 71 files). Churn: 131 commits touching the loops, hygiene and selfwatch paths since 2026-10-20 and 37 touching intake, out of 1413 commits in total.

## Headline numbers (snapshots, 7 days unless stated)

- 1545 Issues were filed in 7 days. The four self-improvement loops filed 212 (hygiene) + 21 (friction) + 24 (selfwatch) + 25 (throughput) = 282, which is 18 percent. Hygiene alone is 13.7 percent.
- Hygiene grew from 50 Issues in the 7 days to 2026-11-17 (docs/guide/loops.md yield table) to 212 now: the daily pass fan-out across ~20 projects. NL44 (docs/decisions.md:439) already measured "164 of 1439 Issues in 7 days (11 %) at $89 and 20 lead-hours" and added scripted fixes on 2026-11-18; the share did not fall (11 to 13.7 percent), though the fixes are two days old.
- Almost everything the loops file ends "done" (hygiene 202 of 212, friction 21 of 21, selfwatch 19 of 24, throughput 19 of 25). That measures that a lead closed the Issue, not that anything moved. Noise (dropped or cancelled) is small except: cochange 10 of 10 (held), agentsmd 2 of 3 (held), throughput queued_minutes 6 of 17, selfwatch migration_clash 3 of 12, friction touch 2 of 2 and ship_refused 1 of 1.
- Median time to close is 35 to 55 minutes for every loop (loop-yield medianCloseSeconds: hygiene 3286, friction 2459, selfwatch 2523, throughput 2819).

## Q1. The signal path, in words

Entries (everything ends in `receive()`, app/intake.ts:765, except the direct Issue writers in point 7):

1. Door alerts (Kuma, HyperDX): apps/door verifies a per-source token, POSTs to `intake.alert` (app/intake.ts:1016). A route registry (`intake_door_routes`) maps monitor to repo; no route means `noteUnrouted` (counted, dropped as `unrouted`), later screened (app/loops/screen.ts) or routed by the owner. Trust `machine`.
2. Door feedback (apps' own feedback): `intake.feedback` (:1078), trust `outside`.
3. GitHub poller (adapters/intake/github.ts, 591 lines): labelled or owner-authored GitHub issues, and first-red `checks` on the default branch (only software-factory and weatherorb enable checks, rg project.yaml). A GitHub issue is an alert of status `event`. Thirteen or more projects enable the github source.
4. launchd poller (adapters/intake/launchd.ts): down/up alerts for jobs.
5. `signal file`: owner, orchestrator, agents, the Hermes `owner:hermes` token (`envelopeOfRequest`, :185). The token decides trust; `from` may only lower it.
6. The four loops and the retro, and checkpoint disagreements (main.ts:316): all call `intake.api.file(body, 'agent')` with source `agent:<repo>`. They are indistinguishable from a lead's own signal in `intake_signals` (data-signals-newest200: 41 `agent:software-factory` signals mix loop output and lead-filed bug reports).
7. Not signals: `issue new`, plan rows (planning-sync.ts:134), replan, planning-pass call `fileIn` directly (5 `fileIn` sites: intake x2, planning-replan, planning-sync, planning-pass, issue-new). They skip intake dedup entirely and rely on their key.

Decision points in `receive` for a human, agent or loop signal (app/intake.ts:765-850):
1. loop_guard (`madeBy`, only set from a GitHub body marker, adapters/intake/github.ts:178).
2. outside trust: work repo drop, probe, else `outsideIn` (amend an open Issue that carries the fingerprint, else hold in quarantine; a screen loop and the owner promote or dismiss).
3. `gate` (work repo owner-only, unknown project, project does not list the source).
4. probe flag: stored dismissed.
5. Alerts down/up: subject lookup (open Issue amends or notes, a regression moves a watching Issue back), host incident correlation (30 min window, `groupOf`), triage workflow (`decideDown`), heal rules with a grace wait, `intake_seen` memory for replays; `up` heals an unstarted Issue.
6. Alert events (GitHub): subject seen before drops; `repeatIn`.
7. Human, agent and loop signals: `matchOpen` (token overlap, >=0.6 and 2x ahead of the next: amend; 0.3 to 0.6: unsure), `fingerprintKnown` (repo+normalised title, same source, 24 h, open or recently closed), then `askTriage` (an agw model call, 8 s wait, open Issues plus Issues closed in the last day), then `humanIn`: `repeatIn`, settled (dropped), amend a note, or `fileNew`.

Dedup mechanisms, all doing "do not file this twice":
1. Event/filed/noted keys (kernel/keys.ts, `signalByKey`, `intake_seen`): exact replay.
2. Fingerprint (source+repo+title, digits and punctuation stripped; `fingerprintOf`, domains/intake/rules.ts:112) with a 24 h window (`fingerprintWindowMs`, app/intake.ts:107, not overridden in ~/.config/factory/env).
3. Subject episodes (source+subject) and incident group (host, 30 min).
4. Token-overlap `matchOpen` (rules.ts:84).
5. The triage workflow (model).
6. Finding classes (domains/loops/classes.ts): noise share over the last 10 decided Issues, hold 14 days, probation.
7. Hygiene lifecycle (domains/loops/hygiene-lifecycle.ts): key to newest Issue, suppress while open, reopen up to twice within 29 days, heal.
8. Selfwatch rows (`selfwatch_findings`: subject key, evidence hash, cleared).
9. Throughput ledger (`throughput_findings`: one open per project, `heldSubjects`, 14 days after a drop).
10. The retro marker ledger (regex over signal text).

Yes, several do one job. The loops each have their own key store (7, 8, 9, plus friction which has none) and then also pass through 2, 4 and 5 which were designed for human text.

Where the same finding is still filed twice (all verified in data-signals-newest200 unless marked):
- Friction refiles daily. Friction became daily on 2026-11-17 (docs/guide/loops.md "Friction shows 2 passes because its pace was weekly until #420 made it daily") but still counts a rolling 7-day window and intake's fingerprint window is exactly 24 h. Median close is 41 min, so the Issue is closed by the next pass, the window still holds the old events, and a new Issue is filed. Evidence: "Friction: Specs triage made owed that did not need the owner" filed as issue_2339 (11-18 20:53) and issue_2474 (11-19 20:54); 21 friction Issues from 6 passes in 7 days (10 of class stall).
- The "weekly" retro is daily. `fileRetro` runs on every friction pass (app/loops/friction.ts:100-ish, unconditional); retro Issues issue_2341 (11-18 20:53) and issue_2475 (11-19 20:54). docs/guide/loops.md:178 says both "a weekly review" and "each friction pass files one retro signal".
- Amended signals leave no fingerprint row. `humanIn` amend branch (app/intake.ts:591-604) stores the signal with key null and no `insertSubject`; only `fileNew` registers one (:362-407). `latestByFingerprint` reads `intake_subjects` only (adapters/intake/store.ts:231). So a signal folded into another Issue is asked of the model again next time. Seen: shutterflow "unused files" amended into the "unused exports" Issue issue_2356 at 21:24 and the same title filed as new issue_2357 at 21:34.
- The same fact from two detectors. `routes_slow`: Kuma monitor "Software Factory - Push is down: factory routes slow: p95 ..." filed issue_2313 (11-18 18:16), selfwatch `routes_slow` filed issue_2353 (21:06, the Kuma alert joined it as an incident), Kuma filed issue_2377 again (11-19 02:55). Default-branch red has four watchers: hygiene `check` probe, selfwatch `ci_red` (two reds in a row), intake `checks` (first red), merge-guard/noteRedBranch.
- Wrong folds of distinct loop findings by title overlap or the model: friction "Stalled because the lead stopped reporting" amended into issue_2471 ("something blocked the lead", 11-19 20:54); hygiene "unused files" into "unused exports" (2356 and rollhook 2368 and agent-workflows 2394). Four in a 200-signal sample.
- Swap: selfwatch `swap_growth` filed issue_2309 (11-18) and issue_2490 (11-20 02:23); a lead then filed issue_2491 "swap_growth fires on a two-minute swap burst" at 02:32, i.e. the loop's own false positive reported by the lead it created.

## Q2. The friction key defect: verified, bigger than described

Where: `apps/server/src/read/friction.ts:119-132` builds `ship_refused:${plain(detail, 80)}` and `refusal:${kind}:${plain(detail,80)}` after `GROUP BY kind, detail` in SQL. `plain` (read/words.ts:18) rewrites issue ids to nouns and truncates at 80 chars; it does not touch commit SHAs.

Facts (data-friction.txt, 7 days, 1605 Issues closed):
- 101 ship refusals; 90 `ship_refused:` keys; 72 of those 90 embed a SHA (78 of the 101 refusals). Largest single key has count 5.
- 44 keys read "commit <sha> is not on origin/master: merge it first", 13 "is older than this attempt", 7 "deployed <sha> does not hold <sha>", plus 3 for origin/main.
- The truncation happens after the SQL grouping, so one displayed key appears several times (7 keys appear 2 to 4 times each: "it waits for an Errand...", "it waits for the answer to a Decision...", "it waits for the verdict on an artifact..."), each row with its own count. `patternsOver` judges each row alone (domains/loops/friction.ts:150-170) so they never add up.
- Consequence 1: the "which refusal repeats" logic can never see the largest friction there is (6.3 per 100 closed Issues are refused ships). `friction.ts:42` also sets the refusal rule at min 3 AND 0.1 per Issue closed: one key would need 160 events in a week. Even fully normalised, the SHA family is 44 events = 0.027, so it stays under the bar. The rule is unreachable at current volume (the biggest refusal key of all is 15 = 0.009). Over the threshold today: stall:unreported, stall:regressed, lead_gone, spec_unneeded:triage. Nothing else (computed from the snapshot with the code's THRESHOLDS and BY_KEY).
- Consequence 2: the `ship_refused` class has one Issue, one noise. Meanwhile a lead filed the same finding by hand ("A ship refused for 'not on origin/master' or 'older than this attempt' names the commits i...", amended) which is what a working loop would have filed.
- Other un-normalised keys: stall reasons are an enumerated set (STALLS), fine. Hygiene keys are paths, fine. Selfwatch subjects are workflow, migration number, lead id, issue id: stable. Signal titles carry the pattern label, and the fingerprint strips digits but not hex letters, so a SHA in a title would still make a new fingerprint (not reached today because those keys never file). The one other place that embeds free text in a key is `refusal:<kind>:<detail>` (23 keys, same fix).

Proposed fix (S, low risk): in `countsOf` replace SHAs, issue numbers and annotation counts in the reason with placeholders (`/[0-9a-f]{7,40}/` to `<sha>`, digits to `N`) before keying, then sum rows of equal key; change `refusal` to a count-led rule (for example min 10 events in the window and 0.02 per Issue closed) or judge ship refusals against ships attempted, not Issues closed. Update `friction-evidence.ts:55-75`, which re-derives the key by calling the same `plain()` and compares for equality (it must call the same normaliser).

## Q3. Per loop

### friction (domains/loops/friction.ts 223, app/loops/friction.ts 190, read/friction.ts, friction-evidence.ts, retro.ts)
- Measures counted waste (refusals, stalls, lost leads, touches, steering, regressions, unreviewed ships) over 7 days. Files one signal per pattern over a threshold (12 group rules plus 4 per-key overrides, tuned by hand with dated comments), 5 a pass; plus the retro signal every pass. Closed by the lead closing the Issue; nothing checks the count afterwards.
- Yield: 21 Issues in 7 days, all done, none noise; 30 days: 26 Issues, 3 cancelled, 1 dropped. The yield is real in kind (stall, regression, unreviewed ship) but inflated by daily refiling of the same pattern (see Q1) and capped by the unreachable refusal rule.
- Verdict: fix (key normalisation, cooldown by key, weekly retro guard, a before figure). Keep.

### hygiene (domains/loops/hygiene*.ts 1.4k, app/loops/hygiene.ts 587, adapters/hygiene 4319, catalogue 291, docs/hygiene.md 266)
- Measures the project's health with 16 probes plus one model judgment; files up to 5 signals per project pass (3 probe, 2 judgment). Has the best closure in the system: the lifecycle heals an unstarted Issue when the probe goes green, notes a working lead, reopens a closed-done Issue when the probe is red again (twice), then marks `kept` for a person.
- Yield: 219 signals to 212 Issues in 7 days; 274 to 268 in 30 days (done 244, dropped 13, cancelled 8). 30-day classes (data-finding-classes): judgment:stale 52, deps 37, deadcode 34, project 25, stale 21, check 18, context 17, readme 14, cochange 11, advisories 10, links 8.
- Is it paying? The lifecycle proves some do not hold: the sample project (data-hygiene-software-factory.json) shows issue_2036 (check), issue_2046 (deadcode:exports), issue_2311 (deadcode:files) and issue_2045 (advisories) reopened after closing done, and `retired:docs/architecture.md` (issue_1386) closed done, found red again after 2 reopens and recorded `kept` in four consecutive passes (a "kept" row is appended to the pass record every 15 minutes tick of that repo for ever, no new information).
- Busywork as one Issue per finding: yes. In 2 days (signals 11-18 to 11-19): "leftover worktrees" 7 Issues in 7 repos, "root AGENTS.md over its byte budget" 4, "unused files/exports/dependencies" about 4 repos each, "stale document <path>" 9. judgment:stale is 52 Issues in 30 days, one per document, with no lifecycle (`planLifecycle` skips every `judgment:` key, hygiene-lifecycle.ts:92), so a fixed document is never confirmed. These are batchable per repo per pass.
- Seat: the Issues start on the light seat; of 22 deadcode light starts 10 moved up (45 %), context 4/17, stale 4/21, project 3/24, readme 3/14 (data-finding-classes). That is a lot of lead work for a probe that "proves its own fix".
- Verdict: keep, but cut (see Q4) and batch.

### selfwatch (domains/loops/selfwatch.ts 494, selfwatch-model 203, overload 415, app/loops/selfwatch.ts 407, adapters/selfwatch 393)
- Fourteen conditions of the factory's own health. A row per subject: filed once, same evidence files nothing, changed evidence files again, cleared when the condition goes away. Files on `agent:<repo>`.
- Yield: 48 signals to 39 Issues in 30 days; 5 dropped. Top: migration_clash 14 (3 noise), lead_idle 11 (0 noise), process_growth 6, budget_breach 4+ (1 noise), swap_growth, routes_slow (rest unknown: the yield read shows only the top three; unverified).
- Defects: (a) selfwatch is not on the class gate (`readGate` is only called by friction and hygiene, rg), so the noisy ones (migration_clash 25 percent, swap_growth) never go on probation; (b) the CI ledger rides on this loop's tick (main.ts:658-690): it is not a self-watch condition but a data ingest. It follows every repo with an Issue event in 14 days (adapters/postgres/loop-store.ts:393-398), which includes scratch repos and work repos. Of 22 repos, 15 fail every 5-minute pass (data-loops.json): 3 work repos github 404, 7 "not a directory inside the allowed roots" (basalt-ui-plan-tune, factory-trial-scratch x3, homelab-w7, plan-scratch-153, and one with no github origin), 5 github 403 (shutterflow, software-factory, usage-tracker, vps, weatherorb; cause unverified: token scope or rate limit; software-factory itself is one of them). 288 passes a day for each is pure retry noise and the summary line is ~1.4 KB of permanent error text; (c) `lead_idle`, `wait_overdue`, `inert_regression`, `heartbeat_stale` watch whether the steward or a loop did its job (app/loops/selfwatch.ts imports `countLiveWork`, `loadIdle` from steward.ts); if the steward's rules work these Issues are the factory filing work about its own steward; (d) the `routes_slow` and `swap_growth` rules false-positive (issue_2491).
- Verdict: fix (class gate, ledger out, a repo list from projects); keep the capacity conditions; measure the steward-watching four before keeping them.

### throughput (domains/loops/throughput.ts 606, app/loops/throughput.ts 348, throughput_findings)
- Once a day ranks costs of 7 days, files one improvement per project with a measured before, target, and reads the figure again 3 days after the ship (`readLedger`, throughput.ts:407): status moved, flat, worse, dropped or unmeasured; a flat or worse subject is ranked again with the old row named; a dropped subject is held 14 days; one open improvement per project.
- This is the only loop with a real closed loop on the figure. Yield: 25 Issues in 30 days, 19 done, 6 dropped, 17 are queued_minutes (6 dropped = 35 % noise, the highest of any class; the claim and lane waits are a repo's own `leads` cap, which the owner's rule "resource is the only limit" says gets lifted). The moved/flat/worse split is in `throughput_findings` and was not in the snapshots: unverified, and it is the first figure to read.
- Verdict: keep, and make it the model for friction. Put it on the class gate or let it keep its own 14-day hold, but not both.

### fix-classes (domains/loops/fix-classes.ts 138, app/loops/fix-classes.ts 136, adapters/hygiene/fix-commits.ts, read/fix-commits.ts, migration 0997)
- Sorts fix commits into 9 classes (rules first, a model workflow for the rest in batches of 40 every 6 h). It files nothing. The consumers are the `fix_commits` KPI (data-kpis: value 1171, target kind trend, min and max null) and the Console Improve screen. Nothing in the loops reads the classes to decide anything (rg). Verdict: stop the model calls, or keep the rule-only classes; it is a display loop, not a loop that improves anything.

### digest (domains/loops/digest.ts 183, app/loops/digest.ts 84)
- Every 3 h, one agw model call per project whose Issues changed. Consumer is the Console digest strip and project-index (rg). Not a self-improvement loop. Verdict: keep only if the owner reads it; unverified. Cheapest change: call only for projects with an Issue closed in the last day.

### retro (domains/loops/retro.ts 60, read/retro*.ts ~430, docs)
- The retro signal text is a 12 KB brief (parts 0 to 4, subagents per sample group, CI reads for three repos, taste mining). It is filed per friction pass, so daily (Q1). Its ledger (read/retro.ts:164 `ledgerOf`) greps signal text for `Retro: date kpi= before= direction=` and compares to the KPI now, partial or after. It is the second of three before/after mechanisms.
- Verdict: fix the cadence (weekly); keep the ledger, but let friction and hygiene write the same marker or the same row instead of a third system.

### reaper, stall, steward (domains/loops/reaper 135, stall 450, app/loops/steward 947)
- Operational loops (kill leaked processes; end stalls). Not feedback loops: no finding is filed. Keep. Only relation: selfwatch watches the steward (above).

## Q4. Hygiene probes

Catalogue (hygiene-catalogue.ts) against 30-day yield (Issues, noise, light starts that moved up) and the probe's size in adapters/hygiene/probes:

| Probe | lines | Issues 30d | noise | note |
|-|-|-|-|-|
| deps (+fold, upgrades.ts 155, dependency-refresh.ts 218) | 707 | 37 | 1 | largest probe; scripted fix covers only bun patch/minor of the root package.json |
| advisories | 294 | 10 (class) | 1 | folded into `deps` by NL43; the class is probably historical; unverified date of last filing |
| deadcode | 145 | 34 | 0 | reopened repeatedly (issue_2046, 2311); 10 of 22 light starts moved up |
| judgment (model) | n/a | 55 | 0 | one Issue per document, no lifecycle |
| project | 24 | 25 | 0 | same lint as `factory project check` |
| stale | 181 | 21 | 0 | scripted fix exists, 1 recorded attempt in the sample: failed on a dirty worktree |
| check | 62 | 18 | 1 | `make check` once a week per project, up to 2x on red |
| context | 116 | 17 | 0 | |
| readme | 311 | 14 | 0 | plus an opt-in `make docs-check` variant |
| cochange | 120 | 11 | 10 | held (until 2026-11-22), then probation retries one Issue per 14 days |
| links | 79 | 8 | 1 | |
| retired | 43 | 4 | 0 | wraps the repo's own scripts/retired-words.ts |
| agentsmd | 128 | 3 | 2 | held |
| runrules | 324 | 3 | 0 | |
| browser | 140 | 2 | 0 | |
| ci | 210 | 2 | 0 | |

- Which found something real: deps, deadcode, stale, project, check, context, readme (each 14 to 37 Issues, near zero noise). "Real" is the lead's closing outcome; nothing here measures benefit.
- Which duplicate the repo's own gate: `check` (the repo's `make check` on its default branch; CI, merge-guard and selfwatch `ci_red` already watch master's CI; the probe runs `make` directly with no test slot, probes/check.ts:36-38; the slot wrapper in adapters/hygiene/git.ts:29 is for scripted fixes only; the check run for software-factory took 1358 s in the sample); `retired` (the repo's own script); `project` (the same lint `factory project check` runs; the project file is consumed by the server on sync); `readme make docs-check` (opt-in, runs the repo's own check).
- Probes that rarely or never fire but cost code: browser (2 Issues in 30 days, 140 lines), ci (2, 210), runrules (3, 324), agentsmd (3, 128, held), cochange (11 with 10 noise, 120, held). Together 40 Issues and about 920 lines; 13 of those Issues were noise. Per-probe-run hit counts (how often a probe ran clean) are in `hygiene_passes.report.runs`; not read here, so "never fire" is unverified for any probe except cochange.
- Auto-fix path (adapters/hygiene/fixes/ 725 lines: deps 222, landing 331, stale 102, index 70; domains/loops/hygiene-fixes.ts 69; FACTORY_HYGIENE_FIX default on, app/loops/settings.ts:235): two probes only (stale, deps), 2 days old (NL44 and NL46 of 2026-11-18). The only recorded attempt in the snapshot is a failed stale fix. Whether it reduced Issues cannot be judged yet: stale Issues in the last 2 days are still filed ("leftover worktrees" x7). Keep for now, measure (below).

## Q5. Mechanisms that tune how findings are filed

Counted: (1) the 5-signal budget and the 3+2 probe/judgment split (budget.ts, hygiene.ts), (2) friction thresholds plus overrides plus retired patterns plus MIN_CLOSED, (3) the class gate (noise over the last 10, hold 14 days, probation), (4) the throughput hold (one open per project, dropped 14 days, moved-while-window), (5) the hygiene lifecycle (suppress, reopen, kept), (6) the selfwatch row (evidence hash), (7) the per-class light-seat judge (`judgeClassSeat`, light-gate.ts 227 lines; read/finding-seats.ts 72; app/leads.ts wiring; the bound from `classMoveUpBound`), (8) intake's fingerprint window, matchOpen and triage, (9) per-project hygiene opt-outs (`skip`, `check:false`, `idleAfterDays`, deps thresholds).

- The seat judge is the least earning. It needs a bound of 0.942 (finding-classes bound) and fires only when more than 94 percent of a class's light starts moved up: the one class "out" is `advisories` with 4 of 4 starts, and that probe was folded into `deps` (NL43), so the class likely never files again. No other class is out (all `out:false`). That is a 300-line mechanism with one effect, on a dead class.
- The class gate fired for 2 of 24 classes (cochange, agentsmd), after 10 and 2 noise Issues respectively, because the verdict needs 3 decided Issues and it is judged on closed Issues (a flood of 5 per pass per project can all be filed before the first closes: cochange filed 11).
- Could one replace three? Yes: a single `loop_findings` verdict per (loop, key) with: open Issue exists (suppress), cooldown after dropped/cancelled (14 days), reopen after done (twice), plus the class noise share across keys. That folds hygiene lifecycle suppress, throughput heldSubjects/holdsProject and the friction cooldown that does not exist, and puts selfwatch on the same gate. Today four tables answer "which Issue did this loop's finding open": `loop_findings`, `selfwatch_findings` (via the signal), `throughput_findings`, plus the retro marker regex; `read/loop-yield.ts` and `read/retro-outcomes.ts` carry a UNION or NOT EXISTS across them (loop-yield.ts:75-90, retro-outcomes.ts:32-34).

## Q6. Is there a closed loop?

Partly, and only where it was built case by case:
- Throughput: yes, measured (before, target, after at 3 days, moved/flat/worse, a flat one is re-ranked with the previous row named).
- Retro recommendations: yes through the marker ledger (kpi, before, now, moved), but only for signals the retro lead writes with the marker.
- Hygiene: yes, the probe is the proof (heal, reopen, kept).
- Friction: no. The signal text carries `Count: N (rate)` (domains/loops/friction.ts:signalText) but nothing stores it as a figure, and the next pass does not compare. A pattern re-files from the same rolling window even after the cause shipped.
- Selfwatch: no. A subject clears when the condition goes; whether the Issue caused that is not recorded. The row has no link to the Issue (only a signal id).
- Loop-yield itself: reports outcomes (done/dropped), which is a throughput-of-Issues measure, not an effect measure.
- The decisions file ("Count over the next week", NL44, NL46) names the check by hand; nothing automatic runs it.

Cheapest check: store the figure at filing in `loop_findings` (add `figure` and `unit`; `gate.record` already gets the key; friction has `pattern.count/perIssue`, hygiene has `finding.count`, selfwatch could store the condition's number), and in the pass that next sees the key put one line into the new signal ("last time: issue_N, shipped D, count 12 now 11 (not moved)"). That reuses `reopenedFrom` from throughput.ts:448. It sits in app/loops/gate.ts (`record`) and the three loop passes.

## Findings, ranked by (simplification gained / risk)

### 1. Normalise friction keys before grouping; make the refusal rule reachable
- What is there: Q2 (read/friction.ts:119-132, domains/loops/friction.ts:42-47, friction-evidence.ts:55-75). 72 of 90 ship keys embed a SHA; 7 keys appear 2 to 4 times after truncation.
- Why accidental: a rule that cannot fire plus fragmented counts; the most frequent friction (101 refused ships a week) is invisible.
- Change: one `reasonKey()` helper in read/words.ts used by both read/friction.ts and read/friction-evidence.ts: SHAs to `<sha>`, digits to `N`, truncate, then merge equal keys by summing. Change the refusal rule to a count-led rule (for example 10 and 0.02) or divide by ships attempted.
- Must not change: key format of other groups, `:total` aggregates, the retired pattern, the FrictionModel contract shape.
- Risk low, size S.

### 2. Friction: cooldown by key after a close; retro once a week
- What is there: daily pass (domains/loops/friction.ts:7), 7-day window (:4), 24 h fingerprint window (app/intake.ts:107); issue_2339 then issue_2474; retros 2341 and 2475.
- Change: `gate.allows(key)` (app/loops/gate.ts) also refuses a key whose newest Issue closed less than WINDOW days ago (read from `loop_findings` plus the Issue's closed time; `classIssues` already carries closedAt), or counts events only after that close. In app/loops/friction.ts call `fileRetro` only when no retro signal exists in the last 6 days (the `retroOutcomes` read already counts them). Fix the doc line (guide/loops.md:178).
- Must not change: pass cadence of the counts, class gate, evidence lines, the retro signal text.
- Risk low, size S.

### 3. Loops stop going through human-text dedup (matchOpen, triage model, fingerprint)
- What is there: Q1. All four loops call `intake.api.file(body, 'agent')` (main.ts:576, 600, 653, 713); each signal can cost an `amendOrNew` model call (about 300 signals a week) and 4 wrong folds were seen in 200 signals. Hygiene already decides newness itself with `planLifecycle`; friction and selfwatch with a row.
- Change: add an optional `findingKey` to the signal body (or a separate `intake.fileFinding`) that the loops set; `receive` skips `matchOpen`/`askTriage`, files under a deterministic key (`keyOf('filed','finding',key)`) and records the `loop_findings` row inside intake's transaction (this also fixes the amended-leaves-no-memory hole for them). Mark loop signals with a source such as `loop:hygiene` so lead-filed and loop-filed signals are distinguishable.
- Must not change: the trust model (`agent` ceiling), work-repo gating, fences on text, the 24 h amend of a repeated human signal, the loop guard.
- Risk medium (intake is the owner's front door, change the loop callers, not the human path), size M.

### 4. CI ledger: out of selfwatch's tick; only real projects; no retry of permanent failures
- What is there: main.ts:658-690, adapters/postgres/loop-store.ts:393-398, 15 of 22 repos fail every 5 minutes (data-loops.json).
- Change: `ciLedgerRepos` reads projects (source file, not work, with a github origin) instead of "any repo with an Issue event"; a repo that answered 404/not a directory/no origin is skipped for 24 h; give the ledger its own loop entry (or run it in throughput's pass) so selfwatch's summary is only selfwatch. Investigate the 403s on software-factory, shutterflow, usage-tracker, vps, weatherorb (token scope or rate limit; unverified).
- Must not change: runs stored per repo, pruning at 30 days, `always: [SELFWATCH_REPO]`.
- Risk low, size S.

### 5. Delete detectors that duplicate another detector
- Stop the hygiene `check` probe where the project has CI (`checks.ci: true`), keep it for projects without; stop the selfwatch `routes_slow` Kuma overlap by routing the Kuma push monitor "factory routes slow" nowhere or dropping the selfwatch condition (issue_2313, 2353, 2377 for one fact). Remove `retired` and `project` probes if the repo's own `make check` runs the same scripts (`scripts/retired-words.ts`, `factory project check`; verify per repo first).
- Evidence: Q1 duplicates, Q4 table. `check` is the only probe that runs a repo's whole gate with no test slot (probes/check.ts:36).
- Must not change: master-red noticing by at least one mechanism, the owner's alert path.
- Risk medium (which of the overlapping watchers to keep is the owner's call: the current evidence does not say which one catches reds first), size S.

### 6. One table for "which Issue did a loop's finding open" (selfwatch and throughput join loop_findings)
- What is there: loop-yield.ts:75-90 UNION of three tables; retro-outcomes.ts:32 excludes throughput; read/retro.ts:164 LEFT JOIN throughput; selfwatch rows without the Issue.
- Change: `gate.record` is called by selfwatch and throughput as well (it takes issue, loop, repo, class, key); loops `friction|hygiene|selfwatch|throughput` in `FindingLoop`; loop-yield and retro-outcomes read only `loop_findings`; selfwatch and throughput keep their own state tables but lose the attribution role. Add the figure column here (Q6).
- Must not change: throughput_findings' ledger columns, `read loop-yield` output shape, class verdict rules for friction and hygiene.
- Risk medium, size M.

### 7. Batch hygiene findings per repo per pass
- What is there: 7 "leftover worktrees" Issues in 7 repos in two days; "stale document" 9; judgment:stale 52 Issues in 30 days; 212 hygiene Issues a week, each an Issue with its own lead start, test slot, CI and merge window (NL44's own cost analysis).
- Change: one Issue per repo and probe family per pass (all `judgment:stale` findings of one pass in one signal; the same for `links:` and `readme:`), keys kept for the lifecycle; give judgment keys a lifecycle too (re-judge a closed one only if the document changed after the close).
- Must not change: probe keys, the 3+2 budget semantics, the lifecycle's reopen/kept.
- Risk medium (the lead's brief per Issue changes), size M.

### 8. Remove the per-class light-seat judge and the cochange, browser, ci probes
- Evidence: Q5 (one class out, which is probably dead) and Q4 (cochange 10/10 noise and still on probation; browser 2 and ci 2 Issues in 30 days).
- Change: delete `judgeClassSeat`, `readClassSeats`/`readClassesOut` and the `classesOut` wiring in app/leads.ts and domains/leads/light.ts, `seat` from finding-classes (contract change, Console), keep the light-seat gate itself; delete the cochange probe (120 lines) from the catalogue and probes; browser and ci after reading `hygiene_passes.report.runs` to confirm they never go red (unverified).
- Must not change: the first-start seat rule for hygiene Issues, `read finding-classes` noise columns.
- Risk low to medium (contract and Console fields), size M.

### 9. Selfwatch onto the class gate; decide the four steward-watching conditions
- Change: `FindingLoop` includes selfwatch (see 6) so migration_clash (3 of 12 noise) and swap_growth can hold themselves; read the 11 `lead_idle` Issues' close reasons before deciding whether the steward should own it (the code coupling: app/loops/selfwatch.ts imports from steward.ts).
- Risk low, size S for the gate, the steward question is unverified.

### 10. Stop or reduce the display loops
- fix-classes (model calls every 6 h, 392 lines, one KPI with no target) and digest (model calls every 3 h per changed project). Neither files work; keep if the Console screens are used. Size S each.

### 11. Cosmetic: pass-record noise
- Hygiene appends a `kept` lifecycle row for `retired:docs/architecture.md` on every pass (4 in the sample), selfwatch's loop summary carries 15 error notes every 5 minutes. Only record a change. Size S.

## Verdict per loop and per dedup mechanism

Loops: friction FIX (keys, cooldown, figure) ; hygiene KEEP and cut (batch, drop 3 to 5 probes, stop the overlap) ; selfwatch FIX (gate, ledger out, steward-watchers measured) ; throughput KEEP (the model; put on the unified table) ; fix-classes STOP or rule-only ; digest KEEP if read ; retro FIX (weekly) ; reaper, stall, steward KEEP (operational).

Dedup: event/filed keys KEEP ; fingerprint 24 h KEEP, fix the amended-leaves-no-row hole and bypass for loops ; matchOpen token overlap KEEP for humans, bypass for loops ; triage model KEEP for humans and alerts, stop for loops ; subject/incident correlation KEEP ; intake_seen vs signal key MERGE candidate (two replay stores, unverified how often `seen` alone answers) ; class gate KEEP and extend to selfwatch and throughput ; hygiene lifecycle KEEP (extend to judgment keys) ; selfwatch rows KEEP, attribute via loop_findings ; throughput holds MERGE into the one verdict ; per-class seat judge STOP ; retro marker regex MERGE into loop_findings figure.

## What to measure in two weeks to know whether each loop pays

Write these as one weekly query set (all from tables that exist):
1. Per loop and key: Issues filed per week, share closed done, and for those the number at filing versus now (needs the figure column from finding 6). A loop pays when the number it files against moves for at least half of its done Issues.
2. Friction: distinct Issues per key per week (target at most 1 per key per window), ship refusals per 100 closed Issues (the SHA family as one key), retro Issues per week (1).
3. Hygiene: Issues per week per repo (target under the 11 percent of NL44), reopen rate per key (reopened/done), `kept` rows, light moved-up share per class, fixes outcomes (`hygiene_passes.fixes` fixed/failed/deferred; the NL44 question: stale and deps Issues filed against fixes fixed).
4. Selfwatch: noise share per kind, Issues whose close reason says the loop was wrong (issue_2491 style), CI ledger repos read versus followed.
5. Throughput: `throughput_findings` status counts (moved, flat, worse, unmeasured, dropped) after the 3-day windows.
6. Dedup: signals folded into an Issue with a different class key (mis-folds), count of agw `amendOrNew` calls per week, and of Issues filed twice for one key within 7 days.
7. Cost: lead-hours and test-slot minutes spent on loop-filed Issues per week against the share of all Issues (18 percent now).

## Could not check
- The live DB: per-probe run counts, hygiene fixes outcomes, throughput_findings status split, which selfwatch kinds beyond the top three, the cause of the GitHub 403s, how often `intake_seen` alone answers a replay, whether hygiene classes' Issues were useful beyond closing done, how many agw `amendOrNew` calls hygiene produced (inferred from the code path, not counted). `factory read retro` hung for 60 s and was abandoned.
