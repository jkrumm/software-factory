import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readThroughput } from '../../src/read/throughput.ts'

/**
 * `tests.remote`: the steps declared remote with their runs per host and placements, the hold a disagreement put them
 * under (with its end), what the red run failed on, and the pressure line with the baseline it comes from.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-17T15:00:00Z')
const at = (hhmm: string): Date => new Date(`2026-11-17T${hhmm}:00Z`)

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
})
afterAll(() => db.stop())

const cost = (
  when: Date,
  host: string | null,
  exit: number,
  extra: { disagreed?: boolean; disagreement?: object } = {},
) =>
  sql`
    INSERT INTO factory.step_costs (at, name, repo, duration_ms, wait_ms, exit_code, host, disagreed, disagreement)
    VALUES (${when}, 'basalt-ui unit', 'basalt-ui', 400000, 0, ${exit}, ${host}, ${extra.disagreed ?? null},
      ${extra.disagreement === undefined ? null : JSON.stringify(extra.disagreement)}::text::jsonb)`
const placed = (when: Date, host: string, reason: string) =>
  sql`INSERT INTO factory.step_placements (at, name, host, reason) VALUES (${when}, 'basalt-ui unit', ${host}, ${reason})`

describe('the remote steps of the Throughput read', () => {
  test('no step placed off the mini: no row, the default line, no baseline', async () => {
    const { tests } = await readThroughput(sql, { now: NOW, hours: 24 })
    expect(tests.remote).toEqual({ pressure: { memoryPct: 1, ioPct: 1, from: 'default', baseline: null }, steps: [] })
  })

  test('a step with a disagreement: runs, placements, the hold with its end, and the failing test', async () => {
    await cost(at('13:00'), 'vps', 1)
    await cost(at('13:20'), 'mini', 0, {
      disagreed: true,
      disagreement: { tests: [{ name: 'a.test.ts > slow one', durationMs: 5200, timeoutMs: 5000 }], tail: null },
    })
    await cost(at('14:00'), 'vps', 0)
    await placed(at('13:00'), 'vps', 'vps')
    await placed(at('13:21'), 'mini', 'held')
    await placed(at('14:30'), 'mini', 'no_room')
    await placed(at('14:31'), 'mini', 'free')
    const { tests } = await readThroughput(sql, { now: NOW, hours: 24 })
    expect(tests.remote.steps).toEqual([
      {
        step: 'basalt-ui unit',
        miniRuns: 1,
        vpsRuns: 2,
        placed: { vps: 1, free: 1, noRoom: 1, notSooner: 0, held: 1 },
        hold: { active: false, holdMs: 3_600_000, until: '2026-11-17T14:20:00.000Z', disagreements: 1 },
        lastDisagreement: {
          at: '2026-11-17T13:20:00.000Z',
          tests: [{ name: 'a.test.ts > slow one', durationMs: 5200, timeoutMs: 5000 }],
          tail: null,
        },
      },
    ])
    // while it runs, the read says so
    const during = await readThroughput(sql, { now: at('13:50'), hours: 24 })
    expect(during.tests.remote.steps[0]?.hold).toMatchObject({ active: true, until: '2026-11-17T14:20:00.000Z' })
  })

  test('with a day of samples and no step running the line is just above their p99, and the baseline is shown', async () => {
    await sql`
      INSERT INTO factory.remote_samples (at, memory_pressure, io_pressure, steps_running)
      SELECT ${new Date(NOW.getTime() - 26 * 3_600_000)}::timestamptz + (n * interval '5 minutes'), 0, 0.2, 0
      FROM generate_series(0, 299) AS n`
    await sql`INSERT INTO factory.remote_samples (at, memory_pressure, io_pressure, steps_running) VALUES (${at('14:10')}, 40, 40, 3)`
    const { tests } = await readThroughput(sql, { now: NOW, hours: 24 })
    expect(tests.remote.pressure).toEqual({
      memoryPct: 0.5,
      ioPct: 0.7,
      from: 'baseline',
      baseline: { samples: 300, spanHours: 24.9, memoryP99: 0, ioP99: 0.2 },
    })
  })
})
