import { expect, test } from 'bun:test'
import { FlowTrendQuery } from '@software-factory/contract'
import { bucketStarts, trendOf } from '../../src/read/flow-trend.ts'

const NOW = new Date('2026-11-07T12:30:00Z')
const at = (hhmm: string, day = '07') => new Date(`2026-11-${day}T${hhmm}:00Z`)

test('buckets sit on UTC hours and days; the last holds now', () => {
  const hours = bucketStarts(NOW, '24h', 'hour')
  expect(hours).toHaveLength(24)
  expect(new Date(hours.at(-1) ?? 0).toISOString()).toBe('2026-11-07T12:00:00.000Z')
  expect(new Date(hours[0] ?? 0).toISOString()).toBe('2026-11-06T13:00:00.000Z')
  expect(bucketStarts(NOW, '7d', 'hour')).toHaveLength(168)
  expect(bucketStarts(NOW, '7d', 'day')).toHaveLength(7)
  expect(new Date(bucketStarts(NOW, '30d', 'day').at(-1) ?? 0).toISOString()).toBe('2026-11-07T00:00:00.000Z')
})

test('peak is the most at any instant, the average is time weighted, between two samples a peak still shows', () => {
  // two Issues work 10:15 to 10:45 inside the 10:00 hour, a third one 10:00 to 11:00
  const intervals = [
    { state: 'working', from: at('10:15'), to: at('10:45') },
    { state: 'working', from: at('10:15'), to: at('10:45') },
    { state: 'working', from: at('10:00'), to: at('11:00') },
  ]
  const trend = trendOf(intervals, { now: NOW, window: '24h', bucket: 'hour' })
  const ten = trend.buckets.find((b) => b.at === '2026-11-07T10:00:00.000Z')
  // 1 for 15 min, 3 for 30 min, 1 for 15 min = 120 Issue-minutes over 60
  expect(ten?.working).toEqual({ peak: 3, avg: 2 })
  // an instant sample at 10:00 or 11:00 sees 1 at most
  expect(trend.buckets.find((b) => b.at === '2026-11-07T11:00:00.000Z')?.working).toEqual({ peak: 0, avg: 0 })
})

test('watching counts as working and settling as queued; consecutive intervals of one count never count twice', () => {
  const intervals = [
    { state: 'working', from: at('08:00'), to: at('09:00') },
    { state: 'watching', from: at('09:00'), to: at('10:00') },
    { state: 'settling', from: at('08:00'), to: at('08:30') },
    { state: 'queued', from: at('08:30'), to: at('09:30') },
    { state: 'closed', from: at('10:00'), to: null },
  ]
  const trend = trendOf(intervals, { now: NOW, window: '24h', bucket: 'hour' })
  const bucket = (hh: string) => trend.buckets.find((b) => b.at === `2026-11-07T${hh}:00:00.000Z`)
  expect(bucket('08')?.working).toEqual({ peak: 1, avg: 1 })
  expect(bucket('09')?.working).toEqual({ peak: 1, avg: 1 })
  expect(bucket('10')?.working).toEqual({ peak: 0, avg: 0 })
  expect(bucket('08')?.queued).toEqual({ peak: 1, avg: 1 })
  expect(bucket('09')?.queued).toEqual({ peak: 1, avg: 0.5 })
})

test('the last bucket covers only the time that has passed; an open interval runs to now', () => {
  const trend = trendOf([{ state: 'waiting', from: at('12:15'), to: null }], {
    now: NOW,
    window: '24h',
    bucket: 'hour',
  })
  // waiting 15 of the 30 minutes that have passed in the 12:00 bucket
  expect(trend.buckets.at(-1)?.waiting).toEqual({ peak: 1, avg: 0.5 })
  expect(trend.at).toBe(NOW.toISOString())
})

test('the query: 24h by hour, 7d by hour, 30d by day; 7d by day and 30d by hour are refused', () => {
  expect(FlowTrendQuery.safeParse({}).success).toBe(true)
  expect(FlowTrendQuery.safeParse({ window: '24h', bucket: 'hour' }).success).toBe(true)
  expect(FlowTrendQuery.safeParse({ window: '7d', bucket: 'hour' }).success).toBe(true)
  expect(FlowTrendQuery.safeParse({ window: '30d' }).success).toBe(true)
  expect(FlowTrendQuery.safeParse({ window: '7d' }).success).toBe(true)
  expect(FlowTrendQuery.safeParse({ window: '7d', bucket: 'day' }).success).toBe(false)
  expect(FlowTrendQuery.safeParse({ window: '30d', bucket: 'hour' }).success).toBe(false)
  expect(FlowTrendQuery.safeParse({ window: '24h', bucket: 'day' }).success).toBe(false)
  expect(FlowTrendQuery.safeParse({ window: '90d' }).success).toBe(false)
})
