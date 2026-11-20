# Documentation audit: software-factory (2026-11-20)

Scope: README.md, AGENTS.md, REVIEW.md, docs/*.md, docs/guide, docs/plan.yaml, the archive-like folders, integrations/README.md, the three docs scripts. Read-only; no check was run. Everything marked "unverified" I did not confirm.

## 0. The short version

1. The documentation is a **change log that grew a reference on top of it**. architecture.md (201,418 bytes, 953 lines) was edited by 135 of its 235 commits in the last 6 days (`git log --since=2026-11-14`), and 79 % of it (160 KB) sits in four sections written as "what happened, in which Issue" (Capacity and leads with Steps off the mini 54.5 KB, Checkpoints 40.8 KB, Loops and agw 38.3 KB, Data 26.3 KB). The code docblocks already restate the rules (compare architecture.md:207-227 with the docblock of `decideIdle`, `apps/server/src/domains/loops/stall.ts:300-307`).
2. The **guide is the better teaching document and the README does not use it**. The guide has a worked Issue (`docs/guide/issues.md:208` "issue_1809, end to end"), a claim per chapter, a diagram, a code excerpt and pinned links. The README has none of those and spends its first 44 lines (30-73) on 9 screenshots of the owner's UI before it says how the loop works (line 74).
3. **Three whole areas are history, not reference**: docs/evidence (41 MB, 601 files, 33.9 MB of it Console design-round screenshots), docs/strategy (2.1 MB of HTML), docs/waves + docs/rewrite + docs/rewrite.md + docs/program.md (about 0.8 MB). docs/plan.yaml is 92 KB and 70 of its 71 rows are `done` (`factory project show software-factory`, plan.rows).
4. The two docs the owner's complaint is about (README, guide start page) **duplicate each other** (Position, the loop list) and **neither states a result with numbers at the top**; the only numbers are in guide/README.md:13-20, dated 2026-11-17, and the README has none.
5. AGENTS.md is at 11,997 of 12,000 bytes. About 2.9 KB of it is the Console listener, the trust boundary, the CLI contract and the hook rules, which REVIEW.md restates a second time.

---

## 1. Map of the documents

Size in bytes, last change by `git log -1 --format=%cs`. "Restates" is my judgement from the topic counts below.

| Doc | Job | Reader | Size | Last change | Restates others |
|-|-|-|-|-|-|
| README.md | front page: position, screenshots, loop, vocabulary table, patterns table, layout, run | human, first visit | 17,466 | 2026-11-20 | high: loop list = guide/README; Position = product.md + guide/README; language table = language.md; domain table = architecture.md Layout; "Run it" = guide/running.md |
| AGENTS.md | invariants an agent must keep | agent | 11,997 (cap 12,000) | 2026-11-19 | medium: REVIEW.md restates 8 of its rules |
| REVIEW.md | what a reviewer treats as failure | reviewer agent | 3,756 | 2026-11-11 | high (all 8 bullets are AGENTS.md rules plus file lists) |
| docs/product.md | position, principles, KPI table | human + agent | 17,605 | 2026-11-19 | Position and 8 principles = README + guide/README; 13 KB is the generated KPI table |
| docs/language.md | the words (127 table rows with "Retires") | both | 39,301 | 2026-11-19 | README "The language" is a 12-row copy; "Events" section (4.4 KB) overlaps architecture |
| docs/architecture.md | what is built where | agent | 201,418 | 2026-11-20 | everything; see section 4 |
| docs/decisions.md | why (67 numbered decisions, NL/RS) | agent | 77,626 | 2026-11-19 | 56 KB is one section ("The next level") |
| docs/operations.md | listener, CLI, check tiers, merging, deploy | agent | 13,021 | 2026-11-19 | Console listener restated in AGENTS.md, README, architecture.md |
| docs/accounts.md | design of packages/accounts (picker, quota, policy lab) | package maintainer | 54,532 | 2026-11-19 | none; is a package doc |
| docs/project.md | project.yaml author page | agent filing a repo | 26,914 | 2026-11-19 | 16.8 KB is a generated key table (project.md:126-215) |
| docs/plan.md | plan file format | agent | 23,486 | 2026-11-18 | printed by `factory plan schema` (same file) |
| docs/hygiene.md | probes, generated from the catalogue | agent | 17,845 | 2026-11-19 | generated, fine |
| docs/program.md | "what is open, who runs it" | agent | 6,596 | 2026-11-18 (content dated 2026-11-08) | stale, see section 2 |
| docs/rewrite.md | the rewrite and cutover protocol | agent | 7,321 | 2026-11-17 | finished project |
| docs/guide/*.md (README + 10 chapters) | the published teaching guide | human | 162,783 total; README 4,652; chapters 12-18 KB | 2026-11-19 (README 2026-11-17) | high with architecture.md per chapter |
| docs/plan.yaml | the factory's own plan, 71 rows | the planning loop | 92,097 | 2026-11-19 | n/a; 70/71 done |
| integrations/README.md | client pieces table | agent | 2,226 | 2026-11-17 | none |
| docs/evidence/ | evidence dumps of finished Issues | nobody | 41 MB, 601 files | 2026-11-19 | n/a |
| docs/strategy/ | owner definition/report HTML | nobody | 2.1 MB, 11 files | 2026-11-08 | cited by product.md, decisions.md |
| docs/waves/, docs/rewrite/ | wave and rewrite logs | nobody | 364 KB / 400 KB | 2026-11-08 / 2026-11-15 | n/a |
| docs/research, spikes, design | one-off research | nobody | 124 KB / 20 KB / 8 KB | 2026-11-14 / 10-30 / 11-17 | n/a |
| docs/demo, docs/brand | README screenshots, brand assets | README | 1.1 MB / 432 KB | 2026-11-17 / 11-20 | n/a |

### Overlap matrix by topic

Cells are line-hit counts of a topic's keywords (rg -c over the file; architecture.md lines are 200-1100 characters long, so its counts under-state it). "full" = the doc teaches the topic, "sum" = a summary, "-" = absent. This is a measure of where a topic is stated, not of quality.

| Topic | README | AGENTS | product | language | architecture | decisions | guide/README | guide chapters |
|-|-|-|-|-|-|-|-|-|
| the loop (signal to closed) | sum (list, 1 hit + diagram) | 1 | 0 (principles only) | 3 | 3 | 0 | sum (8-step list) | 7 (signals, issues, leads) |
| the state machine | sum (3) | 0 | 0 | 0 (diagram at 234-278) | 2 | 1 | 2 | full, 7 (issues.md) |
| capacity | 2 | 1 | 3 | 8 | full, 29 | 12 | 1 | full, 22 (capacity.md) |
| checkpoints | 11 | 0 | 13 | 39 | full, 121 | 8 | 2 | full, 62 |
| gates | 3 | 2 | 4 | 7 | 33 | 25 | 7 | full, 35 |
| loops | 2 | 3 | 4 | 14 | full, 38 | 31 | 2 | full, 47 |
| layers / ports | 17 | 8 | 3 | 6 | full, 91 | 23 | 0 | 187 (every chapter points at files) |
| perimeter (tokens, loopback, spool) | 7 | 8 | 1 | 5 | 39 | 11 | 1 | 31 |

Findings from it: the loop, Position and the 8 principles are each stated in 3 places (README, product.md, guide/README) in near-identical words (README:21-28 vs product.md:8-14 vs guide/README.md:7-9). Checkpoints, loops and capacity are each taught twice at full length (architecture.md + a guide chapter). Only the README is held against the code (`scripts/readme-check.ts`: event kinds, callers, tokens, screens, domains, states, port, writes); the Console's "fifteen write verbs" appears in README (2 lines), AGENTS.md (1), operations.md (2), architecture.md (3), guide/capacity.md, guide/signals.md (2), guide/running.md and only the README copy is checked (rg -c 'fifteen|15 write|WRITES').

---

## 2. Staleness (calendar or code has passed it)

Today is 2026-11-20.

docs/program.md (6,596 bytes), still the answer AGENTS.md gives for "current state":
- AGENTS.md line 4-5: "Live on the mini since 2026-11-08; `docs/program.md` is the current state." and "What is open: `docs/program.md` and `docs/plan.yaml`" (Where to look). The file is not the current state.
- program.md:3 "went live on 2026-11-08"; :23 "What is left, as of 2026-11-08"; :25-27 "After the cutover ... burn-in reports on day 3 and day 7": both rows are done (`burn-in-day-3` done issue_756, `burn-in-day-7` done issue_1384, `docs/guide/chains.md:77-78`); :29 "Time-gated, track U: judge ... Wave 6 on the W46 report (2026-11-16)": date passed; :32-40 the Tracks table (usage-tracker, dotfiles, hermes-agent, email-gateway, argo, iris, finances) lists other repos' work, which AGENTS.md's "dependencies point one way" and the public-repo rule argue against in a reference repo; :43-end "Track notes" (R0/R1/A1/U/A2/IR) are open items of other repos (e.g. "the Hermes API to loopback", "the Kuma push monitor ... is the owner's to pause").
- program.md:11-12 says "docs/waves/reset.md for the reset's rows and docs/rewrite/state.md for the rewrite's log. This file holds no row state of its own" and then holds a table of track status.

docs/rewrite.md (7,321) is a finished protocol in the present tense:
- :5 "The orchestrator reads this file first after every start or compaction"; :17 "alive for the whole rewrite"; :66 "Burn-in after the cutover: the orchestrator stays on ... On day 3 and day 7"; :71 "After the cutover: The factory builds the rest through docs/plan.yaml". The cutover was 2026-11-08, the way back was removed 2026-11-15 (rewrite.md:60 itself says so in an italic note, commit 55bcf5de).
- Its only live inbound references are decisions.md, plan.yaml comments (plan.yaml:35 and :217 "docs/rewrite.md 'After the cutover'") and architecture.md:5.

docs/plan.yaml:
- Rows done: 70 of 71 (only `subs-cleanup-dotfiles` is `waiting`). Row comment :35 "After the cutover (docs/rewrite.md ...) The new core runs on master from 2026-11-08". The header (:1-8) tells the story of "Console v0 went to him too thin ... 2026-11-08".
- docs-new-core row says "AGENTS.md and docs/design.md still describe the old core"; the row is done and docs/design.md no longer exists (docs/design/ holds one file, improve.md). waves/reset.md:122 and archive briefs still cite docs/design.md.

Other dated or passed statements:
- docs/guide/README.md:13-20: the only result numbers anywhere ("Issues filed 1,249, closed 1,246, ... 76 avoidable touches", read 2026-11-17, 3 days old, window of 7 days).
- docs/guide/capacity.md quotes `REFUSALS` with 10 entries; the code has 11, `disk` between `memory` and `tests` (`apps/server/src/domains/capacity/admission.ts:26-38`). The guide's 198 permalinks all pin one commit (2511836a, 2026-11-17) which is 147 commits behind HEAD; `git diff --stat 2511836a..HEAD -- apps/server/src/domains` shows 70 files, +2205/-1072. `scripts/guide-links.ts` checks that the lines exist at that sha, not that the text still describes the code.
- docs/language.md:3-4 "A word in a Retires cell fails make check once the rewrite lands" (it landed 2026-11-08); "Built on ... signed 2026-11-07".
- docs/product.md:4 "Signed by the owner on 2026-11-07 ... decisions NL1 to NL21"; decisions.md numbers go to NL32 (docs/language.md Claim row cites NL32; apps/server/src/... cites NL32 in project-file.ts). The "How we know it works" table also contains "the signed doc said at least 80%; raised to 90%" in a "Where the target comes from" column: a change log cell.
- docs/decisions.md:1 title "Decisions: the re-plan of 2026-10-30"; the intro and the first 8 sections (1-148, about 21 KB) describe the fleet layer, Argo, Usage v2, iris and Hermes, "since retired by RS1". decisions.md:149 onward is 56,488 bytes (73 %).
- docs/architecture.md:4-5 "since the cutover of 2026-11-08 (docs/rewrite/state.md is the log of how it got here)"; :893 the legacy-schema import ("docs/rewrite/cutover-runbook.md"). `scripts/import.sh` and `apps/server/scripts/import-legacy.ts` still exist and cite the runbook (unverified whether anything still runs them; it is outside my area but it is the code side of the same history).
- The words "burn-in" (decisions.md 3, program.md 1, guide/chains.md 9) and "cutover" (architecture 3, decisions 5, program 2, plan.md 1, guide/checkpoints 1) are used as if the period is ongoing.
- docs/spikes/2026-10-30-effect: the Effect spike was decided against (NL11). docs/research has 6 files from 2026-10-30 to 2026-11-14.

---

## 3. What does not belong in the reading path of a public reference repo

`git` keeps everything; moving only changes what a visitor and an agent read and grep. Evidence: `git count-objects -vH` size-pack 61.63 MiB; docs/evidence is 41 MB on disk so most of a clone is screenshots.

| Path | Size / files | What it is | Referenced from | Proposal |
|-|-|-|-|-|
| docs/evidence/console-* (14 dirs) | about 33.9 MB, 282 PNG overall | design-round screenshots per Console screen and round | scripts/evidence-console-needs-you.sh writes into it; tests/e2e/since-band.e2e.ts:374 comment; REVIEW.md "none" glob | delete (history keeps). Keep nothing: tests/e2e produces the demo shots |
| docs/evidence/golden | about 8.6 MB incl. a 1.69 MB packets.jsonl | triage golden set | docs/strategy/2026-11-reset/design-v3.* only (rg), docs/program.md:41 says "docs/evidence/ keeps the golden set and KPIs" | if code does not read it (unverified, rg found no code reader), move to a test fixture dir or delete |
| docs/evidence/{kpi,chain-at-scale,interventions,subs-console,signals,f1-*,f2-gate,gamedays,...} | about 6 MB | one-off measurements and gameday runs | scripts/gameday/lib.sh:10 writes `docs/evidence/gamedays` | delete except `scripts/gameday` output convention; point lib.sh to a gitignored dir |
| docs/strategy/ | 2.1 MB, 11 files (two 700 KB archify HTML, two 300 KB definition/report HTML) | the owner's 2026-11 definition and report | decisions.md (4 refs), product.md:4, guide/learnings.md, plan.yaml, packages/contract/src/kpi-catalog.ts (a target's source is a string pointing at definition.html) | move to docs/archive/strategy; keep the two path strings valid by updating them in the same PR |
| docs/waves/ | 364 KB, 57 files (all under archive/ but reset.md) | wave-era briefs and logs, "retired by RS1" | scripts/retired-words.allow, hygiene-model.ts, decisions.md | delete (history keeps); fix 4 references |
| docs/rewrite/ | 400 KB, 30 files (state.md 45 KB, cutover-runbook 19 KB, learnings 24 KB, briefs 92 KB, reports 200 KB) | the rewrite's working files | guide/learnings.md (3 permalinks), architecture.md:5,:893, scripts/import.sh, import-legacy.ts, plan.yaml | keep learnings.md (it is cited by the guide) as docs/archive/rewrite-learnings.md; delete the rest |
| docs/rewrite.md, docs/program.md | 7.3 KB, 6.6 KB | finished protocol, stale status | AGENTS.md (2 lines), plan.yaml comments, decisions.md, a hygiene probe test (`retired.ts`, `hygiene.test.ts`) | delete both; the plan is the status |
| docs/research/, docs/spikes/, docs/design/ | 124 KB, 20 KB, 8 KB | one-off research, a rejected spike | decisions.md, architecture.md, plan.yaml, REVIEW.md (glob) | keep research/2026-11-13-throughput-tooling.md and 2026-11-14-taskpolicy-steps.md only if architecture cites them (it does: rg), else move all to docs/archive |
| docs/plan.yaml rows already closed | 70 rows of 71; 92,097 bytes | a record of delivered work | the server reads the file; guide/chains.md pins lines 199-215 | prune done rows (or move to docs/archive/plan-done.yaml); the planning loop files a row once, and a pruned done row is a no-op only if no open row has `after:` pointing to it (the `after` of a missing key is a broken plan: unverified, check `factory plan check`); keep rows that are an `after` target until their dependants close |
| docs/accounts.md | 54,532 | design of a package that is "independent of the server" (README layout row) | packages/accounts source, Makefile, policy.ts | move to packages/accounts/docs/ (its README exists) so the root docs/ shows the factory only |
| docs/demo, docs/brand | 1.1 MB, 432 KB | needed | README | keep; docs/brand/AppIcon.icns 286 KB is a binary asset in docs: move to apps/console/ if brand.ts generates it (unverified) |

Reading-path total that disappears: evidence 41 MB + strategy 2.1 MB + waves 0.36 MB + rewrite 0.4 MB + research/spikes 0.15 MB, about 44 MB; hand-written markdown that disappears or is generated instead: about 100 KB.

---

## 4. architecture.md outlined to three levels (bytes)

Sizes are bytes of the text from a heading to the next heading of any level (my awk over docs/architecture.md). The file has no h3/h4 below `### Steps off the mini`; the real third level is the **bold lead-in of each list item** (a paragraph of 1-4 KB). That is why the lines are 800-1100 characters wide.

| Lines | Section | Bytes | Class |
|-|-|-|-|
| 1-8 | intro | 535 | reference |
| 9-30 | Layout | 1,863 | reference (README repeats it) |
| 31-64 | The server | 3,141 | reference |
| 65-84 | The Issue machine | 2,093 | reference; the best section: short, links code |
| 85-142 | Signals and triage | 7,491 | mixed |
| 143-412 | **Capacity and leads** | 46,406 | mostly change log |
| 413-488 | ... Steps off the mini | 8,050 | change log of Issue 1793 and 2271 |
| 489-521 | Quality | 6,103 | reference, slightly long |
| 522-776 | **Checkpoints** | 40,803 | mostly change log |
| 777-825 | **Loops and agw** | 38,296 | mixed |
| 826-876 | API, client, CLI | 8,576 | reference |
| 877-889 | Perimeter | 1,540 | reference (keep, small) |
| 890-916 | **Data** | 26,295 | 2/3 reference tables, 1/3 change log |
| 917-925 | Tests | 536 | reference |
| 926-937 | The Console | 1,611 | reference |
| 938-947 | The throughput loop | 7,643 | change log |
| 948-953 | Not built | 436 | reference |

Third level inside the four big ones (bold lead-ins, with line numbers): Capacity: Admission (145), What a lead is learned to take (158), the API-error turn (180), the quiet lead (207), annotation dispositions (228), a repeated stall (234), a hold (243), the claim deadlock (249), the timer wake (259), a long wait (262), a Replan (268), Start (286), Hooks (293), Quiescing (306), the stop rule (329), Finalize (333), Test slots (340), then Steps off the mini: Placement (421), the pressure line (430), why a step ran where it did (436), the probe (440), the run (443), Retention (458), Results (470), the hold (477). Checkpoints: A Spec passes a screen (545), A pull request's review is not the owner's hands (561), Turn back (572), the orchestrator's done (575), the desk pass (577), a request is an Errand (591), a done is not always done (608), what an Errand needs (614), Decided by rule (623), the one place the factory ran itself before 1714 (641), Auto-run (649), Approve (650), Repeats join (663), a command that fails twice ends (671), the recheck (680), a standalone artifact (702), a collection (704), the Spec checkpoint (727).

Symptoms that it is a log written as prose:
- 24 occurrences of "issue N"/"Issue N" and 16 ISO dates as provenance ("10 of 10 on 2026-11-13" at :193, "measured 2026-11-17: factory-steps 7.2 GB" at :458, "Issue 2393, this repo's Issue 2388" at :649, "The one place the factory ran itself before 1714" at :641).
- 89 distinct `FACTORY_*` names, 182 distinct `*.ts` file names, 158 number-plus-unit thresholds (`default 10 minutes`, `5 min`, `60 s`). These are settings and code facts that change with the code and are already in the code: the docblocks of `repeatedStall` (`apps/server/src/app/loops/steward.ts:135-139`) and `decideIdle` (`domains/loops/stall.ts:300-307`) say what architecture.md:207-241 says.
- Headings of the type "A done is not always done" and "The one place the factory ran itself before 1714" (:608, :641) are incident reports, not reference.
- The bold lead-in paragraphs have no order: "Hooks" (:293) sits inside Capacity and leads between Start and Quiescing; the API-error handling (:180-206, 2.2 KB) sits in "Capacity".

Proposed split (target: architecture.md at or below 45 KB, about 1/4 of today):
1. **Keep, trimmed to 3-5 KB each**: Layout, The server, The Issue machine, Signals and triage, Quality, API/client/CLI, Perimeter, Console, Tests, Not built (about 30 KB with their current sizes minus 3-4 KB).
2. **Rewrite Capacity, Checkpoints, Loops, Data as one 3-4 KB section each**: what the mechanism is, the invariant, the file names of the module that owns it, and a link to the guide chapter. Each rule that names a function and a threshold moves to that function's docblock (many already are: stall.ts, steward.ts). Target 14 KB for the four.
3. **Settings**: replace the 89 inline env names with one generated table from the env allow-list (`scripts/env-file.sh` has 15 FACTORY_ lines, so the list is incomplete; the code builds some names from a prefix, I could not reconcile 20+ names by grep: unverified). A new file `docs/settings.md` generated like hygiene.md, or the `--help` of the server. Then delete the inline defaults.
4. **Delete provenance**: "Issue 1190", "10 of 10 on 2026-11-13" and the like move to the Issue (the factory keeps it) or the commit; architecture.md says how it is, not how it became.
5. **Steps off the mini** (8 KB) and **The throughput loop** (7.6 KB): each one a docblock plus a 1 KB paragraph; they are Spec text that became docs.

Size S for the one-section proofs (Checkpoints alone: 40.8 KB to 4 KB, about 700 lines of changed text but one file), M for the four sections together.

---

## 5. The README against the reference (domain-driven-hexagon)

The reference README (20,715 characters of JSON-wrapped text in snapshot/ddh/readme.txt) works as a teaching document because of its structure:
- opens with a scope sentence and an honesty disclaimer ("everything below is a recommendation, not a rule"), then a **table of contents** with 40+ anchors;
- states **pros and cons** before teaching;
- one **diagram** and "in short, data flow looks like this" in 6 numbered steps;
- then every concept is its own section (Modules, Application Services, Commands and Queries, Ports, Entities, Aggregates, Domain Events, Value objects, Domain Invariants, ...), each with: the definition, the rule, a short why, "Code Examples:" links into the real source, and "Read more:" links.
- the same shape repeated 25-30 times, so the reader learns the form once.

software-factory README (281 lines, 17.5 KB) in the first two screens (about 60 lines):
- Lines 5-13: the sentence is good ("A closed loop that turns signals into verified production changes ..."). It states the claim but not the problem it solves, the result in numbers or why anyone would build one.
- No table of contents. Sections: Position 632 B, See it 2,730 B (9 screenshots, lines 30-73), How it works 2,962 B (line 74), The language 1,542 B, What it proves 1,673 B (a table), Architecture 3,126 B, Layout, Run it 1,914 B.
- The README states **no result with a number**. The only digits: the Console port, the token length, "24 kinds", "fifteen write verbs", "Eight domains". Results exist (guide/README.md:13-20: 1,249 Issues filed and 1,246 closed in 7 days, 5 Decisions the owner settled, 0.061 avoidable touches per Issue against a 0.07 target; guide/learnings.md: "369 ships landed unreviewed in 7 days", etc.) but sit in another file.
- Unexplained terms in the first 60 lines (needed before line 61 to follow the page): Issue (capital I, line 10), signals, lead (never defined before line 91), Claude Code subscriptions, probes, gates, watch window (line 23), the owner (who is the owner? line 5 says "one person"), Decision, Spec, Errand (line 35-36: the three checkpoint kinds, defined only at line 91 ff. and in language.md), Console, PWA, Needs you, Chain, Artifacts, Concepts, Reports, annotations, Projects tabs (Work, Plan, Shipped, Hygiene, Setup), friction (line 28), Warp, herdr-core (line 91). That is at least 20 factory words, 11 of them capitalised proper terms, before the README says what a lead or an Issue is.
- "Position" (19-28) is the claim "Dark for code, lit for decisions" with the justification (Warp quote) before the reader knows what the thing does.
- "What it proves" (159-176) is a table of 11 patterns: pattern | held by. This is the closest to the reference's content but it is a table, so each pattern gets one clause: no definition beyond the bold phrase, no "why", no code link (the "held by" column gives a file name, not a line), no further reading. Example: "Facts are stored, state is derived" is one row, while the reference gives Aggregates, Entities, Domain Events each a section.
- The domain model is not shown. The state machine is described in prose (README:201-207) and the diagram is linked to language.md:234-278; the 6 states are in a table cell (row "State") with the retired-word warning in the same cell. The 24 event kinds are named by 4 examples.
- The domain rules (the invariants the owner cares about: a lead cannot ship by saying so, a decision must have a recommendation, waiting is not an option for a Decision, only the owner's tokens may...) are not on the front page; they are in guide chapters (guide/checkpoints.md:11-14) and AGENTS.md.
- There is **no worked example**. guide/issues.md:208 ("issue_1809, end to end") and the table of its events exists. The README does not link it.
- The architecture diagram (README:103-135, a mermaid flowchart of Edge/Core/Adapters) is accurate but is the layering of the code, not of the idea; a reader needs the loop diagram first (guide/diagrams/loop.svg exists, 188 KB).
- The README duplicates: loop list = guide/README 8 steps; Position = guide/README 7-9 = product.md 8-14; Layout = architecture.md 9-30; Run it = guide/running.md 12-36.
- The mermaid diagram on GitHub renders; the guide SVGs are dual-theme. The README uses neither SVG nor an end-to-end diagram.

Why it fails the owner's bar, in one sentence: it describes the **product surface** (screens) and a **vocabulary table**, where the reference teaches the **design** one pattern at a time with the rule and the code.

---

## 6. The guide

Structure: README start page (4,652 B) then 10 chapters in the order signals, issues, leads, gates, capacity, chains, checkpoints, loops, learnings, running (`docs/guide/.vitepress/config.mts`, nav). Each chapter has about 6-8 `##` sections, 12-20 permalinks, code excerpts and a "Next:" link; the claim of each chapter is stated in the start page's table.

Does the order teach? Mostly yes: follow the life of an Issue (signal, triage, Issue machine, lead, gate, capacity, chain, checkpoint, loops). Two exceptions: **capacity before checkpoints but after gates** puts "when may a lead start" after "what the lead does at the end", and **Chains and Plans** (13.5 KB, 10 mentions of burn-in rows) is a feature chapter that needs the vocabulary of capacity, checkpoints and loops; **Learnings** (14.6 KB) is a different genre (incident log with 10 Issue references) and is the only chapter without a claim in the shape "X is Y".

What is good (keep, and link from the README): one running example (issue_1809 appears in signals.md:137, issues.md:208, leads.md, capacity.md:185, loops.md:105); real events with timestamps; the "claim" sentences; 5 SVG diagrams; every chapter ends with "Example files" permalinks.

Gaps:
- **No "concepts on one page" map.** The start page has the 8-step loop, a chapter table and "What this is not", but no page that shows the six nouns (Signal, Issue, Event, Lead, Checkpoint, Loop) and their relations, and the 6 states with the 24 events. The reader has to read issues.md (253 lines) to meet them. Only language.md (127 rows) holds the vocabulary and is not part of the guide (the chapters link it 13 times in total).
- The start page leads with Position and a 4-row KPI table (the strongest evidence in the repo) but the table is a dated snapshot (2026-11-17) typed by hand; it should be a generated number or be dated as such in its title.
- The README and the start page repeat each other's first two paragraphs; they should differ (README: what and why and how to read; guide: the story).
- Weakest chapter by the first 80 lines: **learnings.md** (a list of 8 sections about broken-then-fixed things; no model of the factory is taught) and **running.md** (12 KB; a setup list; its "Example files" link to README "Run it", which duplicates it). **chains.md** is third: it opens with a plan-file YAML excerpt rather than the idea.
- The permalinks (198 at one commit, 147 commits old) are the guide's main reliability risk: see section 2 (REFUSALS has 10 entries in the guide and 11 in code).

What the README should link rather than repeat: the loop diagram (guide/diagrams/loop.svg), "issue_1809, end to end" (guide/issues.md:208), the KPI table (guide/README.md:13-20 or generated from `factory read kpis`), each pattern's chapter, and the "Example files" lists.

---

## 7. AGENTS.md

124 lines, 11,997 bytes of a 12,000 byte cap (the cap is in rules/writing-for-agents.md, enforced by the hygiene probe `agentsmd` in apps/server/src/adapters/hygiene/probes/agentsmd.ts, unverified where the number is checked). Byte sizes of the bullets (awk): Public repo 508, models 227, deps 138, layers 386, facts 410, repo name 358, keys 222, port in tx 312, deploy locks 243, interactive 78, CLI contract 620, tooling 225, policy 465, trust boundary 587, Console listener 620, work repos 221, door 281, hooks 516, one process 197, one contract 222, one schema 356, settings 279, check 220, throughput epoch 209, heartbeat 239, state words 431, README counts 216, hygiene 188, Validate and ship 1,513, Where to look 1,008.

Every line is a rule, which is good. What a task does not need:
- **The Console listener (620 B)** and the **door (281 B)**: needed by whoever edits `api/console.ts` or `apps/door` only; restated in operations.md "The Console listener" and README. Replace by a header comment in `api/console.ts` (a test already fails on a new route without a policy row, per the policy bullet) and one pointer line.
- **The CLI contract (620 B)**: the exit-code and credential rules sit in operations.md "The CLI" (the bullet already says so). Keep two sentences ("generated from OpenAPI, never edited by hand; rd --role depends on role get printing exactly ...").
- **The throughput epoch (209 B), the heartbeat names (239 B), the README counts (216 B), hygiene probes (188 B), state words (431 B)**: each is enforced by a script whose failure message can carry the rule (`scripts/readme-check.ts`, `scripts/vocabulary.ts`, the catalogue test). An agent learns the rule when it trips it. About 1.1 KB.
- **The trust boundary (587 B) and hooks (516 B)**: duplicated in REVIEW.md bullets 4 and 5 (REVIEW.md:26-29). Put them in one place: REVIEW.md can be shortened to "see AGENTS.md, plus the sensitive file list", or AGENTS.md can drop them in favour of REVIEW.md's file list.
- **"Start here" and "Where to look" (1.2 KB)** point at docs/program.md twice (stale), docs/plan.yaml, docs/decisions.md and four more docs; reduce to one line per doc and drop program.md.
- "Validate and ship" (1,513 B) is the longest bullet group and is what every task needs; but the make-targets paragraph and the merge-lock command line belong in the Makefile `help` output and in `factory merge-lock --help` (both exist).
- Would free about 4-5 KB, enough to add one line on the reading order of docs/ and on "architecture.md says how it is, not how it became" (the rule that prevents the next 200 KB).

REVIEW.md (3,756 B): front matter globs list `docs/wav*/**` (the waves dir) and evidence, research; the eight "What failure looks like" bullets are AGENTS.md invariants with file names. Keep only the front matter (route globs) and a link; otherwise one more place to update per invariant.

---

## 8. Findings (ranked by simplification / risk)

### F1. Delete docs/program.md and docs/rewrite.md; stop saying the program is "current"
- **What is there**: program.md (6,596 B) dated 2026-11-08 at lines 3, 23; tracks of 5 other repos (:32-40) and their open items (:43-end); rewrite.md (7,321 B) in the present tense about an orchestrator that ended at the cutover (rewrite.md:5, :17, :66). AGENTS.md names program.md as "the current state" (Start here; Where to look). 70 of 71 plan rows are done, the plan is the status.
- **Why accidental**: two documents that a reader and an agent are told to read first are wrong, and they cost every lead a read. A public reference repo also carries other repos' task lists.
- **Change**: delete both; fix the references (AGENTS.md 2 lines, plan.yaml comments :35 and :217, decisions.md "docs/program.md where a track needs them", `apps/server/src/adapters/hygiene/probes/retired.ts`, `apps/server/test/hygiene/hygiene.test.ts`, `docs/spikes/.../spec.md` mentions). Run `rg -l 'program\.md|rewrite\.md'` first (unverified: the list above is from rg -l on non-archive paths).
- **Must not change**: `docs/plan.yaml` semantics; the hygiene probe that cites program.md must still pass (edit its fixture, not its rule).
- **Risk low, size S.**

### F2. architecture.md: cut Checkpoints, Capacity and leads, Loops and agw, Data to mechanism summaries; move rules to docblocks; generate the settings
- **What is there**: section 4. 160 KB of 201 KB in four sections, 135 commits in 6 days, 89 env names, 182 file names, 158 thresholds.
- **Why accidental**: it is the prose edit-log of each Issue's lead (every lead's "update the docs in the same commit" rule from AGENTS.md produced a log); the code docblock, the Issue and the commit already hold the same text.
- **Change**: as section 4 (target 45 KB). One PR per section (4 PRs), Checkpoints first (40.8 KB to 4 KB).
- **Must not change**: the file names and symbol names that other docs, AGENTS.md and the guide cite (rg for `architecture.md` "…" quoted section titles first: e.g. `docs/architecture.md` "Loops and agw", "API, client, CLI", "The counting epoch and the three answers" are cited by program.md, README, docs/product.md, plan.md, hygiene.md); the README check does not read architecture.md.
- **Risk med** (many inbound section-name citations), **size L** in total, S each.

### F3. Pin-free guide: replace commit permalinks by a check that the quoted snippet still equals the code
- **What is there**: 198 permalinks at 2511836a, 147 commits stale; the `REFUSALS` list in capacity.md has 10 of the code's 11 (`admission.ts:26-38`); `scripts/guide-links.ts` (172 lines) only proves that the pinned file/lines exist.
- **Why accidental**: the check holds the weak invariant (the link works) and not the one a reader needs (the text is true). A pinned sha makes the pages quietly wrong.
- **Change**: in guide-links.ts, for every fenced `ts` excerpt that is preceded by an "Example files" permalink, compare the excerpt to the lines at HEAD (not the sha) and fail on difference; refresh the sha on every guide change. Or link by path+symbol and drop the line anchors. Begin by refreshing the 198 permalinks to current master and updating `REFUSALS` in capacity.md.
- **Must not change**: GitHub and the VitePress site both render the pages (no frontmatter, no containers: the script already holds this).
- **Risk low, size M** (refresh) or S (check).

### F4. Rewrite README as a teaching page (outline in (b)); keep the screenshots, move them down
- See sections 5 and (b). It removes the language table (12 rows), the layout table and the loop paragraphs now restated, and adds: problem, result with generated numbers, loop diagram, worked Issue link, one section per pattern. Size M (README 17 KB to about 22 KB, but `scripts/readme-check.ts` (225 lines) reads statements out of the README; it must be re-pointed at the new sentences; it fails "when a statement is deleted").
- **Must not change**: the counts the check reads (24 event kinds, callers, tokens, screens, domains, states, port, writes) and the sentence patterns it greps (read readme-check.ts first).
- **Risk low-med, size M.**

### F5. Archive evidence, strategy, waves and rewrite out of docs/
- Section 3. 44 MB, about 700 files; `docs/evidence/console-*` alone 33.9 MB. Delete in one PR (evidence), move strategy in another (4 path strings in product.md, decisions.md, kpi-catalog.ts, guide/learnings.md), delete waves/ and prune rewrite/ in a third. Fix `REVIEW.md` "none" glob (`docs/wav*/**` etc.), `scripts/evidence-console-needs-you.sh`, `scripts/gameday/lib.sh:10`.
- **Must not change**: the KPI target citations (`packages/contract/src/kpi-catalog.ts` cites definition.html; a test compares the table to the catalogue); the guide permalinks to docs/rewrite/learnings.md.
- **Risk low (evidence), med (strategy: a cited-string source), size S each.**

### F6. Prune plan.yaml to what is open and what is the target of an `after`
- 71 rows, 70 done, 92,097 bytes; guide/chains.md pins plan.yaml L199-L215.
- Move done rows to docs/archive/plan-done.yaml (or delete; the Issues persist). **Check first**: does `after:` on an open row reference a removed key? (`factory plan check` takes a file and is offline.) Also does the server report `done` for a row only while it exists in the file (the planning-pass state is derived from the file plus the Issue)? unverified.
- **Must not change**: `plan merge` driver behavior (many leads append at once); chains.md's example (re-point it to a live row or to a fixture).
- **Risk med, size S.**

### F7. Make one definition of Position and the 8 principles
- README:19-28, product.md:8-14 and :32-44, guide/README.md:7-9 state the same text. Keep it in product.md (which is the "what is it" source), shorten README and guide start page to one sentence plus a link, and cut product.md's "Position/For whom/Jobs/Principles/Not this/Surfaces" into a 1.5 KB opening and a link to the KPI section.
- **Risk low, size S.**

### F8. Move docs/accounts.md (54.5 KB) into packages/accounts
- The package has its own README; the root README layout row says it is "independent of the server". 14 sections include a "policy lab" and a forecast method. Move with `git mv` and fix 11 references (rg -l found Makefile, README, policy.ts, architecture.md, product.md, plan.yaml, accounts store/onboard/refresh/modes).
- **Risk low, size S.**

### F9. Split decisions.md: archive the first 148 lines and keep the NL/RS list as the index
- The first 8 sections (about 21 KB) describe the pre-reset world ("since retired by RS1"). The decisions that still bind are the 67 labeled (NL1-NL32, RS1-RS16). Move 1-148 into docs/archive/decisions-2026-10.md and leave decisions.md as 57 KB; further, the decision label (NL18, NL22) used by AGENTS.md and 52 code references should remain stable.
- **Risk low, size S.**

### F10. Language: tier the 127 terms
- docs/language.md has 127 table rows; the README shows 12. "One word per concept" is the owner's principle, and 127 concepts is a lot. Add a 15-row "core" table at the top (Signal, Issue, Event, State, Lead, Attempt, Gate, Decision, Spec, Errand, Judge, Steward, Loop, Window, Claim) and mark the rest "reference". No retired-word changes; `scripts/retired-words.ts` reads the Retires column and must keep working. The README's table then is a link to the core table.
- **Risk low, size S.**

### F11. AGENTS.md: drop what a script teaches; delete the duplicate in REVIEW.md
- Section 7. Frees about 4-5 KB.
- **Must not change**: the hygiene probe for AGENTS.md size and "every path AGENTS.md names exists" (agentsmd.test.ts).
- **Risk low, size S.**

### F12. Settings table generated from config
- 89 FACTORY_* names inline in architecture.md. A generated `docs/settings.md` (or `factory --help`) from the config schema; if there is no single schema (unverified: env-file.sh has 15 names and the server reads 124 names by grep) the work is to create one list, which is size M and probably not worth a new layer: instead leave the defaults in the docblock at each read site.
- **Risk med, size M, lower priority.**

---

## (a) Target document set

| Doc | Job | Reader | Max size | Source of truth for | Written by |
|-|-|-|-|-|-|
| README.md | what, why, result with numbers, one section per pattern, how to read next | human, first visit | 24 KB | the claim, the pattern list, the entry points | hand, counts held by readme-check |
| docs/guide/ (README + 10 chapters) | the story and the worked example, chapter per mechanism | human, reading through | 12 KB per chapter, start page 6 KB | the explanation, one running example | hand; snippets held against HEAD (F3) |
| docs/guide/concepts.md (new, one page) | six nouns, states, 24 events, how they relate, the 15 core words | human, second page | 6 KB | the domain model | hand, counts generated |
| AGENTS.md | invariants every task needs | agent | 8 KB | rules a change must keep | hand |
| REVIEW.md | route globs and failure list | reviewer | 1.5 KB | route globs | hand |
| docs/product.md | what it is, for whom, KPI table | both | 14 KB | position, principles, KPIs | hand + generated table |
| docs/language.md | the words, core tier first | both | 30 KB | vocabulary, retired words, state diagram | hand + generated diagram |
| docs/architecture.md | what is where and how it fits | agent | 45 KB | layers, owners of mechanisms, "not built" | hand |
| docs/decisions.md | why (NL/RS), no history | agent | 55 KB | the reasons | hand |
| docs/operations.md | listener, CLI, checks, merging, deploy | agent, operator | 13 KB | the procedures | hand |
| docs/project.md, docs/plan.md | file format pages | agent | 27 KB, 23 KB | the formats (also printed by `factory ... schema`) | hand + generated keys |
| docs/hygiene.md | probes | agent | 18 KB | the catalogue | generated |
| packages/accounts/docs/accounts.md | the picker's design | package maintainer | 55 KB | the picker | hand |
| docs/plan.yaml | open work only | planning loop | under 15 KB | the plan | hand |
| docs/demo, docs/brand | screenshots, brand | README | as is | n/a | generated |
| docs/archive/ (optional) | learnings.md, decisions of 2026-10, strategy HTML | historian | n/a | n/a | frozen |

Deleted from the reading path: program.md, rewrite.md, waves/, rewrite/ (except learnings), evidence/ (except what code reads), strategy/ (to archive), research/spikes/design (archive).

## (b) Proposed README outline (reference's teaching style)

One page, table of contents after the intro, each pattern as its own section with: **Definition**, **The rule**, **Why**, **In the code** (a path plus symbol), **Read more** (guide chapter and Issue). Section list with the one claim and the link:

1. **Title and one-sentence claim** (as now) plus a 3-line "what you will find here" and the honest disclaimer ("one implementation, not a product; every pattern here is a recommendation, take what fits": same stance as the reference).
2. **The problem** (4 lines): agents write code faster than a person can supervise it; the person becomes the bottleneck at spec, question, merge. Claim: the scarce resource is the owner's attention.
3. **The idea and the result** (before any screenshot): the loop diagram (`docs/guide/diagrams/loop.svg`) and four numbers from `factory read kpis`, generated and dated: Issues filed and closed per week, Decisions the owner settled per 100 Issues (5 per 1,249 on 2026-11-17), avoidable touches per Issue (0.061, target 0.07), first-verification passes. Link: guide/README.md:13-20. 
4. **Pros and cons / when not to use this** (what a factory costs: one host, subscriptions, a database, discipline), like the reference's Pros and Cons.
5. **Table of contents**.
6. **The domain in 6 nouns** (Signal, Issue, Event, Lead, Checkpoint, Loop): a diagram of nouns and relations and the state machine (`docs/language.md#the-issue-as-the-code-has-it`, generated). Claim: one word per thing.
7. **A worked example: one Issue's life** with its real events (`issue_1809`: filed, settled, admitted, lead_started, shipped, watch_passed, closed), timestamps and the command that shows it. Link: `docs/guide/issues.md:208`.
8-19. **One section per pattern**, each with Definition, Rule, Why, In the code, Read more. In this order (the order of the Issue's life, then the cross-cutting ones):
   - Everything enters as a signal (`domains/intake`, `fingerprintOf`; guide/signals).
   - Facts are stored, state is derived (`domains/work/table.ts`, `machine.ts`; guide/issues).
   - The transition table is total (`table.ts`, `make check` regenerates the diagram).
   - One Issue, one lead (`domains/leads/brief.ts`; guide/leads).
   - Gates are code (`domains/quality/gate.ts`, `judgeShip`; guide/gates).
   - Admission is a decision with numbers (`domains/capacity/admission.ts` `REFUSALS`; guide/capacity).
   - Chains are declared, never guessed (`planning_edges`, plan rows; guide/chains).
   - Deterministic first, then a workflow, then the owner (Judge, Steward, Triage; guide/loops and checkpoints).
   - Checkpoints are rare and have contracts (`domains/checkpoints`; guide/checkpoints).
   - Claim, commit, call, record; every effect has a key (`kernel/keys.ts`, `unit-of-work.ts`).
   - A caller is its token (`api/policy.ts`; the test that fails without a row).
   - One word per thing (`scripts/retired-words.ts`, `vocabulary.ts`) and the README tells the truth (`readme-check.ts`).
   Each ends with one "What the build holds" line (the check that enforces it): `tsc`, `scripts/boundaries.ts`, test names.
20. **The Console** (screenshots, 3 of them, then link to the rest in the guide or a gallery file).
21. **The architecture** (the layer diagram already in the README plus the domain table).
22. **Run it** (shortened; link guide/running.md).
23. **Further reading** (guide, product, language, architecture, decisions) and **Licence**.

Rules for the build: `scripts/readme-check.ts` already protects the counts; add the generated numbers of section 3 to the same check.

## (c) Proposed guide start page outline

1. **One sentence and the problem** (3 lines).
2. **The result**: the KPI table, generated, dated in its title (guide/README.md:13-20 today).
3. **The loop** diagram and the 8 steps (keep).
4. **Concepts on one page** (new: six nouns, six states, the 24 events grouped by who sends them, the 4 checkpoint kinds; one diagram).
5. **How to read this guide**: three paths: "the idea" (loop, issues, checkpoints), "the safety" (gates, perimeter, capacity), "to run one" (running).
6. **Chapter table** (keep, reorder: signals, issues, leads, gates, checkpoints, capacity, chains, loops, running, then Learnings as an appendix).
7. **The running example**: issue_1809 in 8 lines with links into the 5 chapters that use it.
8. **What this is not** (keep).

Position paragraph stays in the README only; the guide links it.

## (d) Files to archive or delete, with sizes

| Path | Size | Action |
|-|-|-|
| docs/evidence/console-* (14 dirs) | about 33.9 MB | delete |
| docs/evidence/golden | about 8.6 MB | delete or move to a test fixture if code reads it (no code reader found; unverified) |
| docs/evidence (rest: kpi, chain-at-scale, interventions, subs-console, signals, f1-*, f2-gate, gamedays, alert-sources, cold-trial, md files) | about 6 MB | delete; repoint scripts/gameday/lib.sh:10 and scripts/evidence-console-needs-you.sh |
| docs/strategy/ | 2.1 MB, 11 files | move to docs/archive/strategy, fix 4 path strings |
| docs/waves/ | 364 KB, 57 files | delete |
| docs/rewrite/ (except learnings.md) | about 375 KB | delete; keep learnings.md (24 KB) |
| docs/rewrite.md | 7,321 B | delete |
| docs/program.md | 6,596 B | delete |
| docs/research/, docs/spikes/, docs/design/ | 124 KB, 20 KB, 8 KB | move to docs/archive (research/2026-11-13-throughput-tooling.md and 2026-11-14-taskpolicy-steps.md stay if architecture.md cites them) |
| docs/plan.yaml done rows | up to about 80 KB of 92 KB | prune (F6) |
| docs/accounts.md | 54,532 B | move to packages/accounts/docs/ |
| docs/decisions.md lines 1-148 | about 21 KB | move to docs/archive/ |
| docs/architecture.md | 201 KB to 45 KB | rewrite per section 4 |

## Could not check

- Whether anything but the README is held to the code, except the explicit list in readme-check.ts and guide-links.ts (I read their headers, not all 473 lines).
- Whether a removed plan row breaks an `after:` reference or changes the planning pass (I did not run `factory plan check`).
- Whether docs/evidence/golden is read by tests or the triage workflow outside this repo (rg found only strategy HTML).
- The 89 FACTORY_* names in architecture.md against code (20+ do not appear literally in the code; the code probably builds them from a prefix).
- Where the AGENTS.md 12,000 byte cap is enforced (agentsmd.ts probe, unverified).
- Whether the published site (software-factory.jkrumm.com) renders the guide as intended; I did not open it.
- decisions.md (NL25-NL32 are cited elsewhere but I did not read every decision), accounts.md body, plan.md body, project.md body beyond headings.
