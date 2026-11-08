import { expect, test } from 'bun:test'
import type { ReadAccountQuota } from '@software-factory/contract'
import { accountMeter, machineWords, resetWords } from '../src/lib/strip.ts'

const now = new Date('2026-11-08T12:00:00.000Z')
const quota = (over: Partial<ReadAccountQuota>): ReadAccountQuota => ({
  account: 'a',
  fiveHourUsed: null,
  weeklyUsed: 46.4,
  fiveHourResetsAt: null,
  weeklyResetsAt: null,
  exhaustedUntil: null,
  fresh: true,
  ...over,
})

test('accountMeter rounds the weekly share, warns near the wall and says when a reading is stale or at its limit', () => {
  expect(accountMeter(quota({}), now)).toEqual({ account: 'a', weeklyPct: 46, warn: false, note: null })
  expect(accountMeter(quota({ weeklyUsed: 90 }), now).warn).toBe(true)
  expect(accountMeter(quota({ weeklyUsed: 140 }), now).weeklyPct).toBe(100)
  expect(accountMeter(quota({ weeklyUsed: null }), now)).toMatchObject({ weeklyPct: null, warn: false })
  expect(accountMeter(quota({ fresh: false }), now).note).toBe('stale')
  const walled = accountMeter(quota({ exhaustedUntil: '2026-11-08T12:00:01.000Z' }), now)
  expect(walled.warn).toBe(true)
  expect(walled.note).toStartWith('at its limit until')
  expect(accountMeter(quota({ exhaustedUntil: '2026-11-08T11:00:00.000Z' }), now).note).toBeNull()
})

test('resetWords: no window is "none"; within a day only the time, later the weekday too', () => {
  expect(resetWords(null, now)).toBe('none')
  expect(resetWords('2026-11-08T13:00:00.000Z', now)).toMatch(/^\d\d:\d\d$/)
  expect(resetWords('2026-11-11T16:00:00.000Z', now)).toMatch(/^[A-Z][a-z]+day \d\d:\d\d$/)
})

test('machineWords names load and swap, says unknown for a failed reading and warns past a ceiling', () => {
  const ceilings = { swapoutMbPer300s: 2048, swapUsedPct: 75 }
  const ok = machineWords({
    load: 4.24,
    loadCeiling: 60,
    memory: { swapoutMbPer300s: 0, swapUsedPct: 12.5 },
    memoryCeilings: ceilings,
  })
  expect(ok).toEqual({ load: 'load 4.2 of 60', swap: 'swap 12.5% of RAM', warn: false })
  const blind = machineWords({ load: null, loadCeiling: 60, memory: null, memoryCeilings: ceilings })
  expect(blind).toEqual({ load: 'load unknown', swap: 'swap unknown', warn: false })
  expect(
    machineWords({
      load: 61,
      loadCeiling: 60,
      memory: { swapoutMbPer300s: 0, swapUsedPct: 1 },
      memoryCeilings: ceilings,
    }).warn,
  ).toBe(true)
  expect(
    machineWords({
      load: 1,
      loadCeiling: 60,
      memory: { swapoutMbPer300s: 0, swapUsedPct: 80 },
      memoryCeilings: ceilings,
    }).warn,
  ).toBe(true)
})
