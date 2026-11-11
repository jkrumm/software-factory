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
| Console (this repo) | Needs you, Flow, Chain, Improve, Issue and artifact pages. A PWA on the tailnet |
| Herdr | Working in terminals, plus a glance that links to the Console |
| Iris | A Hermes interface. Later it renders UI components, so an artifact can appear inside it |
| Hermes | Conversation: files signals, reads state, never decides the factory's work |
| Argo | Personal dashboards and deep data. The factory reads its usage schema, it does not copy it |
| ntfy | The line to the owner when away, for checkpoints only. Work the factory settles never pages |

## How we know it works

Read in 7-day windows, on the Console's Improve screen.

| KPI | 2026-11-07 | Target |
|-|-|-|
| Avoidable touches per Issue | about 0.25 | 0.05 to 0.07 |
| Asks per Issue | 0.17 | 0.05 to 0.07 |
| Decisions the owner marks worth asking | 2 of 13, read by hand | at least 80% |
| First verification passes | 91% | at least 90% |
| Refusals per Issue | 1.18 | at most 0.25 |
| Cycle p50, queue wait p90 | 37 min, 8.8 h | set after parallel leads |
| Fix commits per week, by class | measured from the first pass of the `fix-classes` loop, four weeks on Improve | falling |
| Specs, and Decisions the owner answered himself, per 100 Issues | not measured | trend only; two near-zero lines mean the path is silent |
| Window points per Issue | not measured | trend only |
| Queued time by reason, idle capacity behind a queue, working share of a lead's time, Issues dropped or cancelled after a lead started | from the event log and the capacity readings | trend only |
| Signals that amended an Issue, steward nudges a lead acted on, forced note delivery delay, Errands the screen turned away | from the intake, the event log and the delivery log | trend only |
| First watch dwell, regressed first watches by cause | from the watch tables | read beside first verification passes |

Each is a count over the window that SQL can repeat (`read/kpis-flow.ts`, `apps/server/test/read-models/kpis-flow.test.ts`); a breakdown (queued time by reason) is the KPI's `parts`. What no table holds (seconds by tool category, idle gaps, tool errors, `make check` runs) is the transcript pass of `factory retro`. The friction loop's weekly pass files one Issue whose lead reads that bundle, writes a Report (the numbers against last week, the patterns in a sample of transcripts, the ledger of earlier retro signals with what each number did) and files one marked signal per change (`docs/architecture.md`, the `friction` loop).

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
