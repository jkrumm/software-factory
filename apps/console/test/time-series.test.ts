import { expect, test } from 'bun:test'
import { nearestTime, runsOf } from '../src/components/kit/time-series.ts'

test('runsOf breaks a series at its gaps instead of drawing them as zero', () => {
  expect(runsOf([1, 2, null, 3, null, null, 4, 5])).toEqual([
    [0, 1],
    [3, 3],
    [6, 7],
  ])
  expect(runsOf([null, null])).toEqual([])
  expect(runsOf([])).toEqual([])
  expect(runsOf([1, 2, 3])).toEqual([[0, 2]])
})

test('nearestTime finds the closest reading and is -1 for none', () => {
  const times = [0, 60_000, 120_000, 300_000]
  expect(nearestTime(times, -5000)).toBe(0)
  expect(nearestTime(times, 70_000)).toBe(1)
  expect(nearestTime(times, 200_000)).toBe(2)
  expect(nearestTime(times, 250_000)).toBe(3)
  expect(nearestTime(times, 9_000_000)).toBe(3)
  expect(nearestTime([], 5)).toBe(-1)
})
