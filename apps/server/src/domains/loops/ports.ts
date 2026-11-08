import type {
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

/** The loops' own tables, inside one transaction: the agw calls made, so none is made twice, and the friction passes. */
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
  /** when the newest friction pass ran; null before the first */
  lastFrictionPassAt(): Promise<Date | null>
  recordFrictionPass(pass: FrictionPassRecord): Promise<void>
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

/** Read-only SQL on other domains' tables (`docs/architecture.md`: cross-domain SQL lives in `read/`). */
export interface LoopReads {
  /** Issues waiting for a stall (`wall`, `unreported`, `blocked`, `lead_gone`, `regressed`), oldest first */
  stalled(limit: number): Promise<IssueId[]>
  /** Issues still settling, oldest first */
  settling(limit: number): Promise<SettlingRow[]>
  /** the Issues of the repo that are not closed, other than `excluding` */
  openIssues(repo: string, excluding: IssueId, limit: number): Promise<TriageCandidate[]>
  /** watching Issues whose open watch has had at least `streak` checks in a row, all blocked */
  blockedCheckouts(streak: number, limit: number): Promise<BlockedWatch[]>
}

/** `factory-steward`: what a stalled Issue needs when the rules do not say. */
export interface StewardWorkflow {
  ask(stall: StewardStall, key: Key): Promise<Result<StewardAnswer, PortError>>
}

/** `factory-triage` for an Issue that is settling: the Issues it must wait for. */
export interface SettleWorkflow {
  settle(request: Extract<TriageRequest, { mode: 'settle' }>, key: Key): Promise<Result<TriageAnswer, PortError>>
}
