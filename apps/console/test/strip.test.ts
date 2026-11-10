import { expect, test } from 'bun:test'
import type { ReadAccountQuota } from '@software-factory/contract'
import { meterTone } from '../src/components/kit/tone.ts'
import {
  accountMeter,
  historySpan,
  hostMeters,
  isExhausted,
  machineWords,
  resetWords,
  spanLabel,
  streamWords,
  uptimeWords,
  usedPct,
} from '../src/lib/strip.ts'

const now = new Date('2026-11-08T12:00:00.000Z')
const quota = (over: Partial<ReadAccountQuota>): ReadAccountQuota => ({
  account: 'a',
  fiveHourUsed: null,
  weeklyUsed: 46.4,
  fiveHourResetsAt: null,
  weeklyResetsAt: null,
  exhaustedUntil: null,
  fresh: true,
  rank: null,
  rankReason: null,
  ...over,
})

test('meterTone is graphite below 75 %, warn from 75 %, bad from 90 %', () => {
  expect(meterTone(0.5)).toBe('neutral')
  expect(meterTone(0.75)).toBe('warn')
  expect(meterTone(0.89)).toBe('warn')
  expect(meterTone(0.9)).toBe('bad')
})

test('accountMeter rounds the weekly share, tones it by the share and says when a reading is stale or at its limit', () => {
  expect(accountMeter(quota({}), now)).toEqual({ account: 'a', weeklyPct: 46, tone: 'neutral', note: null })
  expect(accountMeter(quota({ weeklyUsed: 80 }), now).tone).toBe('warn')
  expect(accountMeter(quota({ weeklyUsed: 95 }), now).tone).toBe('bad')
  expect(accountMeter(quota({ weeklyUsed: 140 }), now).weeklyPct).toBe(100)
  expect(accountMeter(quota({ weeklyUsed: null }), now)).toMatchObject({ weeklyPct: null, tone: 'neutral' })
  expect(accountMeter(quota({ fresh: false }), now).note).toBe('stale')
  const walled = accountMeter(quota({ exhaustedUntil: '2026-11-08T12:00:01.000Z' }), now)
  expect(walled.tone).toBe('bad')
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

const ceilings = { swapoutMbPer300s: 2048, swapUsedPct: 75 }
const machine = (over: Partial<Parameters<typeof hostMeters>[0] & object> = {}) => ({
  load: 6,
  loadCeiling: 60,
  memory: { swapoutMbPer300s: 10, swapUsedPct: 15 },
  memoryCeilings: ceilings,
  ...over,
})

test('hostMeters draws load and swap against their ceilings, memory against the RAM, and tones the fill', () => {
  const [load, memory, swap] = hostMeters(machine(), { memoryUsedPct: 62.4 })
  expect(load).toEqual({ key: 'load', label: 'Load', fill: 0.1, text: '6', tone: 'neutral' })
  expect(memory).toEqual({ key: 'memory', label: 'Memory', fill: 0.624, text: '62%', tone: 'neutral' })
  expect(swap).toEqual({ key: 'swap', label: 'Swap', fill: 0.2, text: '15%', tone: 'neutral' })
  expect(hostMeters(machine({ load: 55 }), undefined)[0]).toMatchObject({ tone: 'bad' })
  expect(hostMeters(machine({ load: 90 }), undefined)[0]).toMatchObject({ fill: 1, tone: 'bad' })
  expect(hostMeters(machine(), { memoryUsedPct: 80 })[1]).toMatchObject({ tone: 'warn' })
  expect(hostMeters(machine({ memory: { swapoutMbPer300s: 0, swapUsedPct: 37.5 } }), undefined)[2]).toMatchObject({
    fill: 0.5,
    tone: 'neutral',
  })
  expect(hostMeters(machine({ memory: { swapoutMbPer300s: 0, swapUsedPct: 80 } }), undefined)[2]).toMatchObject({
    fill: 1,
    tone: 'bad',
  })
  expect(hostMeters(machine({ memory: { swapoutMbPer300s: 3000, swapUsedPct: 1 } }), undefined)[2]?.tone).toBe('bad')
})

test('at normal load every meter is neutral', () => {
  const tones = hostMeters(machine({ load: 4.2 }), { memoryUsedPct: 62 }).map((m) => m.tone)
  expect(tones).toEqual(['neutral', 'neutral', 'neutral'])
  expect(accountMeter(quota({ weeklyUsed: 46, fresh: true }), now).tone).toBe('neutral')
})

test('hostMeters says "-" for a reading it does not have and never tones it', () => {
  const meters = hostMeters(machine({ load: null, memory: null }), undefined)
  expect(meters.map((m) => [m.fill, m.text, m.tone])).toEqual([
    [null, '-', 'neutral'],
    [null, '-', 'neutral'],
    [null, '-', 'neutral'],
  ])
  expect(hostMeters(undefined, undefined).every((m) => m.fill === null)).toBe(true)
})

test('uptimeWords: days and hours, hours and minutes, minutes, under a minute', () => {
  const at = (ms: number) => new Date(now.getTime() - ms)
  const iso = (ms: number) => at(ms).toISOString()
  const H = 3_600_000
  expect(uptimeWords(iso(3 * 24 * H + 4 * H + 5000), now)).toBe('3 d 4 h')
  expect(uptimeWords(iso(5 * H + 12 * 60_000), now)).toBe('5 h 12 min')
  expect(uptimeWords(iso(12 * 60_000), now)).toBe('12 min')
  expect(uptimeWords(iso(1000), now)).toBe('under a minute')
  expect(uptimeWords(iso(-5000), now)).toBe('under a minute')
})

test('history: the span of the samples; axis ends in hours or minutes', () => {
  const sample = (minutesAgo: number) => ({ at: new Date(now.getTime() - minutesAgo * 60_000).toISOString() })
  expect(historySpan([])).toBe(0)
  expect(historySpan([sample(300), sample(0)])).toBe(300 * 60_000)
  expect(spanLabel(24 * 3_600_000)).toBe('-24 h')
  expect(spanLabel(90 * 60_000)).toBe('-2 h')
  expect(spanLabel(20 * 60_000)).toBe('-20 min')
})

test('streamWords, usedPct and isExhausted', () => {
  expect(streamWords({ live: true, offline: false })).toBe('Connected to the event stream')
  expect(streamWords({ live: false, offline: false })).toBe('Polling every 15 s')
  expect(streamWords({ live: false, offline: true })).toBe('No connection to the server')
  expect(usedPct(null)).toBeNull()
  expect(usedPct(140)).toBe(100)
  expect(isExhausted({ exhaustedUntil: '2026-11-08T12:00:01.000Z' }, now)).toBe(true)
  expect(isExhausted({ exhaustedUntil: null }, now)).toBe(false)
})
