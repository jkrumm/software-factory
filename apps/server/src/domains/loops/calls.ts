import type { IssueId } from '../../kernel/ids.ts'

export type CallLoop = 'steward' | 'triage'
export type CallOutcome = 'answered' | 'rejected' | 'failed'

/** One ask of an agw workflow about one subject, as stored: the claim, then how it ended. A round is the nth try. */
export interface CallRow {
  /** the idempotency key of the agw run */
  key: string
  loop: CallLoop
  issueId: IssueId
  /** what it is about: `wait:<version>` for a stall, `settle` for an Issue settling */
  subject: string
  round: number
  claimedAt: Date
  leaseUntil: Date
  /** null while the call is in flight */
  outcome: CallOutcome | null
  answer: unknown
  detail: string | null
  finishedAt: Date | null
}

export interface CallPolicy {
  /** rounds that came to nothing (failed or rejected) before the loop stops asking */
  maxRounds: number
  /** how long after a round that came to nothing the next one may start */
  retryMs: number
  /** a claimed call is held this long: the hang guard of the agw call, so a lease outlives any run */
  leaseMs: number
}

/** What the rows of one subject say to do now. */
export type CallPlan =
  | { kind: 'answered'; row: CallRow }
  | { kind: 'in_flight' }
  /** a call whose lease lapsed (the server stopped under it): asked again under its own key, which agw answers from the run it has */
  | { kind: 'retake'; row: CallRow }
  | { kind: 'backoff'; until: Date }
  | { kind: 'exhausted'; rounds: number }
  | { kind: 'claim'; round: number }

/**
 * Whether to ask, derived from the rows alone: an answered round is reused (the workflow is asked once, a replayed pass
 * acts on the stored answer), a round in flight is left to its call until its lease lapses and then retaken, a failed or
 * rejected round is retried after `retryMs`, and a subject that used up its rounds is not asked again.
 */
export function planCall(rows: readonly CallRow[], now: Date, policy: CallPolicy): CallPlan {
  const answered = rows.find((row) => row.outcome === 'answered')
  if (answered) return { kind: 'answered', row: answered }
  if (rows.some((row) => row.outcome === null && row.leaseUntil > now)) return { kind: 'in_flight' }
  // A lapsed lease is a call that never came back (a restart): it is asked again under the same key, so agw hands back the run
  // it started instead of starting another.
  const lapsed = rows.find((row) => row.outcome === null)
  if (lapsed) return { kind: 'retake', row: lapsed }
  const spent = rows.length
  if (spent >= policy.maxRounds) return { kind: 'exhausted', rounds: spent }
  const last = rows.reduce<Date | null>((at, row) => {
    const ended = row.finishedAt ?? row.leaseUntil
    return at === null || ended > at ? ended : at
  }, null)
  if (last !== null && now.getTime() < last.getTime() + policy.retryMs) {
    return { kind: 'backoff', until: new Date(last.getTime() + policy.retryMs) }
  }
  return { kind: 'claim', round: spent + 1 }
}
