import { describe, expect, test } from 'bun:test'
import type {
  ReadAsk,
  ReadHealthLine,
  ReadIssueCard,
  ReadIssueDetail,
  ReadSessionCard,
} from '@software-factory/contract'
import { describeEvent, phaseOf, stateSentence } from '../../src/read/describe.ts'
import { aboutOf, cut, fallbackWords, firstSentence, plainText } from '../../src/read/plain.ts'
import {
  redactAsk,
  redactHealth,
  redactIssueCard,
  redactIssueDetail,
  redactSessionCard,
} from '../../src/read/surface.ts'

describe('plain words', () => {
  test('ids become words and a path its last segment', () => {
    expect(plainText('Issue 12 waits on lead-12-2 at /Users/me/code/argo/Makefile')).toBe(
      'An Issue waits on the lead at Makefile',
    )
    expect(plainText('decision_0192abc and 3f2a9c1d7e are gone')).toBe('And are gone')
    expect(plainText('see issue_7')).toBe('See an Issue')
  })

  test('cut ends at a word, the first sentence stops at its full stop', () => {
    expect(cut('one two three four five six', 15)).toBe('one two three…')
    expect(firstSentence('Fix the login. Then more words follow.')).toBe('Fix the login.')
  })

  test('a line with only ids still has words', () => {
    expect(fallbackWords('lead-12-1', 'ask').short).toBe('The lead')
    expect(fallbackWords('', 'health').summary).toBe('A line that needs a look')
  })

  test('what an Issue is for skips a sentence that says where it came from', () => {
    expect(aboutOf('Login crashes', 'Filed from Hermes. The login page crashes on submit.')).toBe(
      'The login page crashes on submit.',
    )
    expect(aboutOf('Login crashes', null)).toBe('Login crashes')
  })

  test('an event reads as a sentence with no id and an unknown kind is never blank', () => {
    expect(describeEvent('verdict_given', { artifact: 'artifact_1', verdict: 'changes' })).toBe(
      'Reviewed: needs changes.',
    )
    expect(describeEvent('asked', { decision: { id: 'decision_1' } })).toBe('Asked the owner for a decision.')
    expect(describeEvent('brand_new_kind', {})).toBe('Brand new kind.')
  })

  test('state and wait have sentences and phases', () => {
    expect(stateSentence({ state: 'waiting', reason: 'decision', outcome: null })).toBe(
      'Waiting for the owner to decide.',
    )
    expect(phaseOf({ state: 'waiting', reason: 'decision' })).toBe('waiting for your answer')
  })

  test('a queued Issue names the reason the queue order gives', () => {
    const queued = { state: 'queued', reason: null, outcome: null }
    expect(stateSentence(queued)).toBe('Queued, waiting for a free account.')
    expect(
      stateSentence({ ...queued, queue: { kind: 'drain', message: 'the queue is draining: nothing new starts' } }),
    ).toBe('Queued: the queue is draining, so no new work starts.')
    expect(
      stateSentence({
        ...queued,
        queue: { kind: 'claim', message: 'no claim free in the repo', repoName: 'argo', heldBy: 7 },
      }),
    ).toBe('Queued behind another Issue that holds argo.')
    expect(
      stateSentence({ ...queued, queue: { kind: 'claim', message: 'no claim free in the repo', repoName: 'argo' } }),
    ).toBe('Queued: the claims on argo are full, so it starts when one frees.')
    expect(stateSentence({ ...queued, queue: { kind: 'chain', message: 'waits for Issue 3 to close' } })).toBe(
      'Queued: waits for an Issue to close.',
    )
    expect(phaseOf({ state: 'working', reason: null })).toBe('building')
  })
})

const card = (visible: boolean): ReadIssueCard => ({
  id: 12,
  ref: 'issue_12',
  filedTitle: 'secret title',
  title: 'secret title',
  summary: 'secret summary',
  about: 'secret about',
  state: 'waiting',
  reason: 'decision',
  outcome: null,
  phase: 'waiting for your answer',
  repo: 'chat',
  repoName: 'chat',
  visible,
  kind: 'bug',
  size: null,
  lead: 'lead-12-1',
  account: 'max1',
  quota: null,
  insights: {
    startedAt: '2026-11-07T10:00:00.000Z',
    endedAt: null,
    elapsedMs: 5,
    workingMs: 3,
    turns: 2,
    toolCalls: 0,
    subagents: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    models: [],
    attempts: 1,
    partial: true,
  },
  createdAt: '2026-11-07T10:00:00.000Z',
  updatedAt: '2026-11-07T10:00:00.000Z',
  closedAt: null,
  heldBy: null,
  waitingOnOwner: true,
})

const session = (visible: boolean): ReadSessionCard => ({
  id: 'lead-12-1',
  issue: 12,
  issueRef: 'issue_12',
  parent: null,
  role: 'lead',
  title: 'Issue lead: secret',
  summary: 'secret',
  state: 'working',
  status: 'working',
  wait: null,
  account: 'max1',
  quota: null,
  model: null,
  turn: 3,
  terminal: { id: 't1', name: 'lead-12-1', space: '/x/chat', tab: 'tab', workspace: null },
  address: 't1',
  tab: 'tab',
  transcriptPath: '/x/t.jsonl',
  repo: 'chat',
  visible,
  since: '2026-11-07T10:00:00.000Z',
  lastActivityAt: '2026-11-07T10:00:00.000Z',
  insights: card(visible).insights,
})

describe('the read token', () => {
  test('a work repo card loses its words and keeps ids, state, counts and times', () => {
    const red = redactIssueCard(card(true))
    expect(red).toMatchObject({
      id: 12,
      ref: 'issue_12',
      title: 'Issue #12',
      filedTitle: 'Issue #12',
      summary: 'Text of a work repository is not shown.',
      phase: null,
      repo: 'visible',
      repoName: 'visible',
      state: 'waiting',
      lead: 'lead-12-1',
      updatedAt: '2026-11-07T10:00:00.000Z',
    })
    expect(JSON.stringify(red)).not.toContain('secret')
  })

  test('another repo is left untouched', () => {
    const plain = card(false)
    expect(redactIssueCard(plain)).toBe(plain)
    expect(redactSessionCard(session(false))).toEqual(session(false))
  })

  test('a work session loses title, summary, repo, terminal and transcript', () => {
    const red = redactSessionCard(session(true))
    expect(JSON.stringify(red)).not.toContain('secret')
    expect(red).toMatchObject({
      terminal: null,
      address: null,
      tab: null,
      repo: null,
      transcriptPath: null,
      turn: 3,
      state: 'working',
    })
  })

  test('a detail loses timeline words, evidence notes and the text of its asks, and its sessions are redacted', () => {
    const detail: ReadIssueDetail = {
      ...card(true),
      timeline: [{ at: '2026-11-07T10:00:00.000Z', kind: 'asked', text: 'secret words', session: 'lead-12-1' }],
      evidence: [{ kind: 'review', link: 'https://secret', note: 'secret', at: '2026-11-07T10:00:00.000Z' }],
      asks: [
        {
          id: 'decision_1',
          question: 'secret?',
          options: ['secret'],
          default: 'secret',
          answer: 'secret',
          askedAt: '2026-11-07T10:00:00.000Z',
          recommendation: 'secret',
          checked: 'secret',
          status: 'answered',
          answeredAt: '2026-11-07T10:05:00.000Z',
          settledBy: 'owner',
        },
      ],
      triage: [
        {
          at: '2026-11-07T09:00:00.000Z',
          outcome: 'filed',
          title: 'secret',
          text: 'secret',
          origin: 'you',
          trust: 'owner',
          source: 'secret-source',
          kind: 'request',
          link: 'https://secret',
        },
      ],
      notes: [{ at: '2026-11-07T10:01:00.000Z', text: 'secret', session: 'lead-12-1', delivered: true }],
      artifacts: [
        {
          id: 'artifact_1',
          kind: 'spec',
          title: 'secret',
          revisions: 2,
          verdict: 'looks_good',
          at: '2026-11-07T10:02:00.000Z',
        },
      ],
      shipping: [
        {
          at: '2026-11-07T10:03:00.000Z',
          attempt: 1,
          result: 'accepted',
          detail: null,
          commits: ['secret'],
          review: { present: true, note: 'secret' },
          acceptance: [{ status: 'not_met', text: 'secret' }],
          watch: {
            startedAt: '2026-11-07T10:03:00.000Z',
            windowMs: 60000,
            answer: 'passed',
            answeredAt: '2026-11-07T10:04:00.000Z',
          },
          checks: [{ at: '2026-11-07T10:04:00.000Z', result: 'green', summary: 'secret' }],
        },
        {
          at: '2026-11-07T10:02:30.000Z',
          attempt: 1,
          result: 'refused',
          detail: 'secret',
          commits: [],
          review: { present: false, note: null },
          acceptance: null,
          watch: null,
          checks: [],
        },
      ],
      sessions: [session(true)],
    }
    const red = redactIssueDetail(detail)
    expect(JSON.stringify(red)).not.toContain('secret')
    expect(red.timeline[0]).toMatchObject({ kind: 'asked', text: 'asked', session: 'lead-12-1' })
    expect(red.asks[0]).toMatchObject({
      id: 'decision_1',
      askedAt: '2026-11-07T10:00:00.000Z',
      status: 'answered',
      settledBy: 'owner',
    })
    expect(red.triage[0]).toMatchObject({ outcome: 'filed', kind: 'request', origin: 'you', link: null })
    expect(red.notes[0]).toMatchObject({ text: '', delivered: true })
    expect(red.artifacts[0]).toMatchObject({ id: 'artifact_1', revisions: 2, verdict: 'looks_good' })
    expect(red.shipping[0]).toMatchObject({ result: 'accepted', commits: [], watch: { answer: 'passed' } })
    expect(red.shipping[1]?.detail).toBe('')
  })

  test('an ask and a health line of a work repo get an opaque id and no text', () => {
    const ask: ReadAsk = {
      id: 'decision_1',
      kind: 'decision',
      source: 'decision',
      issue: 12,
      issueRef: 'issue_12',
      short: 'secret',
      summary: 'secret',
      text: 'secret',
      at: '2026-11-07T10:00:00.000Z',
      stale: false,
      repo: 'chat',
      session: 'lead-12-1',
      visible: true,
    }
    const red = redactAsk(ask)
    expect(red.id).toMatch(/^redacted:[0-9a-f]{12}$/)
    expect(JSON.stringify(red)).not.toContain('secret')
    expect(red).toMatchObject({ issue: 12, at: ask.at, stale: false, kind: 'decision' })
    const line: ReadHealthLine = {
      id: 'checkout:issue_12:1',
      kind: 'checkout',
      short: 'secret',
      summary: 'secret',
      text: 'secret',
      since: null,
      repo: 'chat',
      visible: true,
    }
    expect(JSON.stringify(redactHealth(line))).not.toContain('secret')
    expect(redactHealth({ ...line, visible: false })).toEqual({ ...line, visible: false })
  })
})
