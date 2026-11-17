# Issues

An Issue is one row with one total transition table. Facts are stored as events, its state is derived from them, and every effect carries a deterministic key, so a replayed pass does not act twice.

## The Issue

An Issue is one unit of work: one repo, one branch, one ship.

- **One repo.** The repo is stored as its project name, never a path. A second directory whose name is already taken is stored as `<name>~<hash>`.
- **One branch per attempt.** A lead works on `factory/<issue number>-<attempt>`, cut from the repo's default branch.
- **One ship at a time.** The lead lands and deploys once per ship. A regression sends the Issue back to work, and a later ship starts a new watch of the same Issue.
- **A GitHub issue is a signal**, not an Issue. [Signals and Triage](./signals.md) covers how one becomes the other.
- **Kind** is `feature`, `bug`, `chore`, `docs` or `incident`. This is the Issue's kind, not the signal's. Intake files a request signal as a `feature` Issue; triage may refine the kind while it settles the Issue.

The row holds the state, the wait reason, the outcome and a version. Everything else is read from the events.

```ts
export const STATES = ['settling', 'queued', 'working', 'waiting', 'watching', 'closed'] as const
```

**Example files:**

- [`domains/work/issue.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/work/issue.ts#L4-L25): states, kinds, origins, sizes and outcomes
- [`domains/leads/names.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/leads/names.ts#L18-L19): `leadBranch`, the branch of one attempt

## Events

An event is a fact recorded on an Issue, stored with who sent it and what it did. State is derived from events, never the other way.

- **24 kinds.** Each has a zod payload in `PAYLOADS`; a payload that does not parse is refused.
- **A sender per kind.** `SENDERS` names who may send each one. The owner is never the only way out of a machine wait.
- **An attempt, a watch, a wait or a checkpoint.** An event that names one is for that one only. A late event from the factory is ignored; a late one from a lead is refused.
- **Stored in `issue_events`** with the key, the actor, the result, the version and the transition it caused.

| Group | Events |
|-|-|
| Filing and starting | `filed`, `settled`, `admitted`, `lead_started`, `lead_gone`, `seated` |
| Notes | `noted` |
| Checkpoints | `asked`, `answered`, `submitted`, `verdict_given`, `errand_raised`, `errand_done`, `errand_turned_back` |
| Waits | `deferred`, `stalled`, `moved_up`, `woken` |
| Shipping | `shipped`, `watch_passed`, `regressed` |
| Ending | `reopened`, `cancelled`, `closed` |

The senders are `factory`, `owner`, `orchestrator`, `lead`, `steward` and `judge`. A lead cannot send `settled` or `watch_passed`; the factory alone does.

The excerpt below is the start of `SENDERS`, not the whole map.

```ts
export const SENDERS: { [K in EventKind]: readonly Actor[] } = {
  filed: ['factory', 'owner', 'orchestrator'],
  settled: ['factory'],
  admitted: ['factory'],
  lead_started: ['factory'],
  lead_gone: ['factory'],
  seated: ['owner', 'orchestrator'],
  noted: ['owner', 'orchestrator', 'factory', 'steward', 'judge'],
```

**Example files:**

- [`domains/work/events.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/work/events.ts#L21-L131): `PAYLOADS`, every event with its payload
- [`domains/work/events.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/work/events.ts#L147-L173): `SENDERS`, who may send each

## The transition table

The transition table answers one question for every pair: what does this state do with this event? It is total, so a state or an event added later fills every cell or `tsc` fails.

- **Three answers.** A cell moves (to the same state too: the event is recorded), refuses with a named reason, or ignores with the reason it changes nothing.
- **Pure.** The same Issue, event and time give the same answer. `apply` makes no call and reads no clock but the one it is given.
- **Effects are data.** A move lists the effects it asks for (`start_lead`, `note_lead`, `start_watch`, `finalize`). The write path stores them in an outbox in the same transaction.
- **The diagram is generated.** The state diagram and the wait table in `docs/language.md` come from `TABLE`, and `make check` fails when they are stale.

```ts
export type Cell =
  | { to: 'waiting'; wait?: WaitSpec; update?: WaitSpec; effects: Effect[] }
  | { to: 'closed'; outcome: Outcome; effects: Effect[] }
  | { to: 'settling' | 'queued' | 'working' | 'watching'; effects: Effect[] }
  | { refuse: string }
  | { ignore: string }

/** The total table: every state takes every event. A missing cell fails `tsc`. */
export type Table = { [S in State]: { [E in EventKind]: (ctx: Ctx<E>) => Cell } }
```

Six states times 24 events is 144 cells. A queued Issue shows what most of them look like: it takes `admitted` and says why it takes almost nothing else. The excerpt below is the start of its row:

```ts
  queued: {
    filed: said('it is filed already'),
    settled: said('it is settled already'),
    admitted: admit,
    lead_started: factoryNews('queued'),
    lead_gone: factoryNews('queued'),
```

**Example files:**

- [`domains/work/table.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/work/table.ts#L28-L36): `Cell` and `Table`, the type that makes it total
- [`domains/work/table.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/work/table.ts#L396-L448): `settling` and `queued`, every event of two states
- [`domains/work/machine.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/work/machine.ts#L125-L144): `apply`, the one decision

## States and where work stands

A state is the stored name of where an Issue is. A screen never shows it. It shows one of five words, defined once and derived by `workOf`.

| Stored state | Screen word |
|-|-|
| `settling` | Held (triage is not done) |
| `queued` | Ready, or Held by its queue reason |
| `working` | Running |
| `waiting` | Paused |
| `watching` | Checking |
| `closed` | nothing: it is no longer open |

A plan row not yet filed is Planned. It is never an Issue, so it is never part of the five.

- **A word is a view.** `workOf` reads the stored state, the wait and the queue reason. `Running + Paused + Ready + Held + Checking` is the number of open Issues on every surface.
- **A wait has a reason, and each reason has a named exit.** The reasons are `timer`, `dependency`, `wall`, `unreported`, `blocked`, `lead_gone`, `regressed`, `decision`, `review`, `errand` and `external`; `WAITS` holds each exit. A machine wait ends without a person. A stall is a wait with a machine cause, and the steward ends it.
- **Screens do not name states.** `scripts/vocabulary.ts` fails `make check` when a screen's text says `queued` or `working`.

```ts
export const WORK_WORDS = ['running', 'paused', 'ready', 'held', 'checking'] as const
```

**Example files:**

- [`contract/src/work-words.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/packages/contract/src/work-words.ts#L78-L99): `workOf`, a stored state to one of the five words
- [`domains/work/issue.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/work/issue.ts#L34-L60): `WAITS`, each wait with its exit and how it ends

## Outcomes

An outcome is how a closed Issue ended.

| Outcome | Means |
|-|-|
| `done` | shipped and verified, or closed by its lead with the work done |
| `dropped` | the lead gave it up, with a reason |
| `healed` | an incident that went away before a lead started |
| `cancelled` | stopped by the owner, or withdrawn by the filer |

A closed Issue opens again only by `reopened`, within 30 days.

```ts
export const OUTCOMES = ['done', 'dropped', 'healed', 'cancelled'] as const
```

**Example files:**

- [`domains/work/issue.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/work/issue.ts#L20-L25): the four outcomes

## Deterministic keys

A key is built from the parts of a thing, so the same parts give the same key in every process. Effects, events, prompts, notes and terminal labels all have one.

- **One builder.** `key(...parts)` joins its parts with `:`, escapes `%` and `:` inside a part, and refuses an empty part or a fractional number.
- **Effects.** `start_lead:<issue>:<attempt>`, `note_lead:<issue>:<version>`, `start_watch:<issue>:<watch>`, `finalize:<issue>:<attempt>`. A second plan of the same attempt is a no-op.
- **Events.** `issue_events.key` is unique, and the insert is `ON CONFLICT (key) DO NOTHING`. An event sent twice is stored once.
- **Notes.** A note carries its source and its subject, for example `noted:steward:<issue>:<since>`, so a replayed loop pass sends no note twice.
- **Terminal labels.** A lead's name is `lead-<issue number>-<attempt>`. The terminal's label, the `FACTORY_SESSION` its hooks report under and the spool file all carry it.
- **Look, then act.** The Runner looks for the effect's result before it calls the port.

```ts
export const startLead = (issue: IssueId, attempt: number): Effect => ({
  kind: 'start_lead',
  key: key('start_lead', issue, attempt),
  payload: { attempt },
})
```

**Example files:**

- [`kernel/keys.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/kernel/keys.ts#L1-L26): `Key` and `key`
- [`domains/work/effects.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/work/effects.ts#L35-L71): the four effects and their keys
- [`domains/leads/names.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/leads/names.ts#L1-L7): `leadKey`, the name that labels a terminal
- [`adapters/postgres/work-store.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/adapters/postgres/work-store.ts#L115-L128): `appendEvent`, one row per key

## Facts are stored, state is derived

An Issue's state is the result of its applied events. The row keeps it, because the `version` guards the write. A count or a timer that the event log can answer is never a column.

- **One writer.** `app/` stores the event, the new state and the effects in one transaction. The update is `WHERE id = … AND version = …`; a second writer that read the same version matches no row and loses.
- **Counts and durations come from events.** `evolve` counts attempts, watches, restarts and regressions as events apply. A duration is a difference of two event times.
- **A load replays, it does not decide again.** Each applied event stores the transition it caused, so `replay` rebuilds the Issue from its log and refuses a log that does not begin with `filed` or skips a version.
- **No port inside a transaction.** A pass claims a row and commits, calls the port, and records the outcome in a new transaction.

The version-guarded update:

```ts
    async updateIssue(issue, expected) {
      const rows: unknown[] = await tx`
        UPDATE factory.issues
        SET state = ${issue.state}, wait_reason = ${issue.wait?.reason ?? null}, outcome = ${issue.outcome}, version = ${issue.version}
        WHERE id = ${issue.id} AND version = ${expected}
        RETURNING id`
      return rows.length === 1
    },
```

**Example files:**

- [`adapters/postgres/work-store.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/adapters/postgres/work-store.ts#L106-L113): the version-guarded update
- [`domains/work/machine.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/work/machine.ts#L146-L158): `replay`, the Issue from its applied events

## issue_1809, end to end

`factory issue show issue_1809 --format json`, 2026-11-17. Times are UTC and the Issue is of the repo `software-factory`. The table is a summary of the events, not verbatim output.

| Time | Event | What happened | Chapter |
|-|-|-|-|
| 01:03:01 | `filed` | The selfwatch loop's signal became an Issue: outcome `filed`, source `agent:software-factory`, kind `request` | [Signals and Triage](./signals.md) |
| 01:03:07 | `settled` | Six seconds later triage was done: "Settled; not started yet." | [Signals and Triage](./signals.md) |
| 02:13:33 | `admitted` | 1 h 10 min in the queue, then capacity let a lead start | [Capacity](./capacity.md) |
| 02:14:28 | `lead_started` | `lead-1809-1`, on sonnet at high effort | [Leads](./leads.md) |
| 03:04:20 | `shipped` | 3 commits, review `covered`, 3 acceptance lines; the watch began | [Gates](./gates.md) |
| 03:05:52 | check `blocked` | "CI is still running for a36e5f0" | [Gates](./gates.md) |
| 03:11:00 | check `green` | "All 4 checks passed." | [Gates](./gates.md) |
| 03:11:00 | `watch_passed` | The watch answered `passed`; the Issue closed `done` | [Gates](./gates.md) |

The ship record carries the facts the gate read:

- **Commits:** `a36e5f0`, `5722d2a`, `ffc53fd`, result `accepted` on attempt 1.
- **Review:** present, `covered`.
- **Acceptance:** one line `met`, two `not_met`, each with its reason.
- **Watch:** began 03:04:28, answered `passed` at 03:11:00.

The two lines the lead did not meet, quoted from the record (cut with `…`):

```text
not_met: the line is not proven shorter in production yet; part of the saturation is real (22.6 leads
         running on average today against 13 the days before), so slot_line can still fire; read …
not_met: learned peaks are summed ps RSS while free memory is Activity-Monitor accounting; a footprint
         comparison from 24 h of host_class_samples was inconclusive, so the accounting is unchanged
```

The change shipped. The two claims it could not prove stay on record as not met, each with its reason. The first line, the one the change did prove, names the fix. A step now passes a head frozen for the whole pass window when the head still fits beside it.

The Issue's insights, from the same read: 2 h 8 min from filed to closed, 12.7 minutes of lead working time over 8 turns, 3 subagents, models `claude-haiku-5-5` and `claude-sonnet-5-5`, 47,619 output tokens and a cost of 2.19 dollars. One attempt. The read shows no Decision, no Errand and no note.

**Example files:**

- [`domains/work/table.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/work/table.ts#L396-L555): `TABLE`, the cells this timeline walked through

**Read more:**

- [`docs/architecture.md` The Issue machine](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/docs/architecture.md#L64-L83): one writer, the review wait, the model test
- [`docs/language.md` Events](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/docs/language.md#L174-L205): every event, what it means and who sends it
- [`docs/language.md` Where work stands](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/docs/language.md#L46-L60): the five words and Planned

Next: [Leads](./leads.md)
