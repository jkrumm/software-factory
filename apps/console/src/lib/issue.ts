import type {
  ReadAskLine,
  ReadCheckLine,
  ReadIssueDetail,
  ReadNoteLine,
  ReadWatchLine,
} from '@software-factory/contract'
import { ageWords } from './age.ts'
import { VERDICT_WORDS } from './artifact.ts'
import { spanWords } from './needs.ts'

/** The pure wording of the Issue page: every figure comes from the API's detail, only phrased here. */

export const ISSUE_STATE_WORDS: Record<ReadIssueDetail['state'], string> = {
  settling: 'Being settled',
  queued: 'Queued',
  working: 'Working',
  waiting: 'Waiting',
  watching: 'Watching after a ship',
  closed: 'Closed',
}

export const SESSION_STATE_WORDS: Record<ReadIssueDetail['sessions'][number]['state'], string> = {
  starting: 'Starting',
  working: 'Working',
  idle: 'Idle between turns',
  waiting: 'Waiting',
  walled: 'Stopped at its account limit',
  blocked: 'Blocked',
  stuck: 'Stuck',
  dead: 'Gone',
}

const ORIGIN_WORDS: Record<string, string> = {
  you: 'You',
  application: 'An application',
  infrastructure: 'Infrastructure',
  github: 'GitHub',
  feedback: 'App feedback',
  factory: 'The factory',
}

const TRUST_WORDS: Record<string, string> = {
  owner: 'trusted as the owner',
  machine: 'trusted as a machine',
  agent: 'trusted as an agent',
  outside: 'outside text, not trusted',
}

const SETTLED_BY_WORDS: Record<string, string> = {
  owner: 'by you',
  orchestrator: 'by the orchestrator, for you',
  policy: 'by policy',
  judge: 'by the judge',
  default: 'by the default, no one answered in time',
}

const SHIP_CHECK_WORDS: Record<string, string> = { green: 'Passed', red: 'Failed', blocked: 'Blocked' }

const KIND_WORDS: Record<string, string> = {
  alert: 'an alert',
  request: 'a request',
  feedback: 'feedback',
  remark: 'a remark',
}

const word = (words: Record<string, string>, key: string): string => words[key] ?? key.replaceAll('_', ' ')

export const originWords = (origin: string): string => word(ORIGIN_WORDS, origin)
export const trustWords = (trust: string): string => word(TRUST_WORDS, trust)
export const triageKindWords = (kind: string): string => word(KIND_WORDS, kind)
export const settledByWords = (by: string | null): string => (by === null ? '' : word(SETTLED_BY_WORDS, by))
export const checkWords = (result: ReadCheckLine['result']): string => word(SHIP_CHECK_WORDS, result)

/** A latest verdict, in the artifact page's words; "No verdict yet" while none. */
export const verdictWords = (verdict: string | null): string =>
  verdict === null
    ? 'No verdict yet'
    : (VERDICT_WORDS[verdict as keyof typeof VERDICT_WORDS] ?? verdict.replaceAll('_', ' '))

export const askStatusWords = (status: ReadAskLine['status']): string =>
  ({ open: 'Open', answered: 'Answered', withdrawn: 'Withdrawn' })[status]

/** Where a note stands: typed into the lead, sent but not confirmed, or waiting for the next brief. */
export function deliveryWords(delivered: ReadNoteLine['delivered']): string {
  if (delivered === true) return 'Delivered to the lead'
  if (delivered === false) return 'Sent, not confirmed yet'
  return 'In the next brief'
}

/** What a watch is doing: "Passed 28 min ago, window of 1 minute", or "Running, window of 1 minute". */
export function watchWords(watch: ReadWatchLine, now: number): string {
  const window = `window of ${spanWords(watch.windowMs)}`
  if (watch.answer === null || watch.answeredAt === null) return `Running, ${window}`
  const verb = { passed: 'Passed', regressed: 'Regressed', ended: 'Ended' }[watch.answer]
  return `${verb} ${ageWords(now - Date.parse(watch.answeredAt))}, ${window}`
}

/** A time in the owner's words, relative to `now`. */
export const agoWords = (iso: string, now: number): string => ageWords(now - Date.parse(iso))

/** A count with its thousands separated: 12,345. */
export const countWords = (n: number): string => n.toLocaleString('en-US')

/** The attempt a session is, counted from the API's list order (oldest first); null for a key the list does not hold. */
export function attemptOf(sessions: readonly { id: string }[], key: string | null): number | null {
  if (key === null) return null
  const index = sessions.findIndex((session) => session.id === key)
  return index === -1 ? null : index + 1
}

/** The plain line beside the state badge: the phase and the wait; empty when the API names neither. */
export function standingWords(issue: Pick<ReadIssueDetail, 'state' | 'phase' | 'reason'>): string {
  const parts: string[] = []
  if (issue.phase) parts.push(issue.phase)
  if (issue.state === 'waiting' && issue.reason) parts.push(`wait: ${issue.reason.replaceAll('_', ' ')}`)
  return parts.join(' · ')
}
