import { describe, expect, test } from 'bun:test'
import {
  HELD_SPLITS,
  openOfWork,
  PAUSED_SPLITS,
  READY_LIMITS,
  sumWorkCounts,
  workCountsOf,
  WORK_TREND_STATES,
  workOf,
  workTrendOfState,
} from '../src/work-words.ts'
import { QUEUE_REASONS } from '../src/capacity.ts'

describe('workOf', () => {
  test('a started Issue is Running or Paused, a shipped one is Checking', () => {
    expect(workOf({ state: 'working' })).toEqual({ word: 'running', split: null })
    expect(workOf({ state: 'watching' })).toEqual({ word: 'checking', split: null })
    expect(workOf({ state: 'waiting', waitReason: 'decision' })).toEqual({ word: 'paused', split: 'you' })
    expect(workOf({ state: 'waiting', waitReason: 'timer' })).toEqual({ word: 'paused', split: 'timer' })
    expect(workOf({ state: 'waiting', waitReason: 'dependency' })).toEqual({ word: 'paused', split: 'issue' })
    expect(workOf({ state: 'waiting', waitReason: 'external' })).toEqual({ word: 'paused', split: 'issue' })
    for (const reason of ['wall', 'unreported', 'blocked', 'lead_gone', 'regressed', null]) {
      expect(workOf({ state: 'waiting', waitReason: reason })).toEqual({ word: 'paused', split: 'stalled' })
    }
  })

  test('every owner wait is on you', () => {
    for (const reason of ['decision', 'review', 'errand'])
      expect(workOf({ state: 'waiting', waitReason: reason })?.split).toBe('you')
  })

  test('settling is Held; a queued Issue is Held by what capacity cannot lift and Ready otherwise', () => {
    expect(workOf({ state: 'settling' })).toEqual({ word: 'held', split: 'settling' })
    expect(workOf({ state: 'queued' })).toEqual({ word: 'ready', split: 'seat' })
    expect(workOf({ state: 'queued', queueKind: 'chain' })).toEqual({ word: 'held', split: 'issue' })
    expect(workOf({ state: 'queued', queueKind: 'line' })).toEqual({ word: 'held', split: 'line' })
    expect(workOf({ state: 'queued', queueKind: 'drain' })).toEqual({ word: 'held', split: 'drain' })
    expect(workOf({ state: 'queued', queueKind: 'spec' })).toEqual({ word: 'held', split: 'spec' })
    expect(workOf({ state: 'queued', queueKind: 'memory' })).toEqual({ word: 'ready', split: 'host' })
    expect(workOf({ state: 'queued', queueKind: 'lane' })).toEqual({ word: 'ready', split: 'repo' })
    expect(workOf({ state: 'queued', queueKind: 'window' })).toEqual({ word: 'ready', split: 'account' })
  })

  test('every queue reason lands under a word, and a closed Issue under none', () => {
    for (const kind of QUEUE_REASONS) {
      const work = workOf({ state: 'queued', queueKind: kind })
      expect(work?.word === 'held' || work?.word === 'ready').toBe(true)
      expect(work?.word === 'held' ? HELD_SPLITS : READY_LIMITS).toContain(work?.split as never)
    }
    for (const reason of ['decision', 'timer', 'wall'])
      expect(PAUSED_SPLITS).toContain(workOf({ state: 'waiting', waitReason: reason })?.split as never)
    expect(workOf({ state: 'closed' })).toBeNull()
  })
})

describe('the counts', () => {
  const issues = [
    { state: 'working' },
    { state: 'working' },
    { state: 'watching' },
    { state: 'waiting', waitReason: 'timer' },
    { state: 'waiting', waitReason: 'review' },
    { state: 'queued', queueKind: 'memory' },
    { state: 'queued', queueKind: 'line' },
    { state: 'queued' },
    { state: 'settling' },
    { state: 'closed' },
  ]

  test('the five words add up to the open Issues and the splits to their word', () => {
    const counts = workCountsOf(issues)
    expect(counts).toMatchObject({ running: 2, paused: 2, ready: 2, held: 2, checking: 1 })
    expect(openOfWork(counts)).toBe(9)
    expect(Object.values(counts.split.paused).reduce((a, b) => a + b)).toBe(counts.paused)
    expect(Object.values(counts.split.ready).reduce((a, b) => a + b)).toBe(counts.ready)
    expect(Object.values(counts.split.held).reduce((a, b) => a + b)).toBe(counts.held)
  })

  test('two counts add up', () => {
    const sum = sumWorkCounts(workCountsOf(issues), workCountsOf(issues))
    expect(openOfWork(sum)).toBe(18)
    expect(sum.split.paused.you).toBe(2)
  })

  test('the trend counts each stored state in one series, settling with queued', () => {
    expect(workTrendOfState('working')).toBe('running')
    expect(workTrendOfState('settling')).toBe('notStarted')
    expect(workTrendOfState('queued')).toBe('notStarted')
    expect(workTrendOfState('watching')).toBe('checking')
    expect(workTrendOfState('closed')).toBeNull()
    expect(Object.values(WORK_TREND_STATES).flat().sort()).toEqual([
      'queued',
      'settling',
      'waiting',
      'watching',
      'working',
    ])
  })
})
