# The product

**A software factory is a closed loop that turns signals into verified production changes. Agents do the work, code
supervises them, and one person decides only what a person must.** Signed by the owner on 2026-11-07
(`docs/strategy/2026-11-next/definition.html`, decisions NL1 to NL21). Words are defined in `docs/language.md`, the
build in `docs/architecture.md`.

## The position

**Dark for code, lit for decisions.** No person reviews a change before production. The lead's own review, gates,
the watch window and probes do that job. What reaches the owner is product direction, spend, irreversible data loss,
other people, security policy, rare big architecture and taste, set once per project in a Concept. Warp keeps a person
at spec, question and merge ("agents never merge on your behalf") and calls dark factories "not realistic right now".
This factory exists to show how far past that a solo setup can go.

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
| Console (this repo) | Overview, Needs you, Chain, Projects, Artifacts, Improve and Throughput, and the Issue, project and artifact pages. A PWA on the tailnet |
| Herdr | Working in terminals, plus a glance that links to the Console |
| Iris | A Hermes interface. Later it renders UI components, so an artifact can appear inside it |
| Hermes | Conversation: files signals, reads state, never decides the factory's work |
| Argo | Personal dashboards and deep data. The factory reads its usage schema, it does not copy it |
| ntfy | The line to the owner when away, for checkpoints only. Work the factory settles never pages |

## How we know it works

Read in 7-day windows, on the Console's Improve screen (`factory read kpis`). Every KPI states what it counts over what,
which way is good, its target and where the target came from, and the decision it drives. A KPI that drives none is
dropped. A target is `at most` for a figure where lower is good and `at least` where higher is good, never a band: a value
better than the target is on target. A figure with no basis for a number is watch only, and says so. The table is
generated from the catalog (`packages/contract/src/kpi-catalog.ts`; `bun scripts/kpi-table.ts` rewrites it, and a test and
`make check` fail when it differs), so the code, the screen and this page say one thing.

<!-- kpi-table:start -->
| KPI | Good | Target | Where the target comes from | Counts | Over | Decision it drives |
|-|-|-|-|-|-|-|
| Avoidable touches per Issue | Lower | at most 0.07 | The owner, 2026-11-07, "Maybe 5% is a good KPI, 7% or so": signed as "at most 0.05 to 0.07" (docs/strategy/2026-11-next/definition.html). Read as at most 0.07: below it is better, never off target | Owner actions on an Issue the factory should have settled (a Decision answered, a note, a wake, a cancel, a reopen; one burst of a kind counts once) | Issues filed in the window | Which touch kind to remove first: the friction loop files the largest kind, and a touch that repeats becomes a rule, a default or a brief change |
| Asks per Issue | Lower | at most 0.07 | The owner, 2026-11-07, "Maybe 5% is a good KPI, 7% or so": signed as "at most 0.05 to 0.07" (docs/strategy/2026-11-next/definition.html). Read as at most 0.07: below it is better, never off target | Decisions raised that the factory did not settle itself (the owner or the orchestrator answered them, or they still wait) | Issues filed in the window | Whether a recurring Decision should become a standing policy or a Judge precedent; read beside owner Decisions per 100 Issues, since a path that asks nothing is not the goal either |
| Owner answers that took the lead’s recommendation | Lower | watch only | Watch only: no basis for a number yet. Replaces the "worth asking" mark, which needed a click the owner never gave | Decisions the owner answered with the option the lead recommended | Decisions the owner answered in the window | A high share means leads ask what they already know: tighten the rule that decides when a lead may raise a Decision, or add a standing policy for the recurring question |
| Specs per 100 Issues | Watch only | watch only | Watch only: a Spec is owed by rule, so no rate is right; near zero for weeks means the Spec path is silent | Specs the leads submitted | Issues filed in the window (per 100) | Whether the Spec path is silent (triage and the lead’s Spec rules need a look) or flooding the owner |
| Owner-settled Decisions per 100 Issues | Watch only | watch only | Watch only: the floor that tells silence from success; asks per Issue is the one with a ceiling | Decisions the owner answered himself (not the Judge, a policy, a default or the orchestrator) | Issues filed in the window (per 100) | Whether anything reaches the owner at all: this and Specs per 100 both near zero means the checkpoints are silent, not that the factory is perfect |
| Errands that reached the owner per 100 Issues | Lower | watch only | Watch only: the first weeks of data (0, 1.5, 5.1 per 100) give no basis for a number | Errands the screen let through to the owner | Issues filed in the window (per 100) | Which kind of Errand to take off him: the parts split by need (secret, hands, a place on his MacBook, only his yes) |
| Errands that reached the owner needing neither a secret nor hands | Lower | watch only | Watch only: the aim is zero, but the first reading is not in yet | Errands that reached him needing a place on his MacBook or only his yes | Errands that reached the owner in the window | Each one is a step a token or a command could take: add the verb (the lead does it itself) or a screen rule that turns the Errand away |
| Errands the MacBook ran by itself | Higher | watch only | Watch only: the first class (secrets-seed) shipped 2026-11-19, so there is no reading to set a number from | Errands closed by a granted auto-run class in the window | Errands that reached the owner in the window, plus those that ran by themselves before they reached him | Which command shape repeats with no refusal and joins the catalogue next: the lead of dotfiles adds a row, he grants it once |
| Specs at the owner not needed | Lower | at most 20% | Set with the Spec screen (#306, 2026-11-10), no measured basis: one Spec in five wasted on him is the line the screen is judged by | The owner’s own verdicts on a Spec marked "needed me: no" | The owner’s own verdicts on a Spec in the window | Which source made the unneeded Spec owed (triage, the filer, a Replan, the lead) and so which rule to change |
| Owner verdicts that ask for changes | Lower | watch only | Watch only: a Concept or Spec may rightly need notes; falling over time is the aim, a number is not set | The owner’s own verdicts on a Concept, Spec or Report that were good with notes or changes | The owner’s own verdicts in the window | Whether leads know his taste: a high share means the retro’s recurring notes are not reaching the next lead |
| First verification passes | Higher | at least 90% | docs/product.md, 2026-11-07 (the signed doc said at least 80%; the table was raised to 90%) | First watches that ended passed | First watches that ended passed or regressed in the window | Whether shipped changes hold in production; the parts name why each regression failed (CI, verify, deploy, probe), so the fix goes at the cause. Read beside the first watch dwell |
| Refusals per Issue | Lower | at most 0.25 | The owner’s signed table, 2026-11-07 (docs/strategy/2026-11-next/definition.html): at most 0.25 | Issue events the state machine refused, plus ships the gate refused | Issues filed in the window | Which refusal repeats: a rule or a prompt that is wrong, so the friction loop files it |
| Cycle, median | Lower | watch only | Watch only: no basis. product.md said "set after parallel leads"; parallel leads run now and the window still moves too much (0.5 h, 0.9 h, 2.3 h) to set one | Median of filed-to-closed time | Issues that closed in the window | Whether work is getting slower end to end; the queue wait and the working share say where |
| Queue wait, 90th percentile | Lower | watch only | Watch only: no basis; the tail is set by chains and caps the owner chose | 90th percentile of filed-or-reopened-to-admitted time | Admissions in the window | Whether to raise a cap or a seat count, or change a chain: the tail is where an Issue waits for hours |
| Fix commits per week, by class | Lower | watch only | Watch only: falling over four weeks is the aim; no number is set | Commits with a conventional fix subject on a project’s default branch, by class | Each of the last four weeks (a count, not a ratio) | Which class of fix keeps coming back (tests, contract, concurrency, environment) and so which gate or rule to add |
| Window points per Issue | Lower | watch only | Watch only: no basis; read as a trend and against the Max quota left | Points of the five-hour Max window the Issues’ sessions used | Issues filed in the window | Whether the subscriptions carry the work: a rise means a seat or a tier is spending more than its Issues return |
| Cost per Issue | Lower | watch only | Watch only: development runs on flat-rate Max subscriptions, so the dollars are notional | Dollars the usage schema priced for the Issues’ sessions | Issues filed in the window | Which seat (tool, model, effort) spends most, from the parts: whether a tier or a role costs more than its Issues return; the real limit is window points |
| Share of queued time held by capacity | Lower | watch only | Watch only: some queueing is by design (the chain); the share a cap or a slot holds is the figure to lower | Queued time no after edge held (the repo’s lead cap, a seat, a slot, an account window, the queue state) | All queued time that ended in the window | Whether to tune capacity (caps, seats, slots) or the chains: the parts split the time between the two |
| Idle capacity behind a queue | Lower | watch only | Watch only: high by construction while a repo’s lead cap holds an Issue; read beside the capacity loop’s reasons | Hours an unchained Issue sat queued while an enabled account had room | Hours of the window with an unchained Issue queued | Whether capacity is idle behind a queue: it sends the capacity loop to the reason that holds the Issue |
| Working share of a lead’s time | Higher | watch only | Watch only: waits on a Decision, a review or a timer are by design; the share is read as a trend | Time Issues spent working | Time spent working or waiting, for the intervals that ended in the window | Which wait reason takes most of a lead’s time (the parts): that wait is the one to shorten or remove |
| Issues dropped or cancelled after a lead started | Lower | watch only | Watch only: a duplicate or noise Issue is dropped by design; the aim is a falling share | Issues that closed dropped or cancelled after a lead was admitted | Issues that closed in the window after a lead was admitted | Whether intake and triage let work through that nobody wanted: lead time spent on nothing |
| Steward nudges a lead acted on | Higher | watch only | Watch only: a nudge to a lead that is mid-thought rightly gets no verb; no basis for a number | Steward notes followed within 30 minutes by the lead’s own verb | Steward notes sent in the window | Whether the steward’s nudges work: a low share means a nudge is noise or the stalls it chases are not the lead’s to fix |
| Errands the screen turned away | Higher | watch only | Watch only: a high share can also mean leads raise Errands they should not; read beside Errands that reached him | Errands turned away by a rule or the Judge before they reached him | Errands raised in the window | Whether the screen takes work off the owner: a falling share with Errands reaching him means a rule is missing |
| First watch, median time to its answer | Watch only | watch only | Watch only: a pass over watches that answer in seconds checks little, and one that waits an hour slows the queue; no side is right | Median of a first watch’s start-to-answer time | First watches answered in the window | Whether first verification passes mean anything: a pass rate over instant watches is not evidence |
| Quota used at reset | Higher | watch only | Watch only: demand sets the ceiling, not a goal (docs/accounts.md, the v1.9 simulation: at a demand below the pool slack is unavoidable, at or above it every window fills to 91-100 %); read it beside how many Issues waited | The weekly percent each account stood at when its weekly window reset, weighted by the account’s weekly capacity (the reset ledger of packages/accounts) | Account resets in the window, weighted by capacity | Whether the subscriptions are used: a low figure with Issues waiting means the rule leaves quota unspent (docs/accounts.md §The picker); a high one with a long queue means a subscription is missing |
| Issues closed per day | Higher | watch only | Watch only: set by the capacity the host and the subscriptions give, not by a goal; the throughput loop reads the same count | Issues that closed (any outcome; dropped ones show in the dropped share) | Days in the window | Whether the factory moves faster or slower than last week; a fall with a queue behind it sends the capacity loop to the reason |
| Test slot wait, median | Lower | watch only | Watch only: no basis; the capacity loop tunes the slot count from the same waits | Median of a step’s wait for a test slot | Steps that ran in the window | Whether to add a test slot: a long wait means leads idle on a gate |
| Share of minutes over the load ceiling | Lower | watch only | Watch only: the ceiling is the admission guard, not a goal; a share that rises means the guard runs too late | Minutes the host’s load was above its ceiling | Minutes sampled in the window | Whether to lower the ceiling or the lead count: the host is overcommitted when work still runs above it |
<!-- kpi-table:end -->

Each is a count over the window that SQL can repeat (`read/kpis.ts`, `read/kpis-flow.ts`, `apps/server/test/read-models`);
a breakdown (queued time by reason, why first watches regressed) is the KPI's `parts`. The friction counts beside them
(`factory read friction`) are not KPIs: each is a count of waste with a threshold that files a signal
(`domains/loops/friction.ts`). What no table holds (seconds by tool category, idle gaps, tool errors, `make check` runs)
is the transcript pass of `factory retro`. The friction loop's weekly pass files one Issue whose lead reads that bundle,
writes a Report (the numbers against last week, the patterns in a sample of transcripts, the ledger of earlier retro
signals with what each number did) and files one marked signal per change (`docs/architecture.md`, the `friction` loop).

### Fix classes

A fix commit is a commit on a project's default branch whose subject is a conventional `fix`. The `fix-classes` loop sorts
each into one class: by its scope where that settles it, by a workflow that reads the commit otherwise.

| Class | A fix for |
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
