import type { SQL } from 'bun'
import type { Clock } from '../../src/clock.ts'
import type { TickMonitor } from '../../src/health.ts'
import type { Runner } from '../../src/runner.ts'
import { startTicker } from '../../src/tick.ts'

const idle: Runner = { start: () => Promise.reject(new Error('no spawn is expected')) }

/** The real ticker over an empty queue, reporting to `monitor`. */
export function startTick(sql: SQL, clock: Clock, monitor: TickMonitor) {
  const ticker = startTicker({ sql, clock, runner: idle }, 3_600_000, monitor)
  return {
    stop: ticker.stop,
    /** the first pass has been reported */
    settled: async () => {
      for (let i = 0; i < 200 && monitor.snapshot().tick.lastSuccessAt === null; i++) await Bun.sleep(10)
    },
  }
}
