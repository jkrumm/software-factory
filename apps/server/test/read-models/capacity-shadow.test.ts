import { afterAll, beforeAll, expect, test } from 'bun:test'
import { CapacityLoopModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readCapacityLoop } from '../../src/read/capacity-loop.ts'
import { readLeadCosts } from '../../src/read/lead-costs.ts'

/**
 * The shadow table, the swapout and pressure figures and the lead's cost at rest, over rows seeded in the figures' own
 * minutes (the shadow decisions are stamped at the minute, the host samples some seconds into it).
 */
let db: TestCluster
const NOW = new Date('2026-11-14T12:00:00Z')
const minute = (m: number): Date => new Date(NOW.getTime() - m * 60_000)
const constants = {
  leadsPerAccount: 3,
  loadCeiling: 120,
  slots: 2,
  slotsMax: 6,
  slotExtraLoad: 12,
  seatsMaxBonus: 2,
  reaperGraceMs: 300_000,
  swapoutCeilingMb: 2048,
  swapCeilingPct: 75,
  loadRule: 'shadow' as const,
  loadPerCore: 3,
  processCap: 1800,
  cores: 12,
  slotAim: 'shadow' as const,
}

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
})
afterAll(() => db.stop())

test('the shadow minutes are counted by whether the shadow rule would admit more or fewer, with the host beside them', async () => {
  const { sql } = db
  // minute, live admits, shadow admits, swapouts of the host sample, pressure level
  const rows: [number, number, number, number, number][] = [
    [10, 1, 2, 5000, 2],
    [9, 1, 2, 1000, 1],
    [8, 1, 1, 0, 1],
    [7, 2, 0, 600, 1],
    [6, 0, 0, 20, 4],
  ]
  for (const [m, live, shadow, swapout, level] of rows) {
    await sql`
      INSERT INTO factory.admission_shadow (at, candidates, live_admits, shadow_admits, load_ceiling, shadow_load_ceiling, process_cap)
      VALUES (${minute(m)}, 2, ${live}, ${shadow}, 120, 36, 1800)`
    await sql`
      INSERT INTO factory.host_samples (at, swapout_mb_per_300s, pressure_level)
      VALUES (${new Date(minute(m).getTime() + 20_000)}, ${swapout}, ${level})`
  }
  // a shadow row outside the window is not counted
  await sql`
    INSERT INTO factory.admission_shadow (at, candidates, live_admits, shadow_admits, load_ceiling, shadow_load_ceiling, process_cap)
    VALUES (${new Date(NOW.getTime() - 3 * 86_400_000)}, 1, 0, 1, 120, 36, 1800)`

  const model = CapacityLoopModel.parse(await readCapacityLoop(db.sql, { now: NOW, days: 1, constants }))
  expect(model.shadow).toMatchObject({
    minutes: 5,
    firstAt: minute(10).toISOString(),
    lastAt: minute(6).toISOString(),
    shadowMore: { total: 2 },
    shadowFewer: { total: 1 },
    whenMore: { minutes: 2, swapoutMbAvg: 3000, swapoutMbMax: 5000, pressureLevelMax: 2, pressureMinutes: 1 },
    whenFewer: { minutes: 1, swapoutMbAvg: 600, swapoutMbMax: 600, pressureLevelMax: 1, pressureMinutes: 0 },
    whenSame: { minutes: 2, swapoutMbAvg: 10, swapoutMbMax: 20, pressureLevelMax: 4, pressureMinutes: 1 },
  })
  // MiB swapped out: each minute's figure is scaled to 300 s, so a fifth of it is that minute's
  expect(model.swapoutMib.total).toBe((5000 + 1000 + 0 + 600 + 20) / 5)
  expect(model.minutesUnderPressure.total).toBe(2)
  expect(model.constants).toEqual(constants)
})

test('a lead at rest is a lead row of a minute in which no step of its Issue ran', async () => {
  const { sql } = db
  const row = (m: number, cls: 'lead' | 'step', repo: string, issue: number, mib: number) =>
    sql`
      INSERT INTO factory.host_class_samples (at, class, repo, issue, step, footprint_mib, procs)
      VALUES (${minute(m)}, ${cls}, ${repo}, ${issue}, ${cls === 'step' ? 'make check' : null}, ${mib}, 1)`
  // issue 1 of app: 300, 340 and 900 MiB at rest, and 2000 with a step running (not at rest); issue 2 runs a step in the same minute as issue 1's rest
  await row(30, 'lead', 'app', 1, 300)
  await row(29, 'lead', 'app', 1, 340)
  await row(28, 'lead', 'app', 1, 900)
  await row(27, 'lead', 'app', 1, 2000)
  await row(27, 'step', 'app', 1, 3000)
  await row(30, 'lead', 'app', 2, 500)
  await row(30, 'step', 'app', 2, 1500)
  // a lead whose repo has no lead_samples attempt is not listed: the figure sits beside the learned peak
  await sql`INSERT INTO factory.lead_samples (at, worktree, repo, rss_mib, procs) VALUES (${minute(40)}, 'w1', 'app', 4000, 2)`
  expect(await readLeadCosts(sql)).toMatchObject([{ repo: 'app', restMibP50: 340, restMinutes: 3 }])
})
