import type {
  HygieneAnswer,
  HygieneFinding,
  HygieneRequest,
  QueueAnswer,
  QueueRequest,
  StewardAnswer,
  StewardStall,
  TriageAnswer,
  TriageCandidate,
  TriageRequest,
} from '@software-factory/contract'
import type { IssueId } from '../../kernel/ids.ts'
import type { Key } from '../../kernel/keys.ts'
import type { PortError, Result } from '../../kernel/result.ts'
import type { CallLoop, CallOutcome, CallRow } from './calls.ts'
import type { SweepReport } from './hygiene-model.ts'
import type { QueueAskRow, QueueEdge, RefusedEdge, QueueIssue } from './queue.ts'

/** One weekly friction pass as recorded (`migrations/0950_friction.sql`). */
export interface FrictionPassRecord {
  id: string
  at: Date
  windowFrom: Date
  windowTo: Date
  issues: number
  filed: { key: string; count: number; title: string }[]
  overBudget: { key: string; count: number }[]
  failed: { key: string; reason: string }[]
}

/** What `factory-hygiene` made of a sweep's documents; `skipped` is final (nothing to judge), `failed` is retried a few times. */
export interface HygieneJudgment {
  outcome: 'answered' | 'failed' | 'skipped'
  attempts: number
  judgedAt: Date | null
  reason: string
  /** the findings that passed the factory's own check */
  findings: HygieneFinding[]
}

/** One full hygiene pass over one project as recorded (`migrations/0970_hygiene.sql`). */
export interface HygienePassRecord {
  id: string
  repo: string
  at: Date
  ref: string
  report: SweepReport
  judgment: HygieneJudgment
  filed: { key: string; title: string }[]
  overBudget: { key: string; title: string }[]
  failed: { key: string; reason: string }[]
}

/** The loops' own tables, inside one transaction: the agw calls made, so none is made twice, and the friction and hygiene passes. */
export interface LoopStore {
  /** the rounds of one subject, oldest first */
  calls(loop: CallLoop, issue: IssueId, subject: string): Promise<CallRow[]>
  /** false when the round is claimed already (another pass came first) */
  claimCall(
    row: Pick<CallRow, 'key' | 'loop' | 'issueId' | 'subject' | 'round' | 'claimedAt' | 'leaseUntil'>,
  ): Promise<boolean>
  /** takes a call whose lease lapsed back for this pass; false when another pass did first */
  retakeCall(key: string, claimedAt: Date, leaseUntil: Date): Promise<boolean>
  /** at boot: no call of an earlier process is still running, so every open call's lease lapses now */
  lapseOpen(now: Date): Promise<number>
  finishCall(
    key: string,
    result: { outcome: CallOutcome; answer: unknown; detail: string | null; at: Date },
  ): Promise<void>
  /** the asks of `factory-queue` about one shape of a repo's queue, oldest first */
  queueAsks(repo: string, shape: string): Promise<QueueAskRow[]>
  /** false when the round is claimed already (another pass came first) */
  claimQueueAsk(
    row: Pick<QueueAskRow, 'key' | 'repo' | 'shape' | 'round' | 'claimedAt' | 'leaseUntil'>,
  ): Promise<boolean>
  /** takes an ask whose lease lapsed back for this pass; false when another pass did first */
  retakeQueueAsk(key: string, claimedAt: Date, leaseUntil: Date): Promise<boolean>
  finishQueueAsk(
    key: string,
    result: { outcome: CallOutcome; answer: unknown; detail: string | null; at: Date },
  ): Promise<void>
  /** what was done with an answer: the edges applied and refused, and the queue's shape after them */
  recordQueueApplied(
    key: string,
    result: { applied: QueueEdge[]; refused: RefusedEdge[]; afterShape: string },
  ): Promise<void>
  /** an answered ask has this shape, or left the queue in it: asking again would be the same question */
  shapeAsked(repo: string, shape: string): Promise<boolean>
  /** when the repo was last asked (claimed, a failed ask included); null before the first */
  lastQueueAskAt(repo: string): Promise<Date | null>
  /** when the newest friction pass ran; null before the first */
  lastFrictionPassAt(): Promise<Date | null>
  recordFrictionPass(pass: FrictionPassRecord): Promise<void>
  /** the newest hygiene pass of each repo */
  hygienePasses(): Promise<HygienePassRecord[]>
  /** the newest hygiene pass of one repo; null before the first */
  lastHygienePass(repo: string): Promise<HygienePassRecord | null>
  recordHygienePass(pass: HygienePassRecord): Promise<void>
  /** a judgment retry: the pass's judgment and the lists it extended, as the whole new values */
  updateHygieneJudgment(
    id: string,
    next: Pick<HygienePassRecord, 'judgment' | 'filed' | 'overBudget' | 'failed'>,
  ): Promise<void>
}

/** An Issue that is still `settling`, with what triage needs to know of it. */
export interface SettlingRow {
  issue: IssueId
  repo: string
  title: string
  kind: 'feature' | 'bug' | 'chore' | 'docs' | 'incident'
  origin: string
  filedAt: Date
  fromAlert: boolean
  text: string
}

/** A watch whose last checks were all blocked: the checkout could not be moved to the shipped commit. */
export interface BlockedWatch {
  issue: IssueId
  watch: number
  attempt: number
  checks: number
  since: Date
  detail: string
}

/** A working or watching Issue that holds its repo's claim and waits (an open `after` edge) on Issues queued for want of one. */
export interface ClaimHolder {
  issue: IssueId
  state: 'working' | 'watching'
  /** the queued Issues of its own repo it is after */
  blockers: IssueId[]
}

/** Read-only SQL on other domains' tables (`docs/architecture.md`: cross-domain SQL lives in `read/`). */
export interface LoopReads {
  /** Issues waiting for a stall (`wall`, `unreported`, `blocked`, `lead_gone`, `regressed`), oldest first */
  stalled(limit: number): Promise<IssueId[]>
  /** Issues still settling, oldest first */
  settling(limit: number): Promise<SettlingRow[]>
  /** the Issues of the repo that are not closed, other than `excluding` */
  openIssues(repo: string, excluding: IssueId, limit: number): Promise<TriageCandidate[]>
  /** every open Issue that is not settling, with its priority and open blockers, for the queue loop */
  queueIssues(): Promise<QueueIssue[]>
  /** watching Issues whose open watch has had at least `streak` checks in a row, all blocked */
  blockedCheckouts(streak: number, limit: number): Promise<BlockedWatch[]>
  /** working or watching Issues with an open edge to one of `queued` (still queued, same repo): the claim deadlock */
  claimHolders(queued: readonly IssueId[], limit: number): Promise<ClaimHolder[]>
}

/** `factory-steward`: what a stalled Issue needs when the rules do not say. */
export interface StewardWorkflow {
  ask(stall: StewardStall, key: Key): Promise<Result<StewardAnswer, PortError>>
}

/** `factory-triage` for an Issue that is settling: the Issues it must wait for. */
export interface SettleWorkflow {
  settle(request: Extract<TriageRequest, { mode: 'settle' }>, key: Key): Promise<Result<TriageAnswer, PortError>>
}

/** `factory-queue`: edges and an order for a repo's queued Issues. */
export interface QueueWorkflow {
  ask(request: QueueRequest, key: Key): Promise<Result<QueueAnswer, PortError>>
}

/** `factory-hygiene`: the documents a sweep picked, read against the code they describe in a checkout. */
export interface HygieneWorkflow {
  ask(request: HygieneRequest, key: Key): Promise<Result<HygieneAnswer, PortError>>
}
