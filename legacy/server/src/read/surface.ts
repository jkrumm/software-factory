import { createHash } from 'node:crypto'
import type {
  IssueCard,
  IssueDetail,
  Overview,
  ReadAsk,
  ReadHealth,
  SessionCard,
  Spawn,
} from '@software-factory/contract'

/**
 * What a surface (the read token: voice or chat, whose input goes to models) may read. Pure functions over bodies the Reader has
 * already built: anything marked `visible` (IuRoot's, `scopeOf`'s rule) loses its text and keeps its shape, ids, states and counts.
 */

const HIDDEN = 'Text of a visible repository is not shown.'
const SESSION_WORDS = 'Session of a visible repository.'
const ITEM_WORDS = 'Item of a visible repository.'
const QUESTION_WORDS = 'A question in a visible repository.'

export function redactIssueCard<T extends IssueCard>(card: T): T {
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

export function redactSessionCard(card: SessionCard): SessionCard {
  if (!card.visible) return card
  return { ...card, title: SESSION_WORDS, summary: SESSION_WORDS, repo: null, transcriptPath: null, terminal: null }
}

export function redactIssueDetail(detail: IssueDetail): IssueDetail {
  const sessions = detail.sessions.map(redactSessionCard)
  if (!detail.visible) return { ...detail, sessions }
  return {
    ...redactIssueCard(detail),
    timeline: detail.timeline.map((line) => ({ ...line, text: line.kind })),
    evidence: detail.evidence.map((e) => ({ ...e, link: null, note: null })),
    asks: detail.asks.map((a) => ({
      ...a,
      question: QUESTION_WORDS,
      options: [],
      default: null,
      answer: null,
    })),
    sessions,
  }
}

const opaqueId = (id: string): string => `redacted:${createHash('sha256').update(id).digest('hex').slice(0, 12)}`

export function redactAsk(ask: ReadAsk): ReadAsk {
  if (!ask.visible) return ask
  return { ...ask, id: opaqueId(ask.id), text: '', short: ITEM_WORDS, summary: ITEM_WORDS, repo: null }
}

export function redactHealth(line: ReadHealth): ReadHealth {
  if (!line.visible) return line
  return { ...line, id: opaqueId(line.id), text: '', short: ITEM_WORDS, summary: ITEM_WORDS, repo: null }
}

export function redactSpawn(spawn: Spawn, isVisible: (path: string) => boolean): Spawn {
  if (!isVisible(spawn.repo) && !isVisible(spawn.space)) return spawn
  return { ...spawn, repo: 'visible', space: 'visible', tab: null, workspace: null, error: null }
}

export function redactOverview(overview: Overview, isVisible: (path: string) => boolean): Overview {
  return {
    ...overview,
    asks: overview.asks.map(redactAsk),
    humanQueue: overview.humanQueue.map(redactAsk),
    health: overview.health.map(redactHealth),
    queue: {
      ...overview.queue,
      spawns: overview.queue.spawns.map((s) => redactSpawn(s, isVisible)),
    },
  }
}
