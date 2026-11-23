# The product

**A software factory is a closed loop that turns signals into verified production changes. Agents do the work, code
supervises them, and one person decides only what a person must.** Signed by the owner on 2026-11-07
(`docs/archive/strategy/2026-11-next/definition.html`, decisions NL1 to NL21). Words are defined in `docs/language.md`, the
build in `docs/architecture.md`.

## The position

**Dark for code, lit for decisions.** The README states the position, what reaches the owner and why
([README.md](../README.md#dark-for-code-lit-for-decisions)); this page does not repeat it. What this page adds is that the
owner's taste is set once per project, in a Concept.

## For whom

- **First, the owner:** one senior developer with a portfolio of unrelated repos, one always-on machine and a few
  Claude subscriptions.
- **Then the reader:** a factory engineer building one for a company. This repo is an implementation, and it is also
  the proof: it embodies the language, the patterns and the loops, and shows the degree of automation they reach.
  Nobody runs it as it stands; every factory is set up and configured for its place.

## Jobs it does for the owner

1. Show what needs the owner, and nothing else, until asked.
2. Show what runs, what comes next and what shipped, globally and per project, with the dependency chain.
3. Take work in natural language and do the project management itself: triage, merge, amend, order, chain.
4. Mean it when it says shipped: deployed and verified in production.
5. Find its own friction, fix it, and prove the fix worked.

## Principles

1. **Deterministic first, then an agw workflow, then the owner.** Every judgment takes that order. The factory never
   calls a model itself.
2. **Facts are stored, views are computed.** The event log is the truth; an Issue's state is its latest result.
3. **One Issue, one lead.** The lead owns it from root cause through build, review, ship and verification in
   production. The factory supervises and never redoes the lead's work.
4. **Gates are code.** What an agent is told does not change what it can do.
5. **Capacity is a first-class resource:** subscriptions, windows, memory, load, repo claims.
6. **Everything enters as a signal.** Triage decides whether it becomes an Issue, amends one, joins an incident or is
   dropped. Nobody files around the state machine.
7. **Fix forward.** A bad change gets a new change; nothing is built to make changes restorable.
8. **One language** across code, CLI, screens and docs.

## Not this

A product for others, multi-tenancy, a tracker where people manage work, human merge approval, evals and benchmarks,
rollback machinery, or personal analytics (Argo keeps those).

## Surfaces

| Surface | Job |
|-|-|
| Console (this repo) | Overview, Needs you, Chain, Projects, Artifacts, Improve, Throughput and Accounts, and the Issue, project and artifact pages. A PWA on the tailnet |
| Herdr | Working in terminals, plus a glance that links to the Console |
| Iris | A Hermes interface. Later it renders UI components, so an artifact can appear inside it |
| Hermes | Conversation: files signals, reads state, never decides the factory's work |
| Argo | Personal dashboards and deep data. The factory reads its usage schema, it does not copy it |
| ntfy | The line to the owner when away, for checkpoints only. Work the factory settles never pages |

## How we know it works

Seven KPIs, read in 7-day windows on the Console's Improve screen (`factory read kpis`). Every KPI states what it counts
over what, which way is good, its target and where the target came from, and the decision it drives; a figure that drives
none is not a KPI. A target is `at most` for a figure where lower is good and `at least` where higher is good, never a band:
a value better than the target is on target. A KPI with no number yet says why and when one is due. The targets live in one
table beside the friction loop's rules (`THRESHOLDS` in `packages/contract/src/thresholds.ts`), and the friction loop acts
on them: a KPI off its target over a whole window is a finding that names its largest part. The table below is generated
from the catalog (`packages/contract/src/kpi-catalog.ts`; `bun scripts/kpi-table.ts` rewrites it, and a test and
`make check` fail when it differs), so the code, the screen and this page say one thing.

<!-- kpi-table:start -->
| KPI | Good | Target | Where the target comes from | Counts | Over | Decision it drives |
|-|-|-|-|-|-|-|
| Avoidable touches per Issue | Lower | at most 0.07 | The owner, 2026-11-07, "Maybe 5% is a good KPI, 7% or so": signed as "at most 0.05 to 0.07" (docs/archive/strategy/2026-11-next/definition.html). Read as at most 0.07 | Owner actions on an Issue the factory should have settled, a loop’s Issues included (a Decision answered, a note, a wake, a cancel, a reopen; one burst of a kind counts once) | Issues filed in the window by a person, an agent or an alert (the factory’s own loops left out: friction, hygiene, selfwatch, throughput) | Which touch kind to remove first: off target, the friction loop files a finding naming the largest kind, and a touch that repeats becomes a rule, a default or a brief change |
| First verification passes | Higher | at least 90% | docs/product.md, 2026-11-07 (the signed doc said at least 80%; the table was raised to 90%) | First watches that ended passed | First watches that ended passed or regressed in the window | Whether shipped changes hold in production; the parts name why each regression failed (CI, verify, deploy, probe), so the fix goes at the cause. Read beside the first watch dwell |
| Asks that did not need the owner | Lower | at most 20% | Carried over from the earlier line for Specs alone (#306, 2026-11-10: one ask in five wasted on him), now read from his answers: of 85 verdicts in the eight days to 2026-11-21, 27 carried no word from him | The owner’s own answers that changed nothing: a verdict of Looks good with no note and no comment, a Decision answered with the recommendation | The owner’s own verdicts on a Concept or Spec and Decisions he answered in the window | Which kind of ask and, for a Spec, which source made it owed (triage, the filer, a Replan, the lead) and so which rule to change; a preference about how much to ask goes to order 2 of the lead brief |
| Errands that reached the owner per 100 Issues | Lower | watch only | No target yet: one is set once three full weeks after the counting epoch exist (the first ends 2026-11-22); the first weeks gave 0, 1.8 and 5.0 per 100 | Errands the screen let through to the owner | Issues filed in the window (per 100) | Which kind of Errand to take off him: the parts split by need (secret, hands, a place on his MacBook, only his yes); beside them, the share the screen turned away and the share his MacBook ran by itself |
| Cycle, median | Lower | at most 3 h | Proposed in the Spec of Issue 2606 (2026-11-20) and taken by the owner with "looks good", no measured basis beyond 1.5 times the worse full week (2.0 h) | Median of filed-to-closed time | Issues that closed in the window | Whether work is getting slower end to end; the parts (time by state) and the queue wait say where |
| Queue wait, 90th percentile | Lower | at most 8 h | Proposed in the Spec of Issue 2606 (2026-11-20) and taken by the owner with "looks good", no measured basis beyond the worse full week (8.3 h) | 90th percentile of filed-or-reopened-to-admitted time | Admissions in the window | Whether to raise a cap or a seat count, or change a chain: the parts split the queued time by what held it (capacity, an after edge, a draining queue, production red) |
| Quota used at reset | Higher | at least 90% | Proposed in the Spec of Issue 2606 (2026-11-20) and taken by the owner with "looks good", no measured basis beyond the weeks so far (0.94 to 0.98) and the accounts simulation (packages/accounts/docs/accounts.md, v1.9: 91-100 % at or above the pool's demand) | The weekly percent each account stood at when its weekly window reset, weighted by the account’s weekly capacity (the reset ledger of packages/accounts) | Account resets in the window, weighted by capacity | Whether the subscriptions are used: a low figure with Issues waiting means the picker leaves quota unspent (packages/accounts/docs/accounts.md §The picker); a high one with a long queue means a subscription is missing. Beside it: window points and dollars per Issue |
<!-- kpi-table:end -->

Each is a count over the window that SQL can repeat (`read/kpis.ts`, `read/kpis-flow.ts`, `apps/server/test/read-models`);
a breakdown (touches by kind, queued time by reason, why first watches regressed) is the KPI's `parts`, and the figures
that explain it without adding up to it (the asks, the Spec rate, the working share, the dollars per Issue) are `beside`
it. Its history starts at the counting epoch. The friction counts (`factory read friction`) are not KPIs: each is a count
of waste with a rule from the same threshold table that files a signal (`domains/improve/friction.ts`). The light-seat and
cheap-reviewer gates read their own figures (`factory read seats`). What no table holds (seconds by tool category, idle gaps, tool errors, `make check` runs)
is the transcript pass of `factory retro`. The friction loop's weekly pass files one Issue whose lead reads that bundle,
writes a Report (the numbers against last week, the patterns in a sample of transcripts, the ledger of earlier retro
signals with what each number did) and files one marked signal per change (`docs/architecture.md`, the `friction` loop).

### Fix causes

A fix commit is a commit on a project's default branch whose subject is a conventional `fix`. The `fix-causes` loop sorts
each into one cause by rule: by its scope or its words where they settle it, `other` otherwise.

| Cause | A fix for |
|-|-|
| `tests` | tests, scenarios or e2e only |
| `docs` | documentation only |
| `tooling` | CI, dependencies, build, lint or scripts |
| `review` | a follow-up to a finding of a review |
| `logic` | wrong behaviour in the code's own logic |
| `contract` | a mismatch across a boundary: an API, a schema, types, a migration or the shape of a config |
| `concurrency` | races, locks, ordering, timers, replay or idempotence |
| `environment` | deploy, host, process, paths, runtime or secrets |
| `other` | none of the above |
