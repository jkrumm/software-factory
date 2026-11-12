import { describe, expect, test } from 'bun:test'
import { DEPLOY_MAX_MS, FIRST_TICK_GRACE_MS, judgeTick, TICK_DEAD_MS, type TickInput } from '../../src/read/health.ts'

const NOW = new Date('2026-11-12T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const MIN = 60_000

const judge = (input: Partial<TickInput> & Pick<TickInput, 'startedAt' | 'tickAt'>) =>
  judgeTick({ tickMs: 10_000, now: NOW, ...input })

describe('a restart is not an outage', () => {
  test('a fresh start is ok and says starting until the first tick or five minutes', () => {
    expect(judge({ startedAt: ago(30_000), tickAt: null })).toEqual({ failure: null, notice: 'starting' })
    expect(judge({ startedAt: ago(FIRST_TICK_GRACE_MS), tickAt: null })).toEqual({ failure: null, notice: 'starting' })
  })

  test('the first tick ends starting', () => {
    expect(judge({ startedAt: ago(30_000), tickAt: ago(5_000) })).toEqual({ failure: null, notice: null })
  })

  test('a restart that never ticks within five minutes is not ok', () => {
    const verdict = judge({ startedAt: ago(FIRST_TICK_GRACE_MS + 1_000), tickAt: null, load: 3 })
    expect(verdict.notice).toBeNull()
    expect(verdict.failure).toMatch(/^no tick has succeeded yet; /)
  })

  test('on a starved host a first tick that is late is ok until twenty minutes, saying so; an idle host is not given the time', () => {
    const late = FIRST_TICK_GRACE_MS + 60_000
    expect(judge({ startedAt: ago(late), tickAt: null, load: 263.5, cores: 12 })).toEqual({
      failure: null,
      notice: 'starved: no tick has succeeded yet; the process is alive but starved (load 263.5)',
    })
    expect(judge({ startedAt: ago(TICK_DEAD_MS + 1_000), tickAt: null, load: 263.5, cores: 12 }).failure).toStartWith(
      'no tick has succeeded yet; ',
    )
    // twice the cores is the line; below it, or with the load or cores unknown, the five minutes stand
    expect(judge({ startedAt: ago(late), tickAt: null, load: 24, cores: 12 }).notice).toStartWith('starved:')
    expect(judge({ startedAt: ago(late), tickAt: null, load: 23.9, cores: 12 }).failure).not.toBeNull()
    expect(judge({ startedAt: ago(late), tickAt: null, load: 263.5 }).failure).not.toBeNull()
    expect(judge({ startedAt: ago(late), tickAt: null, cores: 12 }).failure).not.toBeNull()
  })

  test('a held deploy is ok and says deploying, over a missing tick', () => {
    expect(judge({ startedAt: ago(30 * MIN), tickAt: null, deployingSince: ago(2 * MIN) })).toEqual({
      failure: null,
      notice: 'deploying',
    })
  })

  test('a deploy that has held its lock past the cap is no excuse', () => {
    const verdict = judge({ startedAt: ago(60 * MIN), tickAt: null, deployingSince: ago(DEPLOY_MAX_MS + 1_000) })
    expect(verdict.failure).toContain('no tick has succeeded yet')
  })
})

describe('a slow tick under host load is not a stop', () => {
  test('a tick that is off is never judged', () => {
    expect(judgeTick({ tickMs: 0, now: NOW, startedAt: ago(60 * MIN), tickAt: null })).toEqual({
      failure: null,
      notice: null,
    })
  })

  test('within three intervals and a minute there is nothing to say', () => {
    expect(judge({ startedAt: ago(60 * MIN), tickAt: ago(59_000) })).toEqual({ failure: null, notice: null })
  })

  test('stalled ten minutes is ok and says starved, with the age and the load', () => {
    const verdict = judge({ startedAt: ago(60 * MIN), tickAt: ago(10 * MIN), load: 212.46 })
    expect(verdict.failure).toBeNull()
    expect(verdict.notice).toBe(
      'starved: the last successful tick was 600 s ago; the process is alive but starved (load 212.5)',
    )
  })

  test('stalled ten minutes with the tick failing says the error, not the load', () => {
    const verdict = judge({ startedAt: ago(60 * MIN), tickAt: ago(10 * MIN), load: 1, tickError: 'crashed: boom' })
    expect(verdict.failure).toBeNull()
    expect(verdict.notice).toBe('failing: the last successful tick was 600 s ago; the tick fails: crashed: boom')
  })

  test('twenty minutes is the edge, twenty-one is not ok', () => {
    expect(judge({ startedAt: ago(60 * MIN), tickAt: ago(TICK_DEAD_MS) }).failure).toBeNull()
    const starved = judge({ startedAt: ago(60 * MIN), tickAt: ago(21 * MIN), load: 40 })
    expect(starved.failure).toBe(
      'the last successful tick was 1260 s ago; the process is alive but starved (load 40.0)',
    )
    const failing = judge({ startedAt: ago(60 * MIN), tickAt: ago(21 * MIN), tickError: 'crashed: boom' })
    expect(failing.failure).toBe('the last successful tick was 1260 s ago; the tick fails: crashed: boom')
  })

  test('a limit set for a scenario replaces the twenty minutes and the first-tick grace', () => {
    expect(judge({ startedAt: ago(61_000), tickAt: null, limitMs: 60_000 }).failure).toContain('no tick')
    expect(judge({ startedAt: ago(60 * MIN), tickAt: ago(4_000), limitMs: 3_000 }).failure).toContain(
      'the last successful tick was 4 s ago',
    )
  })
})
