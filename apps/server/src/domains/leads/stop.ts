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

export type StopDecision = 'let_through' | 'send_back'

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
}

/**
 * A lead's stop: sent back once per turn with one line when it reports nothing. The stop after the send-back is let
 * through and stalls nothing: a finished background task can restart the lead a few milliseconds after that stop (issues
 * 1154 and 1180), so a stall here was a false one. A lead that really stays quiet is the steward's idle path
 * (`loadIdle`: a note, then the `unreported` stall). A turn answering the owner is never sent back.
 */
export function decideStop(facts: StopFacts): StopDecision {
  if (facts.backgroundTasks || !facts.working || !facts.factoryTurn || facts.reported) return 'let_through'
  return facts.sentBack ? 'let_through' : 'send_back'
}

export function sendBackMessage(issue: IssueId): string {
  return `Issue ${issue}: you stopped with nothing reported. Report where it stands with \`factory issue ship|close|block|ask|defer ${issue} --attempt <n> …\` (or \`factory artifact submit ${issue} --attempt <n> …\`, \`factory errand raise ${issue} --attempt <n> …\`), or keep working. A lead that stays quiet is nudged by the steward and, if it still does not report, the Issue stalls.`
}
