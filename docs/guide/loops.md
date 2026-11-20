# Loops

A loop is a recurring job inside the factory server. Four loops file Issues against the factory's own repo, like any other signal source:

- **Friction** counts what leads hit.
- **Hygiene** probes each project's health.
- **Selfwatch** alerts on the factory's own symptoms.
- **The retro** reviews the week.

The steward ends stalls. Yield reports what each loop's signals became. Triggers, budgets and the yield figures are below.

## Loops and passes

A loop is a named recurring job with a trigger, a budget and one way to act. A pass is one run of it.

- **Trigger:** an interval, or a kick when something changed. The clock runs from the last recorded pass, so a server that restarts on every deploy still passes on time.
- **Budget:** one pass at a time (single-flight) unless the loop's `maxPasses` says otherwise, and at most 5 signals per pass for every loop that files work.
- **A pass claims, commits, calls, records.** It claims a row and commits, calls a port outside any transaction, and records the outcome in a new one. A replayed pass acts on the row and outcome the first pass stored.
- **The factory never calls a model.** A loop's judgment, where it has one, is an agw workflow called through a port. The counting comes first and is deterministic.
- **Loop guard:** a change a loop made never kicks that loop again.

```ts
export interface LoopSpec {
  name: LoopName
  /** the clock trigger in ms; 0 turns the loop off: it runs only when asked (`runNow`), and no kick starts it */
  intervalMs: number
  /** an event (`changed`) kicks it besides the clock */
  onChange: boolean
  /** passes that may run at once; 1 (single-flight) unless a pass can take minutes and must not hold the next back */
  maxPasses?: number
  run(): Promise<Result<string, PortError>>
}
```

The rules of each loop live in `domains/loops/` as pure functions over counts and facts. The I/O sits in `app/loops/` and `adapters/`.

**Example files:**

- [`runner.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/app/loops/runner.ts#L5-L18): the loop contract, one `run` per pass.
- [`budget.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/budget.ts#L1-L5): the 5-signal budget every filing loop shares; what is left out is named in the pass record.
- [`loops/`](https://github.com/jkrumm/software-factory/tree/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops): the rules, one file per loop.

## Friction

Friction is any counted waste: an avoidable touch, a refusal, an undelivered note. The friction loop counts the lead events of the last 7 days and files a signal for each pattern over its rule; a pattern whose Issue closed less than 7 days ago is not filed again. A pass also files one signal for the retro when none was filed in the last 7 days (see The retro).

- **A count or a rate.** A serious pattern (a lead that stopped reporting, a lost lead, an undelivered note) files on a bare count. The others need a share of the Issues closed in the window, and only once 10 have closed. Two stalls the steward ends by itself, a lead's block and a full account window, are judged by rate too (3 and one in twenty).
- **Pace:** one pass a day, or sooner when 200 Issues have closed since the last. At 126 to 166 closed a day, a weekly pace would have looked at about a thousand Issues per pass.
- **A refusal is counted by its class, not its text.** The stored text names a commit, a branch or an Issue, so each row was its own key and never added up. `read/refusal-class.ts` gives every refusal a class (`commit_not_on_base`, `waits_for_errand`, `closed`, and so on; an unknown text is its own class by its wording with shas, paths and numbers replaced) and friction sums the rows of one class.
- **One signal per pattern,** with the evidence Issues (five at most) and the command that shows the count again. An open Issue of the same pattern is amended, not doubled.
- **Retired mechanisms are never judged.** The review gate is gone, so its refusals do not count.

```ts
export const THRESHOLDS: Record<Judged, Rule> = {
  refusal: {
    min: 3,
    rate: 0.05,
    why: 'the same class of refusal on one in twenty closed Issues is a rule or a prompt that is wrong (a class sums every sha and branch it named: 60 of 1,000 is a finding)',
  },
  stall: { min: 2, rate: null, why: 'a stall twice in a week is a cause, not weather' },
```

The excerpt is the start of `THRESHOLDS`, not the whole table. `issue_1818` came from the `stall` rule. On 2026-11-17 at 02:06 the loop filed "Stalled because something blocked the lead" (`factory issue show issue_1818 --format json`, 2026-11-17):

```text
Pattern: Stalled because something blocked the lead (stall:blocked)
Window: 2026-11-10T02:05:58.037Z to 2026-11-17T02:05:58.037Z (7 days, …)
Count: 77 (0.07 per Issue closed); Issues filed in the window: 1205, closed: 1183
Threshold: 2 in the window. a stall twice in a week is a cause, not weather.
Reproduce: factory read friction --days 7
```

The lead traced the 77. 47 were one Issue looping: it asked, the Judge answered, it blocked again. 8 were another Issue. Since an earlier fix, 12 blocks in 6 Issues remained. The lead fixed the residual cause and shipped it. One of its three acceptance lines was not met, and said why: the 37 `stall:unreported` and 15 `stall:regressed` were left alone, with reasons. The watch passed at 02:55.

**Example files:**

- [`friction.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/friction.ts#L45-L90): every rule with its minimum, its rate and the reason in one line.
- [`friction.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/friction.ts#L131-L155): `patternsOver`, the counts over their rule, most frequent first.
- [`friction.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/friction.ts#L186-L200): the signal text, which names the window, the count, the threshold and how to look again.

## Selfwatch

Selfwatch looks at the factory itself every 5 minutes and files a signal for a condition that stays true. It watches 14 kinds of condition, all deterministic. The table gives each in short form; the thresholds are in the code (`selfwatch-model.ts`, `overload.ts`).

| Kind | Condition |
|-|-|
| `ci_red` | the two newest completed runs of a workflow on the default branch both failed |
| `migration_clash` | one migration number on two file names across branches |
| `wait_overdue`, `lead_idle` | a wait past its exit; a lead with no report for too long |
| `heartbeat_stale`, `routes_slow` | the leads tick or the database stopped; the server's routes answer with a p95 over two seconds |
| `process_growth`, `swap_growth`, `process_storm`, `load_over_ceiling` | a runaway process, rising swap, too many processes, load over its ceiling (`load_over_ceiling`) |
| `slot_line`, `gates_passed` | a test-slot line that does not move; a lead admitted past a load or memory gate |
| `inert_regression`, `budget_breach` | a regression after a ship of documents or tests only; a project over its budget |

- **A subject has a stable key** (`kind:subject`). The loop remembers each one in a table, so a condition that stays red is one signal, not one per pass.
- **A run of samples, not one.** A slot line is a count over consecutive minute samples, so one busy minute files nothing.
- **A signal's facts are hashed, its context is not.** The clock and counts go in the context, so the fingerprint stays the same while the condition does.

```ts
/** More callers than this waiting for a test slot... */
export const SLOT_WAITERS = 8
/** ...in this many consecutive minutes is a line that does not move. */
export const SLOT_WAIT_MINUTES = 15
```

`issue_1809` is the worked example. The loop saw more than 8 callers waiting for 17 minutes in a row and filed it at 01:03:01 on 2026-11-17. Its text (`factory issue show issue_1809 --format json`, 2026-11-17):

```text
Self-watch slot_line (waiting) … more than 8 callers waited for a test slot in 15 consecutive minutes
17 minutes in a row since 2026-11-17T00:46:07.340Z: 24 waiting now, 24 at most, 1 of 2 base slots held
Reproduce: factory capacity state (the slot lines); factory slot list
```

A lead on sonnet at high effort shipped three commits at 03:04. Of three acceptance lines, one was met. The queue had a head that waited for the whole pass window. A step now lets it pass when it fits beside the running work, which freed the idle base slot. Two were not met, with reasons: the line was not yet proven shorter in production, and a memory-accounting comparison was inconclusive. The watch passed at 03:11.

**Example files:**

- [`selfwatch-model.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/selfwatch-model.ts#L1-L18): the 14 kinds.
- [`overload.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/overload.ts#L68-L118): `slot_line`, with its two thresholds and its title.
- [`selfwatch.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/selfwatch.ts#L41-L60): `ci_red`, the first condition, as pure code over run facts.

## Hygiene

Hygiene is the standing check on a project's health: per-repo probes read a throwaway checkout of the default branch.

- **Probes from a catalogue.** 16 deterministic probes (`check`, `advisories`, `links`, `deps`, `ci`, `agentsmd`, `stale`, `deadcode`, and more) and one agent judgment of the documents. The catalogue is one list in `packages/contract`, and `docs/hygiene.md` is generated from it.
- **Daily and weekly.** A full pass weekly, a daily pass of the probes marked daily. A repo with 30 commits since its last full pass is promoted to a full one.
- **A project declares its own.** `hygiene.probes` in `project.yaml` names a `make` target that is red on any exit but 0.
- **Skips state a reason.** A project skips a probe by name with a reason, and the pass shows it.
- **Budget:** of the 5 signals per pass, the judgment keeps 2, so probes file at most 3.

```ts
/** Slots the judgment keeps: the deterministic findings may take `MAX_SIGNALS_PER_PASS - JUDGMENT_RESERVE`. */
const JUDGMENT_RESERVE = 2
export const MAX_PROBE_SIGNALS = MAX_SIGNALS_PER_PASS - JUDGMENT_RESERVE
```

A finding has a stable key per subject (`links:docs/a.md`), so the same finding next week amends the open Issue.

> [!NOTE]
> A noisy class holds itself back.
> - **Sample:** a class's ten newest decided Issues, at least 3.
> - **Threshold:** more than half dropped or cancelled.
> - **Effect:** the class is held for 14 days, then runs on probation, one Issue at a time, until one closes done.

**Example files:**

- [`hygiene-catalogue.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/packages/contract/src/hygiene-catalogue.ts#L42-L50): the catalogue, one entry per probe with its cadence.
- [`hygiene-model.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/hygiene-model.ts#L12-L29): the probe order and which probes a daily pass runs.
- [`hygiene.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/hygiene.ts#L12-L38): the budget split between probes and judgment.

## The steward and stalls

A stall is a wait with a machine cause, the steward's to end. The steward is the loop that reads every stalled Issue and decides what it needs.

- **Deterministic first.** The rules wake, deliver a note, requeue a lost lead, or move a lead to another account. Only a stall the rules cannot read reaches the `factory-steward` workflow.
- **A young stall waits.** Under 2 minutes, the lead may end it itself.
- **A repeat is the same stall.** The same cause with the same words and no news since a Decision answered it is not asked again. It is held on a growing backoff.
- **A quiet lead is nudged** after 10 minutes of nothing reported, and after 90 when its last turn ended with background work in flight.

`issue_1818` shows the rule's edge. A lead woken by an answer blocked again, worded differently, and the word-overlap test read 0.10 to 0.42 against its 0.5 threshold. The steward asked again, 3 times in 8 minutes on one Issue. The fix: a block within 10 minutes of an answer, with no report between, is the same stall.

```ts
/**
 * A lead woken by a Decision's answer that blocks again this soon, having reported nothing else, did no new work: its block
 * is the stall the answer settled, however it words it ("Still paused: the Judge answered ..." reads 0.1 to 0.4 alike to
 * the block before it, which is how one stand-down was asked 47 times).
 */
export const QUICK_REBLOCK_MS = 10 * 60_000
```

**Example files:**

- [`stall.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/stall.ts#L91-L126): `decideStall`, the rules in order, ending in `ask`.
- [`stall.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/stall.ts#L63-L70): the default thresholds in one table.

## The retro

The retro is a weekly review written by a lead. The friction pass files one retro signal when none was filed in the last 7 days. The retro's lead reads the numbers and the lead transcripts, and writes a Report.

- **`factory retro` holds every number.** The lead reads and judges, it does not recount: `factory retro --days 7 --format json` is the bundle (no model), and the figures are the same ones the Console shows.
- **A recommendation is a signal** with a marker (`Retro: <date> kpi=<key> before=<value> direction=<up|down>`), so the next retro finds it.
- **The ledger.** Each retro states for every earlier recommendation whether it shipped and what its number did.
- **A pattern needs a line.** A pattern the lead names without a cited transcript line is not in the Report.
- **A repeated preference becomes a rule.** A preference the owner showed twice in the owner's verdict notes is written into the repo's `AGENTS.md` or `DESIGN.md`.

```ts
/** The previous retros' yield in a line for the signal's facts; null when no retro signal was filed in the window. */
function outcomesLine(outcomes: RetroOutcomes | null): string | null {
  if (!outcomes || outcomes.signals === 0) return null
  const none = outcomes.signals - outcomes.shipped - outcomes.done - outcomes.dropped - outcomes.open
  const parts = [
    `${outcomes.shipped} shipped`,
    `${outcomes.done} closed done without a ship`,
    `${outcomes.dropped} dropped or cancelled`,
    `${outcomes.open} still open`,
  ]
```

**Example files:**

- [`retro.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/retro.ts#L22-L33): the previous retros' yield, put in the next signal's facts.
- [`retro.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/retro.ts#L39-L60): the signal's text, the brief a retro lead builds from.

## Yield and pace

A loop's yield is what its signals became: the passes it ran, the signals it filed, the Issues those reached and how they ended. The factory reads it per loop over 7 and 30 days, so a loop that files noise shows up as dropped Issues.

`factory read loop-yield`, 7-day window, 2026-11-17:

| Loop | Passes | Signals | Issues | Done | Dropped | Open | Median to close |
|-|-|-|-|-|-|-|-|
| friction | 2 | 10 | 8 | 8 | 0 | 0 | 53 min |
| hygiene | 33 | 52 | 50 | 34 | 2 | 11 | 32 min |
| selfwatch | none | 37 | 26 | 21 | 4 | 1 | 54 min |
| throughput | none | 10 | 10 | 5 | 4 | 1 | 57 min |

- **Selfwatch and throughput keep no row per pass,** so their passes are null.
- **Friction shows 2 passes** because its pace was weekly until #420 made it daily, on 2026-11-17.
- **A test restates every figure** in plain rows, so a drifting read model fails.

**Example files:**

- [`architecture.md`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/docs/architecture.md#L677-L701): the loops and what each does deterministically and what it asks agw.
- [`architecture.md`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/docs/architecture.md#L724): "What each loop yields", the read model.
- [`loop-yield.test.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/test/read-models/loop-yield.test.ts): every figure restated in plain rows.

**Read more:**

- [Loops and agw](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/docs/architecture.md#L677-L690): the runner, the clock, the call record.
- [The words Loop and Pass](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/docs/language.md#L72-L73): what the factory means by them.
- [Hygiene catalogue](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/docs/hygiene.md): every probe, its cost and how to silence it.

Next: [Learnings](./learnings.md)
