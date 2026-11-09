import type { ChainModel, ChainNode, ReadIssueDetail } from '@software-factory/contract'
import { ISSUE_KINDS, type IssueKind } from '@/components/kit/kind-badge'
import type { LozengeState } from '@/components/kit/lozenge'
import type { Tone } from '@/components/kit/tone'
import type { Step } from '@/components/kit/step-rail'
import { attemptOf } from './issue.ts'

/** The pure data of the Issue page's tabs and charts: shapes the API's detail for the screen, adds no figure of its own. */

type Ship = ReadIssueDetail['shipping'][number]

export const TAB_KEYS = ['overview', 'activity', 'evidence', 'checkpoints'] as const
export type TabKey = (typeof TAB_KEYS)[number]

export const TAB_LABEL: Record<TabKey, string> = {
  overview: 'Overview',
  activity: 'Activity',
  evidence: 'Evidence',
  checkpoints: 'Checkpoints',
}

/** The tab a URL value names; anything unknown or missing is the overview. */
export const tabOf = (value: unknown): TabKey => TAB_KEYS.find((key) => key === value) ?? 'overview'

const OUTCOMES = ['done', 'dropped', 'healed', 'cancelled'] as const

/** What the lozenge shows: the outcome once the Issue closed with a known one, else its state. */
export function lozengeStateOf(issue: Pick<ReadIssueDetail, 'state' | 'outcome'>): LozengeState {
  if (issue.state !== 'closed') return issue.state
  return OUTCOMES.find((outcome) => outcome === issue.outcome) ?? issue.state
}

/** The Issue's kind when it is one of the five known, else null. */
export const kindOf = (kind: string | null): IssueKind | null => ISSUE_KINDS.find((known) => known === kind) ?? null

export type ActivityStep = Step & { kind: string }
export interface ActivityGroup {
  key: string
  title: string
  steps: ActivityStep[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const FAILED_KINDS = new Set(['stalled', 'regressed'])

const dayKey = (date: Date): string => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`

/** "14:02:11", or "9 Nov 14:02" when the day differs from the previous step's. */
function clockWords(date: Date, previous: Date | null): string {
  if (previous === null || dayKey(previous) === dayKey(date)) {
    return date.toLocaleTimeString('en-GB', { hour12: false })
  }
  const time = date.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' })
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`
}

/** The part of "Stalled: reason" after the first ": "; undefined for the bare "Stalled.". */
const detailOf = (text: string): string | undefined => {
  const index = text.indexOf(': ')
  return index === -1 ? undefined : text.slice(index + 2)
}

/** The timeline as steps grouped by attempt; a line with no known attempt joins the previous line's group. */
export function activityGroups(input: {
  timeline: ReadIssueDetail['timeline']
  sessions: ReadIssueDetail['sessions']
  now: number
  closed: boolean
}): ActivityGroup[] {
  const groups: ActivityGroup[] = []
  let current: number | null | undefined
  let previousDate: Date | null = null
  input.timeline.forEach((line, index) => {
    const attempt = attemptOf(input.sessions, line.session)
    const last = groups.at(-1)
    if (last === undefined || (attempt !== null && attempt !== current)) {
      current = attempt
      groups.push({
        key: `${index}-${attempt === null ? 'before' : `attempt-${attempt}`}`,
        title: attempt === null ? 'Before the first attempt' : `Attempt ${attempt}`,
        steps: [],
      })
    }
    const at = Date.parse(line.at)
    const next = input.timeline[index + 1]
    const end = next ? Date.parse(next.at) : input.closed ? null : input.now
    const date = new Date(at)
    const failed = FAILED_KINDS.has(line.kind)
    const step: ActivityStep = {
      id: `${index}-${line.kind}`,
      kind: line.kind,
      label: line.text,
      at: clockWords(date, previousDate),
      durationMs: end === null ? undefined : Math.max(0, end - at),
      failed: failed || undefined,
      detail: failed ? detailOf(line.text) : undefined,
    }
    groups.at(-1)?.steps.push(step)
    previousDate = date
  })
  return groups
}

/** One entry per session, oldest first, for the per-attempt charts. */
export function attemptSeries(sessions: ReadIssueDetail['sessions']): {
  labels: string[]
  workingMs: number[]
  turns: number[]
  tokensOut: number[]
} {
  return {
    labels: sessions.map((_, index) => `Attempt ${index + 1}`),
    workingMs: sessions.map((s) => s.insights.workingMs),
    turns: sessions.map((s) => s.insights.turns),
    tokensOut: sessions.map((s) => s.insights.tokens.output),
  }
}

/** The share of prompt tokens read from the cache; null when no prompt tokens are counted. */
export function cacheShare(tokens: ReadIssueDetail['insights']['tokens']): number | null {
  const total = tokens.cacheRead + tokens.input + tokens.cacheWrite
  return total === 0 ? null : tokens.cacheRead / total
}

type Insights = ReadIssueDetail['insights']

/** The reason a token figure is a dash. */
export const TOKENS_NOT_COUNTED = 'The factory has not counted tokens for this Issue yet.'
/** The reason a tool-call or subagent figure is a dash. */
export const TOOL_CALLS_NOT_COUNTED = 'The factory has not counted tool calls and subagents for this Issue yet.'

/** Whether the token figures are real: not when the counting is partial, nor when turns ran and every token field is 0. */
export function tokensCounted(insights: Pick<Insights, 'partial' | 'turns'> & { tokens: Insights['tokens'] }): boolean {
  if (insights.partial) return false
  const { input, output, cacheRead, cacheWrite } = insights.tokens
  return !(insights.turns > 0 && input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0)
}

/** Whether the tool-call and subagent figures are real: not when the counting is partial. */
export const toolCallsCounted = (insights: Pick<Insights, 'partial'>): boolean => !insights.partial

/** When the Issue's first triage line was filed: the Issue's creation; an amendment keeps its own time. */
export function triageAt(issue: Pick<ReadIssueDetail, 'createdAt' | 'triage'>, index: number): string {
  return index === 0 ? issue.createdAt : (issue.triage[index]?.at ?? issue.createdAt)
}

/** How often a ship's watch came back regressed: the timeline's lines or the ships' watches, whichever counts more. */
export function regressionCount(issue: Pick<ReadIssueDetail, 'shipping' | 'timeline'>): number {
  const lines = issue.timeline.filter((line) => line.kind === 'regressed').length
  const ships = issue.shipping.filter((ship) => ship.watch?.answer === 'regressed').length
  return Math.max(lines, ships)
}

/** The Checkpoints tab's counts: Decisions, artifacts, notes and what still waits on the owner. */
export function checkpointTally(issue: Pick<ReadIssueDetail, 'asks' | 'artifacts' | 'notes'>): {
  decisions: number
  openDecisions: number
  artifacts: number
  awaitingVerdict: number
  notes: number
  open: number
} {
  const openDecisions = issue.asks.filter((ask) => ask.status === 'open').length
  const awaitingVerdict = issue.artifacts.filter((artifact) => artifact.verdict === null).length
  return {
    decisions: issue.asks.length,
    openDecisions,
    artifacts: issue.artifacts.length,
    awaitingVerdict,
    notes: issue.notes.length,
    open: openDecisions + awaitingVerdict,
  }
}

export interface ChainLink {
  node: ChainNode
  closed: boolean
}

const byOpenThenTitle = (a: ChainLink, b: ChainLink): number =>
  Number(a.closed) - Number(b.closed) || a.node.title.localeCompare(b.node.title)

/** The nodes an Issue waits on (`blockedBy`) and the ones waiting on it (`blocks`); open links first, then by title. */
export function chainAround(input: { chain: Pick<ChainModel, 'nodes' | 'edges'>; ref: string }): {
  blockedBy: ChainLink[]
  blocks: ChainLink[]
} {
  const nodes = new Map(input.chain.nodes.map((node) => [node.id, node]))
  const links = (side: 'from' | 'to', other: 'from' | 'to'): ChainLink[] =>
    input.chain.edges
      .filter((edge) => edge[side] === input.ref)
      .flatMap((edge) => {
        const node = nodes.get(edge[other])
        return node ? [{ node, closed: edge.closed }] : []
      })
      .sort(byOpenThenTitle)
  return { blockedBy: links('from', 'to'), blocks: links('to', 'from') }
}

/** The count each tab shows beside its label; null where the tab has none. */
export function tabCounts(
  issue: Pick<ReadIssueDetail, 'timeline' | 'shipping' | 'evidence' | 'asks' | 'artifacts' | 'notes'>,
): Record<TabKey, number | null> {
  const tally = checkpointTally(issue)
  return {
    overview: null,
    activity: issue.timeline.length,
    evidence: issue.shipping.length + issue.evidence.length,
    checkpoints: tally.decisions + tally.artifacts,
  }
}

/** A ship's standing as one word and the tone it is painted in (the kit's `Tone` members). */
export function shipStatus(ship: Ship): { label: string; tone: 'good' | 'bad' | 'neutral' | 'warn' } {
  if (ship.result === 'refused') return { label: 'Refused', tone: 'bad' }
  const answer = ship.watch?.answer
  if (answer === 'regressed') return { label: 'Regressed', tone: 'bad' }
  if (answer === 'passed') return { label: 'Passed', tone: 'good' }
  if (ship.watch !== null && answer === null) return { label: 'Watching', tone: 'warn' }
  return { label: 'Shipped', tone: 'neutral' }
}

type SessionState = ReadIssueDetail['sessions'][number]['state']

/** The tone each session state is painted in, decided here and nowhere else: never derived from the word. */
export const SESSION_TONES: Record<SessionState, Tone> = {
  starting: 'neutral',
  working: 'accent',
  idle: 'neutral',
  waiting: 'neutral',
  walled: 'warn',
  blocked: 'warn',
  stuck: 'warn',
  dead: 'neutral',
}

/** The tone of a Decision's status lozenge: open waits on the owner, answered is done, withdrawn is quiet. */
export const ASK_TONES: Record<ReadIssueDetail['asks'][number]['status'], Tone> = {
  open: 'warn',
  answered: 'good',
  withdrawn: 'neutral',
}

/** The pages the owner's next move is on: the first open Decision on Needs you, the first artifact without a verdict. */
export function nextActions(issue: Pick<ReadIssueDetail, 'asks' | 'artifacts'>): {
  decisionId: string | null
  artifactId: string | null
} {
  return {
    decisionId: issue.asks.find((ask) => ask.status === 'open')?.id ?? null,
    artifactId: issue.artifacts.find((artifact) => artifact.verdict === null)?.id ?? null,
  }
}

export type OptionChip = 'Recommended' | 'Default' | 'Answer'

/** The chips an option of a Decision carries; the recommendation is matched on the label, case-insensitively, whole or as its start. */
export function optionChips(
  option: string,
  ask: Pick<ReadIssueDetail['asks'][number], 'recommendation' | 'default' | 'answer'>,
): OptionChip[] {
  const label = option.trim().toLowerCase()
  const recommendation = ask.recommendation.trim().toLowerCase()
  const chips: OptionChip[] = []
  const next = recommendation.charAt(label.length)
  if (label !== '' && recommendation.startsWith(label) && !/[\p{L}\p{N}]/u.test(next)) chips.push('Recommended')
  if (option === ask.default) chips.push('Default')
  if (option === ask.answer) chips.push('Answer')
  return chips
}

const VERIFY_RESULTS: Record<string, boolean> = { green: true, red: false, blocked: false }

/** Whether a verify run passed; any result but the passing one (red, blocked, unknown) counts as failed. */
export const checkPassed = (result: string): boolean => VERIFY_RESULTS[result] === true
