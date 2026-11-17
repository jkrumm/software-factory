import { expect, test } from 'bun:test'
import { freshFor } from '../src/kernel/fresh-for.ts'

test('freshFor: concurrent callers share one run, an answer is reused until it is stale', async () => {
  let clock = 0
  let runs = 0
  const read = freshFor(
    1_000,
    async () => {
      runs += 1
      return runs
    },
    () => clock,
  )
  expect(await Promise.all([read(), read(), read()])).toEqual([1, 1, 1])
  clock = 999
  expect(await read()).toBe(1)
  clock = 1_000
  expect(await read()).toBe(2)
  expect(runs).toBe(2)
})

test('freshFor: a rejected run is not kept, the next call reads again', async () => {
  let runs = 0
  const read = freshFor(60_000, async () => {
    runs += 1
    if (runs === 1) throw new Error('down')
    return runs
  })
  const failed = await read().catch((error: unknown) => error)
  expect(failed).toBeInstanceOf(Error)
  expect(await read()).toBe(2)
  expect(await read()).toBe(2)
  expect(runs).toBe(2)
})
