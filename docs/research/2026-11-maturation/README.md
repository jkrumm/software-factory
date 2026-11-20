# Maturation cycle, 2026-11-20

**Verdict.** The core is sound: the total transition table, the stored facts, the keys and the layering all hold, and `fallow` finds no circular import and 2.25 % duplication. What has accreted sits around the core:

- The factory measures 28 KPIs and acts on none of them.
- Its improvement loops file 18 % of all Issues and do not check that a number moved.
- A lead is refused about 100 times a week for things the server already knows.
- The documentation is 611 KB of prose in which the idea is hard to find.

This cycle removes mechanisms; it adds one verb and no layer. Four choices are the owner's: see "The owner's calls".

The evidence is in this folder: seven read-only audits (`audit-*.md`, each finding with file and line), a static analysis run (fallow 3.38.1) and a research report on published cleanup procedures (`research-cleanup-procedures.md`). The work is the `mat-*` rows of `docs/plan.yaml`.

## Where it stands

| Area | Today | After the cycle |
|-|-|-|
| KPIs on the table | 28; 5 have a target; no code acts on one | 7: three keep their target, three get a proposed one, one waits three weeks for data; each names what acts when it breaks |
| Issues filed by the factory's own loops | 282 of 1,545 in 7 days (18 %); hygiene alone 212 | one Issue per repo and pass, each with the figure it was filed against |
| Ships the gate refused | 101 a week; about 70 for a hand-typed sha | the server derives the commits; the lead types none |
| The lead's brief | 27.7 KB, 40 phrases pinned by a test | at most 12 KB |
| `factory --help` for a lead | 24.9 KB, about 100 verbs, 39 of them answer 403 | the 15 verbs a lead may call |
| `FACTORY_*` settings | 175 names, 122 allow-listed, 37 in no test and at most 3 docs | the ones the deployed env sets or a doc promises |
| Loops | 20 specs written out in a 1,002-line `main()`, 3 schedulers | each spec beside its pass, intervals in one table |
| Port interfaces | 72 with 418 methods; 43 have one method; `CheckpointStore` has 82 | workflows are one table; the call ledger is one table |
| Domains | 8, of which `loops` is a bag of 26 files (15 import no sibling) | 10 that each own something: `hygiene`, `improve` and `errands` named |
| Cutover scaffolding | 2,131 lines of importer, 2 tables, 2 shadow modes | gone |
| `docs/` | 611 KB of Markdown, 44 MB of evidence, `architecture.md` 201 KB | `architecture.md` at most 60 KB, the archive out of the reading path |
| `docs/plan.yaml` | 71 rows, 70 done | open rows only |

## What the audits found

### The factory measures a lot and acts on little

- **No code acts on a KPI.** `KPI_CATALOG` has one server reader, and it only copies the catalogue's prose into the response (`read/kpi-fields.ts`). The target check lives in the Console.
- **The friction loop has thresholds of its own.** It fires on an owner touch at 0.15 per Issue closed; the KPI's target is 0.07 per Issue filed. For refusals the loop's threshold is 0.1 and the KPI's target 0.25. So a KPI can be off its target while the loop files nothing, and the reverse.
- **The headline trend comes from the denominator.** Avoidable touches fell from 0.23 to 0.10 to 0.04 per Issue while the touches themselves went 29, 83, 58. The Issues filed went 127, 822, 1,545, and 212 of the last week's are hygiene Issues.
- **Four KPIs count the same five events** (`asks`, `owner_decisions_per_100`, `recommendation_taken`, the Decision part of `avoidable_touches`). Five count Errands.
- **One question, two answers on one page.** `queue_capacity_share` says capacity holds 0.785 of the queue time; the parts of `queue_wait_p90` say 0.66. Queue time is defined five ways.
- **The refusal rule cannot fire.** `read/friction.ts` keys a refused ship on its raw reason, sha included: 72 of 90 keys are one refusal with a different commit. The rule needs one key on 10 % of the closed Issues, about 160 refusals with 1,604 closed in the week; the largest key has 15.
- **Friction refiles daily.** The window is 7 days rolling and the fingerprint window 24 hours, so the same finding became a second Issue a day later, and the weekly retro is filed on every pass.
- **Only throughput checks its own effect.** It looks again three days after a ship (moved, flat or worse). Friction, selfwatch and hygiene close an Issue when a lead says done.
- **Loop findings pass the dedup built for a person's words.** All four loops file through the path that matches open Issues by text and then asks the triage workflow, about 300 calls a week, with four wrong folds in a sample of 200 signals.

### An agent pays for what the server already knows

- **The sha.** `issue ship` takes commits typed by hand, though the server holds the branch and the cut. One Issue retried the same sha four times with one digit wrong. The retro counts 49.8 lead-hours a week behind refused ships.
- **The attempt.** Seven lead verbs require `--attempt`; the session variable already says it. The brief repeats the flag 20 times.
- **The merge window** is 5.3 KB of shell in the brief, patched three times in two days. 183 ships a week go out with no review of the change, because the check before landing is left to the lead's memory.
- **Steering by hand.** 93 notes from the orchestrator and 45 from the owner in 7 days. A changed plan row never reaches a lead that already started; a pause sent as a note produced repeated stalls.
- **A model outage looks like an answer.** Five agw workflows catch a model failure and return a neutral verdict, so the factory's retry never runs. In an outage a Decision goes straight to the owner (`factory-ask`), and a new Issue is settled with no `after` edges (`factory-triage`).

### The code carries finished rollouts

- The cutover importer (2,131 lines) still ships, and the running server still reads its table for a window cut that ended on 2026-11-13.
- The load rule and the slot aim were rolled out behind a shadow mode (decide and record, do not act). Production runs both on; the code's default is still `shadow`, and the shadow table and decision code stay.
- Four `runProcess` implementations, three `killGroup`, three `childEnv`, four git wrappers, two GitHub REST readers.
- `queue_asks` and `loop_calls` are one table twice. Twelve one-method workflow ports wrap one `AgwPort.run` through ten adapters of ten lines.
- Standing policy, the first step of a Decision, has settled 0 Decisions: no project defines a rule and nothing writes one.
- No migration has ever dropped a column.
- `seat` means two things, `hold` four, `settle` seven, `class` nine.

### The documents hide the idea

- The README states no problem and no result before its screenshots, uses 20 undefined terms in its first 60 lines, and lists its patterns as a table where the reference it should match gives each one a rule, a reason and a link into code.
- `architecture.md` is 201 KB; four sections hold 79 % of it, written as change logs ("since Issue N").
- The guide teaches better than the README, but its 198 permalinks pin a commit 147 commits back, and one quoted list is already wrong.
- `program.md` calls itself the current state and is dated 2026-11-08; AGENTS.md sits at 11,997 of its 12,000 bytes.

## The target

### Seven KPIs

One threshold table serves the KPI catalogue and the friction loop, so a KPI off its target is a finding the loop files.

| KPI | Target | Acts when it breaks |
|-|-|-|
| Avoidable touches per Issue a person or an alert filed | at most 0.07 | friction files the largest touch kind |
| First verification passes | at least 0.9 | friction's regression rule; the light seat's gate |
| Specs at the owner not needed | at most 0.2 | friction names the source that made the Spec owed |
| Errands that reached the owner per 100 Issues | set after three full weeks | a new auto-run class, or a screen rule |
| Cycle, median | at most 3 h (proposed) | capacity tuning, by the parts of the queue wait |
| Queue wait, 90th percentile | at most 8 h (proposed) | a cap, a seat or a chain |
| Quota used at reset | at least 0.9 (proposed) | the owner adds or drops a subscription |

Each of the other 21 becomes a part of one of the seven, or stays on the screen that already shows it. `audit-read.md` says for each what leaves the table with it.

### Ten domains

`work`, `intake`, `planning`, `leads`, `capacity`, `quality`, `checkpoints`, `errands`, `hygiene`, `improve`. Section 9 of `audit-domain.md` gives each one's tables and three to five rules; that map is the outline of the README's domain section.

### A lead's fifteen verbs

`issue show`, `ship`, `close`, `defer`, `block`, `ask`; `decision take-default`; `artifact submit`, `revise`, `show`, `annotation-reply`; `errand raise`; `signal file`; `land`; `slot run`. The caller's token already decides the rest; the help follows it.

## The program

Rows in `docs/plan.yaml`, each one pull request. A row waits for another only where it needs its output.

| Step | Rows | What moves |
|-|-|-|
| 1. Friction off the lead | `mat-ship-proves-itself`, `mat-lead-cli`, `mat-refusal-next-step`, `mat-workflow-failure`, `mat-screen-key`, `mat-plan-facts-resend` | refusals, notes and stalls per week |
| 2. Loops that close | `mat-friction-keys`, `mat-friction-cooldown`, `mat-finding-key`, `mat-loop-ledger`, `mat-hygiene-batch`, `mat-ci-ledger`, `mat-display-loops` | loop-filed Issues per week, and each with a figure |
| 3. Seven KPIs | `mat-reads-unused`, `mat-kpi-seven`, `mat-queue-time-one`, `mat-capacity-page` | 28 to 7; about 2,300 lines |
| 4. Finished rollouts leave | `mat-importer-leaves`, `mat-shadow-leaves`, `mat-settings-prune`, `mat-decision-path`, `mat-fallow-gate`, `mat-contract-drops` | settings, tables, dead exports |
| 5. One of each | `mat-process-one`, `mat-github-one`, `mat-loop-specs`, `mat-workflow-table`, `mat-call-ledger`, `mat-intake-split` | runners, readers, schedulers, ports |
| 6. agw | `mat-agw-failures`, `mat-agw-answers`, `mat-errand-screen-typed`, `mat-agw-errand-fields`, `mat-agw-digest-leaves` | one failure rule, typed facts |
| 7. The model and its words | `mat-domains-loops`, `mat-domains-errands`, `mat-language-round`, `mat-enums-once`, `mat-land-verb`, `mat-owner-pause`, `mat-brief-short` | 10 domains, one word per thing, the brief at 12 KB |
| 8. Documents | `mat-docs-archive`, `mat-plan-prune`, `mat-guide-snippets`, `mat-arch-checkpoints`, `mat-arch-capacity`, `mat-arch-loops`, `mat-agents-md`, `mat-docs-truth` | 611 KB to about 300 KB |
| 9. Review | `mat-review`, `mat-skill` | the table above, measured again; the procedure as a skill |

## Left for a second round

Each is real and none is urgent:

- Split the stores with 82, 49 and 44 methods by aggregate.
- One Errand ending in place of four.
- One row for the owner's presence.
- Ports that throw where the rule says `Result`.
- The 28 one-line forwarders of `app/checkpoints-uses.ts`.
- The unit of work that builds 13 stores for every transaction.

The light seat's and the reviewer's tripwires are two to three days old and still decide: they stay until they have a verdict.

## The owner's calls

Four rows carry a Spec, because each is a new surface or changes what a word means. Each Spec names its default and goes on with it after 24 hours.

| Row | The choice | Default |
|-|-|-|
| `mat-kpi-seven` | the three proposed targets, and whether loop-filed Issues leave the denominator | 3 h, 8 h, 0.9, and they leave |
| `mat-land-verb` | one verb for rebase, CI wait, merge guard, review check and merge | build it; the recipe leaves the brief |
| `mat-owner-pause` | a pause as a wait the owner sets and ends, in place of a note | a wait reason, no new state |
| `mat-language-round` | the words that replace the second meanings of seat, hold, settle and class | the table the lead proposes in its Spec |

Three go ahead without one, each reversible by a revert: standing policy is deleted (0 uses), the digest's bullets become plain titles (its own eval scores faithfulness 0.22), and `docs/evidence` leaves the tree (git keeps it).

## How the cycle ran

The procedure, for the skill that `mat-skill` writes from it:

1. **Measure before reading.** Sizes by folder, the largest files, counts of settings, tables, loops and ports, and the system's own numbers (KPIs, friction, what each loop filed and how it ended).
2. **Run the deterministic analyser** (fallow: dead code, duplication, complexity). Its findings are leads: 15 "unused" contract exports were spot-checked and all were in use.
3. **Research the procedures others publish**, once, for the order of passes and the gates.
4. **Audit by area in parallel, read-only**, one agent per area with the same contract: evidence with file and line, deletions and merges only, each one pull request, a full report on disk and a ranked summary back. The owner's doubts go into the brief verbatim, and the live numbers go in as files.
5. **Verify the claims that carry the plan** against the code before filing anything.
6. **Synthesise into a target**, not a list: the KPI set, the domain map, the agent's surface, the document set.
7. **File the work as rows**, the friction removals first, the moves after the files they move have settled, the documents last.
8. **Measure again** after a week on the same numbers.

What the research adds for the passes themselves:

- One category per pass, the safest first: dead code, stale flags, duplication, needless abstraction, boundaries, defensive code, error handling, types, comments, tests.
- The test suite is the oracle, so tests and code never change in one unreviewed step.
- Gate on the findings a change introduces, not on a score.
