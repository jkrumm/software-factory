import type { IssueId } from '../../kernel/ids.ts'
import type { HistoryRecord } from './history.ts'

/** The lead's verbs that count as a report: a stop after one is no forgotten report. */
const REPORT_KINDS: readonly string[] = ['asked', 'submitted', 'errand_raised', 'deferred', 'shipped', 'closed']

/** Whether a record is the lead's report for `attempt`: its verbs, and `stalled` when the lead itself blocked. */
export function isReport(record: HistoryRecord, attempt: number): boolean {
  const payload = record.payload as { attempt?: unknown; cause?: unknown }
  if (payload.attempt !== attempt) return false
  if (record.kind === 'stalled') return payload.cause === 'blocked'
  return REPORT_KINDS.includes(record.kind)
}

/** The lead stopped with nothing reported since its turn began (a verb the machine refused says nothing). */
export function reportedSince(records: readonly HistoryRecord[], attempt: number, since: Date): boolean {
  return records.some((record) => record.at.getTime() >= since.getTime() && isReport(record, attempt))
}

export type StopDecision = 'let_through' | 'send_back' | 'stall'

export interface StopFacts {
  /** the Issue is `working` on the attempt of the session that stopped */
  working: boolean
  /** background work (a subagent, a shell, a monitor) is in flight: the session pauses until it wakes it */
  backgroundTasks: boolean
  /** the turn began with a prompt the factory typed (the brief or a note), not one the owner typed */
  factoryTurn: boolean
  reported: boolean
  /** this turn was sent back once already */
  sentBack: boolean
  /** the hook's loop guard: this stop is the one after a send-back */
  stopHookActive: boolean
}

/**
 * A lead's stop: sent back once with one line when it reports nothing; the stop
 * that follows a send-back (`stopHookActive`) stalls the Issue as `unreported`. The same stop asked again, without the
 * flag (a retried hook), is let through and records nothing. A turn answering the owner is never sent back.
 */
export function decideStop(facts: StopFacts): StopDecision {
  if (facts.backgroundTasks || !facts.working || !facts.factoryTurn || facts.reported) return 'let_through'
  if (!facts.sentBack) return 'send_back'
  return facts.stopHookActive ? 'stall' : 'let_through'
}

export function sendBackMessage(issue: IssueId): string {
  return `Issue ${issue}: you stopped with nothing reported. Report where it stands with \`factory issue ship|close|block|ask|defer ${issue} --attempt <n> …\` (or \`factory artifact submit ${issue} --attempt <n> …\`, \`factory errand raise ${issue} --attempt <n> …\`), or keep working. Stopping again unreported stalls the Issue.`
}
