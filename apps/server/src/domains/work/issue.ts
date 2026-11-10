import type { Effort, Tier } from '@software-factory/contract'
import type { IssueId } from '../../kernel/ids.ts'

/** The Issue's states, and no others (`docs/architecture.md` §The Issue state machine). */
export const STATES = ['settling', 'queued', 'working', 'waiting', 'watching', 'closed'] as const
export type State = (typeof STATES)[number]

/** What an Issue is (`docs/language.md`, Kind). */
export const KINDS = ['feature', 'bug', 'chore', 'docs', 'incident'] as const
export type Kind = (typeof KINDS)[number]

/** Where it came from, in the words a person uses (`docs/language.md`, Origin). */
export const ORIGINS = ['you', 'application', 'infrastructure', 'github', 'feedback', 'factory'] as const
export type Origin = (typeof ORIGINS)[number]

/**
 * How a closed Issue ended: `done` (shipped and verified, or closed by its lead with the work done), `dropped` (its lead
 * gave it up with a reason), `healed` (an incident that went away before a lead started), `cancelled` (the owner's stop).
 */
export const OUTCOMES = ['done', 'dropped', 'healed', 'cancelled'] as const
export type Outcome = (typeof OUTCOMES)[number]

/** What a person must act on to end a wait: a Decision, an artifact under review, an Errand. */
export interface Checkpoint {
  id: string
  /** one line: the question, the artifact's title, what the owner's hands must do */
  summary: string
}

/**
 * Why a `waiting` Issue waits, and how the wait ends. A wait has a named exit; a stall is a wait with a machine cause,
 * the steward's to end. `exit: 'machine'` ends without a person; `exit: 'person'` needs one and names what it holds.
 */
export const WAITS = {
  timer: { exit: 'machine', stall: false, ends: 'woken by the clock at the time the lead deferred to' },
  dependency: { exit: 'machine', stall: false, ends: 'woken by the chain once every Issue it is after has closed' },
  wall: { exit: 'machine', stall: true, ends: "woken when the account's window opens again" },
  unreported: { exit: 'machine', stall: true, ends: "woken by the lead's next turn or the steward" },
  blocked: { exit: 'machine', stall: true, ends: 'woken by the steward after it re-checks the cause' },
  lead_gone: { exit: 'machine', stall: true, ends: 'woken by the steward: a new attempt' },
  regressed: { exit: 'machine', stall: true, ends: 'woken by the steward, or turned into a Decision' },
  decision: { exit: 'person', stall: false, ends: 'answered by standing policy, the Judge, a default, or the owner' },
  review: {
    exit: 'person',
    stall: false,
    ends: 'verdict given on the Concept or Spec by the owner, and every Decision the lead raised about it answered',
  },
  errand: { exit: 'person', stall: false, ends: "errand done by the owner's hands" },
} as const satisfies Record<string, { exit: 'machine' | 'person'; stall: boolean; ends: string }>

export type WaitReason = keyof typeof WAITS
export const WAIT_REASONS = Object.keys(WAITS) as WaitReason[]
export type StallCause = { [R in WaitReason]: (typeof WAITS)[R]['stall'] extends true ? R : never }[WaitReason]
export type PersonReason = { [R in WaitReason]: (typeof WAITS)[R]['exit'] extends 'person' ? R : never }[WaitReason]

/** A wait as a cell asks for it. A person's wait always holds its checkpoint. */
export type WaitSpec =
  | { reason: 'timer'; until: string }
  /** `watching`: the steward deferred a shipped Issue, so the wake goes back to the watch, not to the lead's work */
  | { reason: 'dependency'; after: IssueId[]; watching?: true }
  | { reason: StallCause; detail: string }
  | { reason: Exclude<PersonReason, 'review'>; holds: Checkpoint }
  /**
   * `holds` is the artifact. The lead may raise Decisions about it while it is reviewed: `decisions` are the ones still
   * open, `verdictGiven` is set once the verdict came first. The wait ends when the verdict is given and none is open.
   */
  | { reason: 'review'; holds: Checkpoint; decisions?: Checkpoint[]; verdictGiven?: true }

/**
 * A wait as the Issue has it. `since` is the version that began it, which a wake must name. `told` is the last version
 * the lead heard: its own verb that began the wait, the version before it when the factory began it, or, when a lead
 * verb from a timed wait began this one, what the timed wait had. What ends the wait tells the lead everything after.
 */
export type Wait = WaitSpec & { since: number; told: number }

/** Whether a review wait still has Decisions raised about its artifact open. */
export const outstandingDecisions = (wait: Wait): boolean =>
  wait.reason === 'review' && (wait.decisions?.length ?? 0) > 0

/** The Issue as its events made it. Counts live here, derived on load; none is a column. */
export interface Issue {
  id: IssueId
  /** rises by one with every applied event; the write path's guard */
  version: number
  state: State
  /** set exactly when `waiting` */
  wait: Wait | null
  /** set exactly when `closed` */
  outcome: Outcome | null
  repo: string
  title: string
  kind: Kind
  origin: Origin
  /** the seat asked for at filing, resolved; absent: the lead row of the role table */
  seat?: { tier: Tier; effort: Effort; role?: string }
  /** the lead number: 0 until admitted, one more with every admission */
  attempt: number
  /** how many times it shipped; the current watch is this number */
  watch: number
  /** attempts restarted because their lead was gone */
  restarts: number
  /** regressions the lead was sent back for */
  regressions: number
  closedAt: Date | null
}

/** A lead that is gone starts the next attempt this many times; the next time is a stall. */
export const MAX_RESTARTS = 2
/** A regression goes back to the lead this many times; the next is a stall. */
export const MAX_REGRESSIONS = 2
/** A closed Issue reopens within this long; after it, file a new one. */
export const REOPEN_WINDOW_MS = 30 * 24 * 60 * 60_000
