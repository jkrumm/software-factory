import { describe, expect, test } from 'bun:test'
import { buildTime, STALE_GRACE_MS, staleReads, UPDATE_STUCK_MS, updatePhase } from '../src/lib/freshness.ts'

const NOW = 1_800_000_000_000

describe('stale reads', () => {
  test('a read is stale only past its poll interval and the grace', () => {
    const read = (ageMs: number) => ({ key: ['needs'], updatedAt: NOW - ageMs, intervalMs: 15_000 })
    expect(staleReads([read(15_000 + STALE_GRACE_MS)], NOW)).toEqual([])
    expect(staleReads([read(15_000 + STALE_GRACE_MS + 1)], NOW)).toHaveLength(1)
  })

  test('a read that never landed is not stale, and the oldest comes first, one line for each name', () => {
    const reads = [
      { key: ['needs'], updatedAt: 0, intervalMs: 15_000 },
      { key: ['accounts'], updatedAt: NOW - 120_000, intervalMs: 15_000 },
      { key: ['flow'], updatedAt: NOW - 300_000, intervalMs: 60_000 },
      { key: ['project-page', 'a'], updatedAt: NOW - 200_000, intervalMs: 60_000 },
      { key: ['project-page', 'b'], updatedAt: NOW - 100_000, intervalMs: 60_000 },
    ]
    const stale = staleReads(reads, NOW)
    expect(stale.map((read) => read.label)).toEqual(['Overview', 'Project', 'Accounts'])
    expect(stale.map((read) => read.strip)).toEqual([false, false, true])
  })
})

describe('the update phase', () => {
  test('current without a waiting build, updating at first, stuck after two minutes', () => {
    expect(updatePhase(null, NOW)).toBe('current')
    expect(updatePhase(NOW - 1_000, NOW)).toBe('updating')
    expect(updatePhase(NOW - UPDATE_STUCK_MS, NOW)).toBe('stuck')
  })
})

describe('the build id', () => {
  test('is the base-36 time of the build', () => {
    expect(buildTime(NOW.toString(36))).toBe(NOW)
    expect(buildTime('dev')).toBeNull()
  })
})
