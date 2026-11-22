import type {
  Effort,
  IssueKind,
  IssueOrigin,
  IssueOutcome,
  IssueSize,
  IssueState,
  Tier,
} from '@software-factory/contract'
import type { IssueId } from '../../kernel/ids.ts'

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
  timer: {
    exit: 'machine',
    stall: false,
    ends: 'woken by the clock at the time the lead deferred to, or the end of a backoff the factory gave it',
  },
  dependency: { exit: 'machine', stall: false, ends: 'woken by the chain once every Issue it is after has closed' },
  wall: { exit: 'machine', stall: true, ends: "woken when the account's window opens again" },
  unreported: { exit: 'machine', stall: true, ends: "woken by the lead's next turn or the steward" },
  blocked: { exit: 'machine', stall: true, ends: 'woken by the steward after it re-checks the cause' },
  lead_gone: { exit: 'machine', stall: true, ends: 'woken by the steward: a new attempt' },
  regressed: { exit: 'machine', stall: true, ends: 'woken by the steward, or turned into a Decision' },
  decision: { exit: 'person', stall: false, ends: 'answered by the Judge, a default, or the owner' },
  review: {
    exit: 'person',
    stall: false,
    ends: 'verdict given on the Concept or Spec by the owner, and every Decision the lead raised about it answered',
  },
  errand: {
    exit: 'person',
    stall: false,
    ends: "errand done by the owner's hands (or the orchestrator's, with evidence), or turned back with a note",
  },
  external: {
    exit: 'machine',
    stall: false,
    ends: 'woken by the review poll when the pull request is approved, gets changes requested or a new review comment, merges or closes',
  },
  paused: {
    exit: 'person',
    stall: false,
    ends: "the owner's word (a note with wake), or the time it was paused until; the steward never ends it",
  },
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
  | { reason: Exclude<PersonReason, 'review' | 'paused'>; holds: Checkpoint }
  /** the owner paused it (`issue pause`): it ends with his word, or at `until` when he gave one */
  | { reason: 'paused'; detail: string; until?: string }
  /** a pull request waits on a review by someone else: `holds.id` names it (a URL or `#<number>`), the poll wakes the wait */
  | { reason: 'external'; holds: Checkpoint }
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
  state: IssueState
  /** set exactly when `waiting` */
  wait: Wait | null
  /** set exactly when `closed` */
  outcome: IssueOutcome | null
  repo: string
  title: string
  kind: IssueKind
  origin: IssueOrigin
  /** the seat asked for at filing, resolved; absent: the lead row of the role table */
  seat?: { tier: Tier; effort: Effort; role?: string; moveUp?: true; why?: string }
  /** `spec`: the lead owes a one-page Spec before it builds, and cannot ship without one; `gate`: the same, and only the owner's own verdict ends the wait */
  checkpoint?: 'spec' | 'gate'
  /** triage's size, when it judged one */
  size?: IssueSize
  /** the seat the current attempt's lead started on; absent before its `lead_started` (and on old events) */
  ranOn?: { tier: Tier; effort: Effort; role?: string; rule?: string; moveUp?: true }
  /** times a light lead was moved up: the next lead starts on the lead row, a filed seat that asked for the move-up included */
  movedUp: number
  /** the role table's row the next lead starts on after a move-up that did not go to the lead row (`strong`); absent: the lead row */
  movedTo?: string
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
/** Whether the lead of the current attempt may be moved up: the light rule seated it, or its filed seat asked for the move-up. */
export const movable = (issue: Pick<Issue, 'ranOn'>): boolean => Boolean(issue.ranOn?.rule || issue.ranOn?.moveUp)

/** A closed Issue reopens within this long; after it, file a new one. */
export const REOPEN_WINDOW_MS = 30 * 24 * 60 * 60_000
