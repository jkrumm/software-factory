import { expect, test } from 'bun:test'
import type { LoopName } from '@software-factory/contract'
import { createLoopRunner, type LoopSpec } from '../../src/app/loops/runner.ts'
import { fixedClock } from '../../src/kernel/clock.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'

const clock = fixedClock('2026-11-07T10:00:00Z')

function spec(name: LoopName, over: Partial<LoopSpec> & { counts?: { runs: number } } = {}): LoopSpec {
  const counts = over.counts ?? { runs: 0 }
  return {
    name,
    intervalMs: 0,
    onChange: true,
    run: async () => {
      counts.runs++
      return ok(`pass ${counts.runs}`)
    },
    ...over,
  }
}

const quiet = { log: () => {} }

test('a loop with no interval runs only when asked, and no kick starts it', async () => {
  const counts = { runs: 0 }
  const runner = createLoopRunner({ loops: [spec('steward', { counts })], clock, ...quiet })
  void runner.start()
  runner.changed(null)
  await Bun.sleep(30)
  expect(counts.runs).toBe(0)
  expect(await runner.runNow('steward')).toEqual({ started: true, summary: 'pass 1', error: null })
  expect(counts.runs).toBe(1)
  expect(await runner.runNow('triage')).toBeNull()
})

test('single-flight: a pass asked for while one runs is waited for, not started again', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const counts = { runs: 0 }
  const runner = createLoopRunner({
    loops: [
      spec('steward', {
        counts,
        run: async () => {
          counts.runs++
          await gate
          return ok('slow')
        },
      }),
    ],
    clock,
    ...quiet,
  })
  const first = runner.runNow('steward')
  await Bun.sleep(10)
  const second = runner.runNow('steward')
  release()
  expect((await first)?.started).toBe(true)
  expect((await second)?.started).toBe(false)
  expect(counts.runs).toBe(1)
})

test('a kick starts a pass of every loop that listens, but the loop that made the change', async () => {
  const a = { runs: 0 }
  const b = { runs: 0 }
  const deaf = { runs: 0 }
  const runner = createLoopRunner({
    loops: [
      spec('steward', { counts: a, intervalMs: 3_600_000 }),
      spec('triage', { counts: b, intervalMs: 3_600_000 }),
      spec('watch', { counts: deaf, intervalMs: 3_600_000, onChange: false }),
    ],
    clock,
    ...quiet,
  })
  runner.changed('steward')
  await Bun.sleep(30)
  expect([a.runs, b.runs, deaf.runs]).toEqual([0, 1, 0])
  const view = runner.view()
  expect(view.find((l) => l.name === 'steward')).toMatchObject({ kicks: 0, droppedKicks: 1 })
  expect(view.find((l) => l.name === 'triage')).toMatchObject({ kicks: 1, droppedKicks: 0, runs: 1 })
  await runner.stop()
})

test('a kick during a pass runs one more pass after it, however many came', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const counts = { runs: 0 }
  const runner = createLoopRunner({
    loops: [
      spec('triage', {
        counts,
        intervalMs: 3_600_000,
        run: async () => {
          counts.runs++
          if (counts.runs === 1) await gate
          return ok('x')
        },
      }),
    ],
    clock,
    ...quiet,
  })
  runner.changed(null)
  await Bun.sleep(10)
  runner.changed(null)
  runner.changed(null)
  release()
  await runner.stop()
  expect(counts.runs).toBe(2)
})

test('the interval starts passes, never two at once, and stop waits for the one in flight', async () => {
  const counts = { runs: 0 }
  let active = 0
  let overlapped = false
  const runner = createLoopRunner({
    loops: [
      spec('leads', {
        counts,
        intervalMs: 10,
        run: async () => {
          counts.runs++
          overlapped ||= ++active > 1
          await Bun.sleep(35)
          active--
          return ok('tick')
        },
      }),
    ],
    clock,
    ...quiet,
  })
  void runner.start()
  await Bun.sleep(150)
  await runner.stop()
  expect(counts.runs).toBeGreaterThan(1)
  expect(overlapped).toBe(false)
  expect(active).toBe(0)
})

test('maxPasses lets a slow pass run beside the next one', async () => {
  let active = 0
  let peak = 0
  const runner = createLoopRunner({
    loops: [
      spec('leads', {
        maxPasses: 3,
        intervalMs: 10,
        run: async () => {
          peak = Math.max(peak, ++active)
          await Bun.sleep(60)
          active--
          return ok('tick')
        },
      }),
    ],
    clock,
    ...quiet,
  })
  void runner.start()
  await Bun.sleep(120)
  await runner.stop()
  expect(peak).toBe(3)
})

test('lastOkAt moves only on an ok pass; a failure or a throw is the last error, said once', async () => {
  const lines: string[] = []
  let mode: 'ok' | 'fail' | 'throw' = 'ok'
  const runner = createLoopRunner({
    loops: [
      spec('leads', {
        run: async () => {
          if (mode === 'throw') throw new Error('boom')
          return mode === 'ok' ? ok('fine') : err(portError('gone', 'the database is down'))
        },
      }),
    ],
    clock,
    log: (line) => lines.push(line),
  })
  expect(runner.lastOkAt('leads')).toBeNull()
  await runner.runNow('leads')
  const okAt = runner.lastOkAt('leads')
  expect(okAt).toEqual(new Date('2026-11-07T10:00:00Z'))
  clock.advance(60_000)
  mode = 'fail'
  await runner.runNow('leads')
  await runner.runNow('leads')
  expect(runner.lastOkAt('leads')).toEqual(okAt)
  expect(runner.view()[0]).toMatchObject({ lastError: 'gone: the database is down', runs: 3 })
  mode = 'throw'
  await runner.runNow('leads')
  expect(runner.view()[0]?.lastError).toBe('crashed: boom')
  expect(lines).toEqual(['loop leads: gone: the database is down', 'loop leads: crashed: boom'])
})

test('stop gives a pass in flight its grace and no more: an agw call is taken up again at the next boot', async () => {
  const runner = createLoopRunner({
    loops: [
      spec('steward', {
        run: async () => {
          await Bun.sleep(2_000)
          return ok('slow')
        },
      }),
    ],
    clock,
    ...quiet,
  })
  void runner.runNow('steward')
  await Bun.sleep(10)
  const started = Date.now()
  await runner.stop(100)
  expect(Date.now() - started).toBeLessThan(1_000)
})

// ---- scheduling from the last recorded pass ---------------------------------------------------------------------------

function fakePasses(recorded: [LoopName, Date][], load?: () => Promise<never>) {
  const written: [LoopName, Date][] = []
  return {
    written,
    load: load ?? (async () => new Map<LoopName, Date>(recorded)),
    record: async (name: LoopName, at: Date) => {
      written.push([name, at])
    },
  }
}

test('a loop with a long interval that never ran runs on the first tick after start', async () => {
  const counts = { runs: 0 }
  const runner = createLoopRunner({
    loops: [spec('fix-classes', { counts, intervalMs: 6 * 3_600_000 })],
    clock,
    passes: fakePasses([]),
    ...quiet,
  })
  await runner.start()
  await Bun.sleep(30)
  await runner.stop()
  expect(counts.runs).toBe(1)
})

test('a loop whose pass was an hour ago does not run after start', async () => {
  const counts = { runs: 0 }
  const runner = createLoopRunner({
    loops: [spec('fix-classes', { counts, intervalMs: 6 * 3_600_000 })],
    clock,
    passes: fakePasses([['fix-classes', new Date(clock.now().getTime() - 3_600_000)]]),
    ...quiet,
  })
  await runner.start()
  await Bun.sleep(50)
  await runner.stop()
  expect(counts.runs).toBe(0)
})

test('the first tick comes after the time left of the interval, not a whole interval', async () => {
  const counts = { runs: 0 }
  const runner = createLoopRunner({
    loops: [spec('steward', { counts, intervalMs: 1_000 })],
    clock,
    passes: fakePasses([['steward', new Date(clock.now().getTime() - 600)]]),
    ...quiet,
  })
  await runner.start()
  await Bun.sleep(300)
  expect(counts.runs).toBe(0)
  await Bun.sleep(300)
  expect(counts.runs).toBe(1)
  await runner.stop()
})

test('a loop whose last pass is older than its interval runs on the first tick', async () => {
  const counts = { runs: 0 }
  const runner = createLoopRunner({
    loops: [spec('steward', { counts, intervalMs: 1_000 })],
    clock,
    passes: fakePasses([['steward', new Date(clock.now().getTime() - 5_000)]]),
    ...quiet,
  })
  await runner.start()
  await Bun.sleep(30)
  await runner.stop()
  expect(counts.runs).toBe(1)
})

test('every pass is recorded with the clock time, a failed one and a run asked for included', async () => {
  const passes = fakePasses([])
  const failing = spec('steward', { run: async () => err(portError('gone', 'gone')) })
  const runner = createLoopRunner({ loops: [failing, spec('triage')], clock, passes, ...quiet })
  await runner.runNow('steward')
  await runner.runNow('triage')
  expect(passes.written).toEqual([
    ['steward', clock.now()],
    ['triage', clock.now()],
  ])
})

test('a record that cannot be written is logged, and the pass still ends', async () => {
  const logged: string[] = []
  const runner = createLoopRunner({
    loops: [spec('steward')],
    clock,
    passes: {
      load: async () => new Map(),
      record: async () => {
        throw new Error('db down')
      },
    },
    log: (message) => logged.push(message),
  })
  expect((await runner.runNow('steward'))?.error).toBeNull()
  expect(logged.some((line) => line.includes('db down'))).toBe(true)
})

test('a load that fails is logged and the loops are scheduled from boot', async () => {
  const logged: string[] = []
  const counts = { runs: 0 }
  const runner = createLoopRunner({
    loops: [spec('steward', { counts, intervalMs: 40 })],
    clock,
    passes: fakePasses([], async () => {
      throw new Error('no table')
    }),
    log: (message) => logged.push(message),
  })
  await runner.start()
  expect(logged.some((line) => line.includes('no table'))).toBe(true)
  await Bun.sleep(10)
  expect(counts.runs).toBe(0)
  await Bun.sleep(100)
  await runner.stop()
  expect(counts.runs).toBeGreaterThanOrEqual(1)
})

test('view().lastPassAt is seeded from the record and moves with a pass', async () => {
  const seeded = new Date('2026-11-07T08:00:00Z')
  const runner = createLoopRunner({
    loops: [spec('steward'), spec('triage')],
    clock,
    passes: fakePasses([['steward', seeded]]),
    ...quiet,
  })
  await runner.start()
  expect(runner.view().map((loop) => loop.lastPassAt)).toEqual([seeded.toISOString(), null])
  await runner.runNow('steward')
  expect(runner.view()[0]?.lastPassAt).toBe(clock.now().toISOString())
})
