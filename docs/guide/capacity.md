# Capacity

Capacity decides when a Ready Issue gets a lead. Admission reads measured resources: the host's memory and load, the learned peak of each repo's leads, the test slots and every account's windows. It decides again at every claim. The few fixed caps (leads per account, processes) are raised when the host is idle. The sections below cover the refusal order, the queue reasons, test-slot grants and one slot Issue diagnosed from production.

## Admission

Admission is the pure function that answers, for one Issue the chain lets through, whether a new lead may start now.

- **First no wins.** The rules run in a fixed order and the first refusal is the answer. The order is the `REFUSALS` list.
- **Pure.** `checkAdmission` takes the readings as arguments and touches nothing. The caller reads the host, takes a claim and records the outcome in one transaction.
- **Never spills.** With every account closed the answer is to wait for the first opening, never to start on a metered key.
- **Urgent passes.** A fix for a red production skips the test line and the lane cap. It takes the one place beyond `leads`.

![Admission as a data flow: the chain, the host and test line, and the repo and accounts feed checkAdmission, whose first refusal becomes a queue reason and whose clear answer starts a lead.](./diagrams/admission-dataflow.svg)

<!-- snippet: apps/server/src/domains/capacity/admission.ts REFUSALS -->
```ts
const REFUSALS = [
  'drain',
  'doctor',
  'boot',
  'load',
  'memory',
  'disk',
  'tests',
  'lane',
  'claim',
  'window',
  'cap',
] as const
```

**Example files:**

- [`admission.ts` L26-L38](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/admission.ts#L26-L38): the refusals in the order they are looked at.
- [`admission.ts` L154-L206](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/admission.ts#L154-L206): `checkAdmission`, one `if` per refusal, then the account pick.

## Queue reasons

A queue reason is the one plain sentence that says why a Ready Issue has no lead yet, with the numbers of the reading that refused it.

Two groups share the field. The chain answers first with `chain`, `line`, `finalizing`, `spec` and `unknown_project`: the Issue is Held, whatever the host has free. The eleven refusals above are the second group: the Issue is Ready and capacity alone keeps it out.

| Kind | The sentence says |
|-|-|
| `drain` | the queue is draining: nothing new starts |
| `doctor` | the project's own `doctor:` command reports a missing prerequisite |
| `boot` | the host booted recently and has not yet been calm for five minutes |
| `load` | load over the ceiling in each of the last 5 minutes, or too many processes |
| `memory` | swapouts or swap over their ceilings, the repo's learned lead cannot fit the free memory at all, or as many leads run as the lead aim allows at the host's pressure now |
| `disk` | a worktree of the repo, with its build output, does not fit the free disk beside the leads still growing, and a lead already runs |
| `tests` | more steps wait for a test slot than run, for longer than a step takes |
| `lane` | the repo's cap on a resource is full |
| `claim` | the repo runs `leads` leads already |
| `window` | every account is closed; the sentence names when the first opens |
| `cap` | every open account is at its lead cap |

Each sentence names the figures it compared where there are any. The `tests` sentence is built from two measured sides, the line now and the median step of the last day:

<!-- snippet: apps/server/src/domains/capacity/admission.ts lineRefusal -->
```ts
  return (
    `the test line is long: ${line.waiters} steps wait for a slot beside ${line.holders} running, half of them for over ` +
    `${minutes(line.medianWaitMs)}, longer than the ${minutes(line.stepMs)} a step takes (median of the last day)`
  )
```

**Example files:**

- [`admission.ts` L233-L239](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/admission.ts#L233-L239): `lineRefusal`, the `tests` reason.
- [`queue-state.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/queue-state.ts): the three queue states, `run`, `pace` and `drain`.

## Host

The host is the machine the leads run on, read once a minute: swapouts, swap in use, load, process count.

- **Memory is two numbers.** `memory_pressure` and the free-page share mislead (65 % free with swap nearly full). Admission reads the swapout rate over 300 seconds (ceiling 2048 MiB) and swap in use as a share of RAM (ceiling 75 %). The reserved memory of a heavy lane counts as swap already in use.
- **Load is a tripwire.** The ceiling is 3 per core. A lead is refused only when the load is over the ceiling now and was over it in each of the last five minute samples. On 2026-11-14 to 16, against a ceiling of 36 on 12 cores, the load went over it for one minute 174 times, for two minutes 27 times, for five minutes never.

<!-- snippet: apps/server/src/domains/capacity/host.ts SUSTAINED_LOAD_SAMPLES -->
```ts
export const SUSTAINED_LOAD_SAMPLES = 5
```

`factory capacity get --format json`, 2026-11-17, trimmed (other repos renamed):

```json
{
  "host": {
    "load": 61.6, "loadCeiling": 36,
    "memory": { "swapoutMbPer300s": 0, "swapUsedPct": 3.6 },
    "memoryCeilings": { "swapoutMbPer300s": 2048, "swapUsedPct": 75 }
  },
  "slots": { "total": 2, "max": 8, "held": 6, "waiting": 7 }
}
```

`held` and `waiting` are lists in the output, shown here as their lengths.

A load of 61.6 against a ceiling of 36 refuses nothing by itself. A reading back under the ceiling clears the tripwire at once.

**Example files:**

- [`host.ts` L39-L58](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/host.ts#L39-L58): `overMemory` and the measured basis of the tripwire.
- [`host.ts` L70-L84](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/host.ts#L70-L84): `loadTrip`.
- [`host.ts` L90-L96](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/host.ts#L90-L96): the per-core ceiling and the process cap.

## Seats and accounts

A seat is one lead an account may carry at once. An account is a Claude login with a 5-hour window and a weekly window.

- **The package decides.** Whether an account takes a lead, why not, when it opens again and the order of the open ones are `packages/accounts`' rule (`claude-account status`), read in the server's process on every poll: its ceilings, reset timing, Fable, drain and pause modes and weekly pace. The server keeps no limit of its own.
- **The pick.** Among open accounts below their cap, the first in the package's order for the bulk lane wins. A reading the poll has not renewed for ten minutes admits nothing.
- **Paced by sample.** An account whose 5-hour window is above 70 % takes one new lead per usage sample, because a lead started after the latest sample is not in it yet.
- **The idle raise.** When work is queued behind the cap and each of the last five minute samples shows a load of at most a quarter of the ceiling and swap below its ceiling, `allowanceBonus` lifts every cap by as many typical leads as fit into the free memory. The lift stops at the bonus limit or when no work waits.

The same reading, accounts only (account names changed):

```json
{ "account": "account-a", "weeklyUsed": 65, "fiveHourUsed": null, "open": true, "leads": 16, "cap": 20 }
{ "account": "account-b", "weeklyUsed": 80, "fiveHourUsed": null, "open": true, "leads": 1,  "cap": 10 }
{ "account": "account-c", "weeklyUsed": 64, "fiveHourUsed": 18,   "open": true, "leads": 11, "cap": 10 }
```

`account-a` carries 16 leads against a cap of 20. `account-c` carries 11 against 10. Caps differ per account and include the idle raise. A lead resumed from a wait counts for its account, and the cap never refuses a resume.

**Example files:**

- [`accounts.ts` L77-L107](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/accounts.ts#L77-L107): `pickAccount`.
- [`seats.ts` L21-L39](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/allowance.ts#L21-L39): `allowanceBonus`, the idle host's raise.

## Claims and lanes

A claim is a lead's place in its repo. A lane is a resource inside a repo with its own cap.

- **`leads: N`** in `project.yaml` is the repo's claim count, plus one place that only a fix may use.
- **Owed first.** A wait that needs a person, a clock or another Issue gives the claim back. When the wait ends the Issue is owed: it works without a claim and is served before any new lead, in order of wait end, then Issue number.
- **A stall keeps the claim.** A wall, an unreported stop or a block leaves the lead alive, so it keeps its place and the steward ends the stall.
- **Lanes cap a class.** `lanes: {apple: 1}` lets one Apple lead run in the repo at once, within `leads`. An undeclared lane is unlimited.

<!-- snippet: apps/server/src/domains/capacity/claims.ts CLAIM_FREEING_WAITS -->
```ts
const CLAIM_FREEING_WAITS: ReadonlySet<string> = new Set([
  'timer',
  'dependency',
  'decision',
  'review',
  'errand',
  'external',
  'paused',
])
```

**Example files:**

- [`claims.ts` L22-L75](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/claims.ts#L22-L75): `claimOrder` and `claimRoom`, the total order and the room.
- [`claims.ts` L76-L96](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/claims.ts#L76-L96): which waits free a claim.
- [`lanes.ts` L12-L26](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/lanes.ts#L12-L26): `laneRoom`.

## Test slots

A test slot is a lease on the host's test capacity that `factory slot run` takes for a `make check`, a test or an e2e step.

- **Lease and poll.** A holder renews within 30 seconds or loses the slot. A waiter asks again within 15 seconds or drops out of the line.
- **Base slots start on memory alone, until the load tripwire trips.** The first two slots start whatever one peak of the load, when the step's learned peak fits the free memory or is not known yet. A slot beyond them also needs the load under its ceiling, a known peak and room in the cores. While swap in use is growing, or while the load has been over its ceiling for five minutes on end, a second step does not start at all: the first step always does, so the line moves one at a time.
- **A step is sized by its past.** The grant reads the learned peak of the step by name. A step with none gets a guess from the same project, and says so in its wait line.
- **The line is not first come, first served.** Slots go in the order of asking plus the step's learned run time, so a short step passes a long one. A waiter passed for ten minutes has its memory reserved: a step passes it only when it fits now and is learned to end before the memory is free for the waiter (the running steps' learned remaining runtime), or when the head still fits beside the step (see "A capacity Issue").

Every step named `<repo>-apple` takes one slot at a time across all repos, because the simulators and the signing keychain belong to the host. The wait reasons are `slots`, `memory`, `swap`, `load`, `unsized`, `line`, `cores` and `class`. A memory refusal is arithmetic. A base slot keeps no headroom, a slot beyond the base keeps `headroomMib` free:

<!-- snippet: apps/server/src/domains/capacity/slots.ts decide -->
```ts
  const room = holders < base ? 0 : fit.headroomMib
  const fits = known && peakMib + fit.growthMib <= freeMib - room
```

From the same reading as above, 2026-11-17 (other repos renamed):

```text
test slot wait "repo-a make check": waiting for memory: needs 4.9 GiB (learned from the last runs), 2.4 GiB free after 4.7 GiB the running steps still grow, headroom 2.6 GiB (passed by "repo-b bun test" since 8 min; after 10 min its memory is reserved and only a step that ends before its start passes it)
```

The step needs 4.9 GiB and 2.4 GiB are free after headroom, so it waits. The passing window closes in two minutes.

**Example files:**

- [`slots.ts` L170-L231](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/slots.ts#L170-L231): `decide`, the grant rules for one step.
- [`slots.ts` L426-L457](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/slots.ts#L426-L457): the line: who passes whom, and the freeze.
- [`slot-aim.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/slot-aim.ts): the aim that adds a slot when the host has been quiet for five minutes.

### A capacity Issue

issue_1809 is a capacity Issue in this repo. The selfwatch loop filed it at 01:03:01 on 2026-11-17: more than eight callers had waited for a test slot for fifteen minutes.

Its evidence:

- 24 waiting and 1 of 2 base slots held.
- The host at load 10.9 of a ceiling of 36, 28 of 40 seats and swap at 2.2 %.
- A base slot sat empty while the head of the line, which needed 3.4 GiB, was refused: 5.0 GiB free after growth minus 2.6 GiB of headroom left it 1.0 GiB short.

The head had been passed for ten minutes, so nothing passed it. The freeze exists so small steps cannot keep a big one out for ever. It did not ask whether the head fits once the holders granted before the passing began have ended and freed their memory. A freeze that waits for a fit the code can compute idles a slot for nothing.

The fix, `headFitsBeside`, computes it: a frozen head is passed anyway when the head and the step still fit together once the earlier holders have released their memory.

<!-- snippet: apps/server/src/domains/capacity/slots.ts headFitsBeside -->
```ts
function headFitsBeside(
  head: SlotRow,
  step: SlotRow,
  held: readonly SlotRow[],
  fit: SlotFit,
  headroomMib: number,
): boolean {
  const headMib = fit.peaksByName?.get(head.name) ?? null
  const stepMib = fit.peaksByName?.get(step.name) ?? fit.peakMib
  if (headMib === null || stepMib === null || fit.freeMib === null || head.passedAt === null) return false
  const passedAt = head.passedAt.getTime()
  const before = (row: SlotRow): boolean => row.grantedAt !== null && row.grantedAt.getTime() < passedAt
  const released = held.filter(before).reduce((sum, row) => sum + (row.rssMib ?? 0), 0)
  // what the holders that stay (the passers) will still take on, as the head's own fit counts the growth of every holder
  const staying = held
    .filter((row) => !before(row))
    .reduce((sum, row) => sum + Math.max(0, (fit.heldPeakById?.get(row.id) ?? 0) - (row.rssMib ?? 0)), 0)
  return headMib + stepMib + staying + headroomMib <= fit.freeMib + released
}
```

`factory issue show issue_1809`, 2026-11-17:

- Settled at 01:03:07, admitted at 02:13:33 (70 minutes in the queue), a lead on sonnet at high effort at 02:14:28.
- Shipped at 03:04:20 with three commits (`a36e5f0`, `5722d2a`, `ffc53fd`), review covered. The commit touches 4 files, +77 and -3, with one boundary test.
- One of three acceptance lines met. The line was "not proven shorter in production yet", and a footprint comparison of learned peaks was inconclusive.
- Verify blocked at 03:05:52 (CI still running), green at 03:11:00.

**Example files:**

- [`slots.ts` L233-L258](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/slots.ts#L233-L258): `headFitsBeside`.
- [`slots.ts` L440-L445](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/slots.ts#L440-L445): where the freeze consults it.

## Learned cost

A learned cost is what a repo's lead takes in memory outside test slots, read from its past attempts.

- **Median of ten.** The cost of a new lead is the median of the newest ten attempts' peak memory. A lead's peak is a burst, not a size it holds: over 2026-11-15 to 17 the lead class held a mean 4.6 GiB across 13 to 22 running leads. Reserving every repo's p80 for each candidate kept leads out for 159 hours. Memory cost the host 0.7 idle allowance-hours.
- **Three to know.** With fewer than three attempts nothing is learned, and the memory refusal does not apply.
- **A falling peak is trusted sooner.** When the newest three settled attempts all peak below the median, the largest of them is the cost. Admitting too early is caught by the swap ceilings and the slot grant; admitting too late idles seats.
- **Young leads still grow.** A lead younger than two minutes counts at its repo's learned size less what it holds, so one pass cannot admit several leads against one reading.

<!-- snippet: apps/server/src/domains/capacity/leadcost.ts learnedLeadMib -->
```ts
export function learnedLeadMib(attemptPeaks: readonly number[]): number | null {
  const newest = attemptPeaks.slice(0, PEAKS_KEPT)
  if (newest.length < PEAKS_NEEDED) return null
  const sorted = [...newest].sort((a, b) => a - b)
  return sorted[Math.ceil(LEAD_SHARE * sorted.length) - 1] ?? null
}
```

**Example files:**

- [`leadcost.ts` L142-L177](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/leadcost.ts#L142-L177): the share, the median and the falling rule.
- [`leadcost.ts` L194-L210](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/leadcost.ts#L194-L210): `leadGrowth`.
- [`admission.ts` L251-L270](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/admission.ts#L251-L270): `fitRefusal`, the learned cost against the free memory.

**Read more:**

- [Capacity and leads](https://github.com/jkrumm/software-factory/blob/master/docs/architecture.md#capacity-and-leads) in `docs/architecture.md`.
- [Work](https://github.com/jkrumm/software-factory/blob/master/docs/language.md#L7-L46) and [The host](https://github.com/jkrumm/software-factory/blob/master/docs/language.md#L151-L162) in `docs/language.md`.
- [Lanes](https://github.com/jkrumm/software-factory/blob/master/docs/plan.md#L121-L164) in `docs/plan.md`.

Next: [Chains and Plans](./chains.md)
