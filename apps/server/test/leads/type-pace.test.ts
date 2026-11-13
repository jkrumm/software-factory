import { expect, test } from 'bun:test'
import { typePacer } from '../../src/app/type-pace.ts'
import { fixedClock } from '../../src/kernel/clock.ts'

test('after a start, one note per 10 s in order; after the window, no wait', async () => {
  const clock = fixedClock('2026-11-13T18:00:00Z')
  const slept: number[] = []
  const pace = typePacer({
    clock,
    sleep: async (ms) => {
      slept.push(ms)
      clock.advance(ms)
    },
  })
  await Promise.all([pace(), pace(), pace()])
  expect(slept).toEqual([10_000, 10_000])
  clock.advance(11 * 60_000)
  await pace()
  await pace()
  expect(slept).toEqual([10_000, 10_000])
})
