import { expect, test } from 'bun:test'
import { BACKOFF_MAX_MS, nextBackoff, trailingDebounce, type Scheduler } from '../src/lib/debounce.ts'

function fakeClock() {
  let now = 0
  let next = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const scheduler: Scheduler = {
    set(run, ms) {
      timers.set(++next, { at: now + ms, run })
      return next
    },
    clear(handle) {
      timers.delete(handle as number)
    },
  }
  const advance = (ms: number) => {
    now += ms
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue
      timers.delete(id)
      timer.run()
    }
  }
  return { scheduler, advance }
}

test('a burst of changes invalidates once, after the last one', () => {
  const clock = fakeClock()
  let runs = 0
  const debounce = trailingDebounce(() => runs++, 250, clock.scheduler)
  debounce.call()
  clock.advance(200)
  debounce.call()
  clock.advance(200)
  expect(runs).toBe(0)
  clock.advance(50)
  expect(runs).toBe(1)
  clock.advance(1000)
  expect(runs).toBe(1)
})

test('a later change starts a new run; cancel drops the pending one', () => {
  const clock = fakeClock()
  let runs = 0
  const debounce = trailingDebounce(() => runs++, 250, clock.scheduler)
  debounce.call()
  clock.advance(250)
  debounce.call()
  debounce.cancel()
  clock.advance(1000)
  expect(runs).toBe(1)
})

test('the reconnect wait starts at 1 s, doubles and stops at 30 s', () => {
  const waits: number[] = []
  let wait: number | undefined
  for (let i = 0; i < 8; i++) waits.push((wait = nextBackoff(wait)))
  expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, BACKOFF_MAX_MS, BACKOFF_MAX_MS, BACKOFF_MAX_MS])
})

test('with a max wait, a steady stream still runs every max wait', () => {
  const clock = fakeClock()
  let runs = 0
  const debounce = trailingDebounce(() => runs++, 250, clock.scheduler, 1000)
  for (let i = 0; i < 9; i++) {
    debounce.call()
    clock.advance(100)
  }
  expect(runs).toBe(0)
  debounce.call()
  clock.advance(100)
  expect(runs).toBe(1)
  for (let i = 0; i < 10; i++) {
    debounce.call()
    clock.advance(100)
  }
  expect(runs).toBe(2)
})

test('with a max wait, a burst that pauses runs once, on the trailing edge, and the ceiling does not fire again', () => {
  const clock = fakeClock()
  let runs = 0
  const debounce = trailingDebounce(() => runs++, 250, clock.scheduler, 1000)
  debounce.call()
  clock.advance(100)
  debounce.call()
  clock.advance(250)
  expect(runs).toBe(1)
  clock.advance(5000)
  expect(runs).toBe(1)
})

test('cancel drops the max wait too', () => {
  const clock = fakeClock()
  let runs = 0
  const debounce = trailingDebounce(() => runs++, 250, clock.scheduler, 1000)
  debounce.call()
  debounce.cancel()
  clock.advance(5000)
  expect(runs).toBe(0)
})
