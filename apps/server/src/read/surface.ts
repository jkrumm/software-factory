import { createHash } from 'node:crypto'
import type {
  ReadAsk,
  ReadHealthLine,
  ReadIssueCard,
  ReadIssueDetail,
  ReadOverview,
  ReadSessionCard,
} from '@software-factory/contract'

/**
 * What a surface (the read token: voice or chat, whose input goes to models) may read. Pure functions over bodies already
 * built: anything marked `visible` (a work repo's) loses its text and keeps its shape, ids, states, counts and times.
 */

const HIDDEN = 'Text of a work repository is not shown.'
const SESSION_WORDS = 'Session of a work repository.'
const ITEM_WORDS = 'Item of a work repository.'
const QUESTION_WORDS = 'A question in a work repository.'

export function redactIssueCard<T extends ReadIssueCard>(card: T): T {
  if (!card.visible) return card
  return {
    ...card,
    filedTitle: `Issue #${card.id}`,
    title: `Issue #${card.id}`,
    summary: HIDDEN,
    about: HIDDEN,
    phase: null,
    repo: 'visible',
    repoName: 'visible',
  }
}

export function redactSessionCard(card: ReadSessionCard): ReadSessionCard {
  if (!card.visible) return card
  return {
    ...card,
    title: SESSION_WORDS,
    summary: SESSION_WORDS,
    repo: null,
    transcriptPath: null,
    terminal: null,
    address: null,
    tab: null,
  }
}

export function redactIssueDetail(detail: ReadIssueDetail): ReadIssueDetail {
  const sessions = detail.sessions.map(redactSessionCard)
  if (!detail.visible) return { ...detail, sessions }
  return {
    ...redactIssueCard(detail),
    timeline: detail.timeline.map((line) => ({ ...line, text: line.kind })),
    evidence: detail.evidence.map((e) => ({ ...e, link: null, note: null })),
    asks: detail.asks.map((a) => ({ ...a, question: QUESTION_WORDS, options: [], default: null, answer: null })),
    sessions,
  }
}

const opaqueId = (id: string): string => `redacted:${createHash('sha256').update(id).digest('hex').slice(0, 12)}`

export function redactAsk(ask: ReadAsk): ReadAsk {
  if (!ask.visible) return ask
  return { ...ask, id: opaqueId(ask.id), text: '', short: ITEM_WORDS, summary: ITEM_WORDS, repo: null, session: null }
}

export function redactHealth(line: ReadHealthLine): ReadHealthLine {
  if (!line.visible) return line
  return { ...line, id: opaqueId(line.id), text: '', short: ITEM_WORDS, summary: ITEM_WORDS, repo: null }
}

export function redactOverview(overview: ReadOverview): ReadOverview {
  return {
    ...overview,
    asks: overview.asks.map(redactAsk),
    humanQueue: overview.humanQueue.map(redactAsk),
    health: overview.health.map(redactHealth),
    issues: overview.issues.map(redactIssueCard),
  }
}
