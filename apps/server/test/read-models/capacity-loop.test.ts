import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CapacityLoopModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readCapacityLoop } from '../../src/read/capacity-loop.ts'

/**
 * The capacity-loop figures against plain SQL written here in another shape (scalar subqueries, FILTER, generate_series,
 * array indexing for the nearest rank) over the same rows: a figure that drifts from the read code fails one of them.
 * Seeded with the edge rows: null facts, a dry reaper row, rows outside the window, days with nothing.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-07T12:00:00Z')
const DAYS = 7
const FROM = new Date(NOW.getTime() - DAYS * 24 * 3_600_000)
const t = (iso: string): Date => new Date(`2026-${iso}:00Z`)
const constants = {
  leadsPerAccount: 3,
  loadCeiling: 8,
  slots: 2,
  slotsMax: 6,
  slotExtraLoad: 12,
  seatsMaxBonus: 2,
  reaperGraceMs: 300_000,
  swapoutCeilingMb: 2048,
  swapCeilingPct: 80,
  loadRule: 'shadow' as const,
  loadPerCore: 3,
  processCap: 1800,
  cores: 12,
}

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
  await seed()
})
afterAll(() => db.stop())

let keys = 0
async function closedIssue(id: string, filedAt: Date, closedAt: Date, outcome: string) {
  await sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES (${id}, 'app', 'closed', ${outcome}, 2)`
  const insert = (version: number, kind: string, at: Date, to: string, from: string | null) => sql`
    INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
    VALUES (${`event_${++keys}`}, ${id}, ${`key_${keys}`}, ${kind}, '{}'::jsonb, 'factory', ${at}, 'applied', ${version}, ${from}, ${to})`
  await insert(1, 'filed', filedAt, 'settling', null)
  await insert(2, 'closed', closedAt, 'closed', 'working')
}

async function seed() {
  // Issues closed: two on 11-02, one on 11-05, one before the window; one still open is not closed
  await closedIssue('issue_1', t('10-25T09:00'), t('11-02T09:00'), 'done')
  await closedIssue('issue_2', t('10-25T09:00'), t('11-02T23:59'), 'cancelled')
  await closedIssue('issue_3', t('10-25T09:00'), t('11-05T00:00'), 'done')
  await closedIssue('issue_4', t('10-20T09:00'), t('10-30T09:00'), 'done')
  await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES ('issue_5', 'app', 'queued', 1)`

  // host minutes: [at, load, ceiling, leads, queued, seats]
  const host: Array<[Date, number | null, number | null, number | null, number | null, number | null]> = [
    [t('11-02T10:00'), 9, 8, 1, 2, 3], // over the ceiling; idle 2
    [t('11-02T10:01'), 7, 8, 3, 1, 3], // idle 0
    [t('11-02T10:02'), 9, null, 1, 1, 4], // no ceiling: not over; idle 3
    [t('11-02T10:03'), null, 8, null, 1, 4], // no load, no leads: neither
    [t('11-02T10:04'), 12, 8, 4, 0, 6], // over; nothing queued: no idle
    [t('11-02T10:05'), 1, 8, 5, 3, 4], // more leads than seats: idle 0, not 1 negative
    [t('11-04T08:00'), 20, 8, 0, 5, 2], // over; idle 2
    [t('11-04T08:01'), 20, 8, 0, 5, 6], // over; idle 6
    [t('11-01T00:00'), 8, 8, 2, 0, 3], // load equal to the ceiling: not over
    [t('10-31T11:59'), 99, 1, 0, 9, 9], // before the window
    [NOW, 99, 1, 0, 9, 9], // the window ends before `now`
  ]
  for (const [at, load, ceiling, leads, queued, seats] of host)
    await sql`INSERT INTO factory.host_samples (at, load, leads, queued, seats, load_ceiling)
      VALUES (${at}, ${load}, ${leads}, ${queued}, ${seats}, ${ceiling})`

  // the memory gate was shut in two of those minutes: swapouts above the ceiling (idle 2), swap in use above it (idle 6)
  await sql`UPDATE factory.host_samples SET swapout_mb_per_300s = 3000 WHERE at = ${t('11-04T08:00')}`
  await sql`UPDATE factory.host_samples SET swapout_mb_per_300s = 100, swap_used_pct = 95 WHERE at = ${t('11-04T08:01')}`
  await sql`UPDATE factory.host_samples SET swapout_mb_per_300s = 4000 WHERE at = ${t('11-02T10:04')}` // nothing queued: no idle

  // test-slot steps: [at, name, peak, duration, wait]
  const steps: Array<[Date, string, number | null, number, number]> = [
    [t('11-02T10:00'), 'software-factory check', 3000, 600_000, 1000],
    [t('11-02T10:10'), 'software-factory check', 4000, 700_000, 5000],
    [t('11-04T08:00'), 'software-factory check', 3500, 650_000, 3000],
    [t('11-04T08:10'), 'software-factory test', 1200, 100_000, 200],
    [t('11-05T09:00'), 'software-factory test', null, 90_000, 400], // peak unread: counts for the wait, not for memory
    [t('10-30T09:00'), 'software-factory check', 9999, 1, 99_999], // before the window
    ...Array.from({ length: 9 }, (_, i): [Date, string, number | null, number, number] => [
      t('11-05T10:00'),
      `step ${i + 1}`,
      100 * (i + 1),
      1000 * (i + 1),
      10 * (i + 1),
    ]),
  ]
  for (const [at, name, peak, duration, wait] of steps)
    await sql`INSERT INTO factory.step_costs (at, name, peak_rss_mib, duration_ms, wait_ms)
      VALUES (${at}, ${name}, ${peak}, ${duration}, ${wait})`

  // lead processes: repo alpha has 3 attempts, repo beta 12 (only the newest 10 count), minute samples per attempt
  const lead = async (repo: string, n: number, peakOf: (i: number) => number) => {
    for (let i = 1; i <= n; i++) {
      for (let m = 0; m < 3; m++)
        await sql`INSERT INTO factory.lead_samples (at, worktree, repo, issue, attempt, rss_mib, procs)
          VALUES (${new Date(t('11-01T00:00').getTime() + (i * 60 + m) * 60_000)}, ${`/wt/${repo}-${i}`}, ${repo}, ${i}, 1,
            ${Math.round((peakOf(i) * (m + 1)) / 3)}, 5)`
    }
  }
  await lead('alpha', 3, (i) => 1000 * i)
  await lead('beta', 12, (i) => 500 + 37 * ((i * 7) % 12))

  // reaper: 6 signalled in the window (the newest 5 are listed), one dry, one before the window
  const reaped: Array<[Date, number, string, string]> = [
    [t('11-02T10:00'), 1, 'SIGTERM', 'session'],
    [t('11-02T10:01'), 2, 'SIGKILL', 'worktree'],
    [t('11-02T10:02'), 3, 'dry', 'session'],
    [t('11-05T09:00'), 4, 'SIGTERM', 'session'],
    [t('11-05T09:01'), 5, 'SIGTERM', 'worktree'],
    [t('11-05T09:02'), 6, 'SIGKILL', 'session'],
    [t('11-06T09:00'), 7, 'SIGTERM', 'session'],
    [t('10-29T09:00'), 8, 'SIGKILL', 'session'],
  ]
  for (const [at, pid, signal, reason] of reaped)
    await sql`INSERT INTO factory.reaped_processes (at, pid, session, worktree, comm, signal, reason, age_s)
      VALUES (${at}, ${pid}, ${`lead-${pid}-1`}, '/wt/x', ${`proc${pid}`}, ${signal}, ${reason}, 600)`
}

/** The UTC dates of the window, one row each, with the figure of that day from a scalar subquery. */
async function daily(figure: string): Promise<Array<{ day: string; value: number | null }>> {
  const rows: Array<{ day: string; value: string | number | null }> = await sql.unsafe(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day, (${figure}) AS value
     FROM generate_series(date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC'), date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC'), interval '1 day') AS g(d)
     ORDER BY d`,
    [FROM, NOW],
  )
  return rows.map((r) => ({ day: r.day, value: r.value === null ? null : Number(r.value) }))
}
const inDay = (col: string) => `(${col} AT TIME ZONE 'UTC')::date = g.d::date AND ${col} >= $1 AND ${col} < $2`
const inWindow = (col: string) => `${col} >= $1 AND ${col} < $2`

/** One figure of a query over the window; NaN when the query found none, which no assertion accepts. */
async function scalar(query: string): Promise<number> {
  const [row] = await sql.unsafe(query, [FROM, NOW])
  const value = (row as { v: string | number | null }).v
  return value === null ? Number.NaN : Number(value)
}

type Days = Array<{ day: string; value: number | null }>
function expectDays(got: Days, want: Days, digits: number) {
  expect(got).toHaveLength(want.length)
  got.forEach((d, i) => {
    const w = want[i]
    if (!w) throw new Error(`no expected figure for ${d.day}`)
    expect(d.day).toBe(w.day)
    if (w.value === null) expect(d.value).toBeNull()
    else expect(d.value).toBeCloseTo(w.value, digits)
  })
}

describe('GET /v1/capacity-loop figures', () => {
  test('every figure equals plain SQL over the same rows', async () => {
    const model = CapacityLoopModel.parse(await readCapacityLoop(sql, { now: NOW, days: DAYS, constants }))

    // the window's days, 10-31 to 11-07, each present once
    expect(model.throughput.perDay.map((d) => d.day)).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
    ])

    // throughput
    expect(model.throughput.total).toBe(
      await scalar(
        `SELECT count(*) AS v FROM factory.issue_events e WHERE e.to_state = 'closed' AND e.result = 'applied' AND ${inWindow('e.at')}`,
      ),
    )
    expect(model.throughput.perDay).toEqual(
      await daily(
        `SELECT count(*) AS v FROM factory.issue_events e WHERE e.to_state = 'closed' AND e.result = 'applied' AND ${inDay('e.at')}`,
      ),
    )
    expect(model.throughput.total).toBe(3)

    // idle seat-hours
    const idle = (col: string) =>
      `SELECT coalesce(sum(CASE WHEN s.seats > s.leads THEN s.seats - s.leads ELSE 0 END), 0) / 60.0 AS v FROM factory.host_samples s WHERE s.queued > 0 AND num_nonnulls(s.seats, s.leads) = 2 AND ${col}`
    expect(model.idleSeatHours.total).toBeCloseTo(await scalar(idle(inWindow('s.at'))), 9)
    expectDays(model.idleSeatHours.perDay, await daily(idle(inDay('s.at'))), 9)
    expect(model.idleSeatHours.total).toBeCloseTo(13 / 60, 9)
    expect(model.idleSeatHoursMemory.total).toBeCloseTo(8 / 60, 9)
    expect(model.idleSeatHoursMemory.swapout).toBeCloseTo(2 / 60, 9)
    expect(model.idleSeatHoursMemory.swapUsed).toBeCloseTo(6 / 60, 9)

    // minutes over the load ceiling
    const over = (col: string) =>
      `SELECT count(*) FILTER (WHERE s.load > s.load_ceiling) AS v FROM factory.host_samples s WHERE ${col}`
    expect(model.minutesOverCeiling.total).toBe(await scalar(over(inWindow('s.at'))))
    expect(model.minutesOverCeiling.perDay).toEqual(await daily(over(inDay('s.at'))))
    expect(model.minutesOverCeiling.total).toBe(4)

    // slot wait
    const wait = (p: number, col: string) =>
      `SELECT percentile_cont(${p}) WITHIN GROUP (ORDER BY c.wait_ms) AS v FROM factory.step_costs c WHERE ${col}`
    expect(model.slotWait.n).toBe(
      await scalar(`SELECT count(*) AS v FROM factory.step_costs c WHERE ${inWindow('c.at')}`),
    )
    expect(model.slotWait.p50Ms).toBeCloseTo(await scalar(wait(0.5, inWindow('c.at'))), 6)
    expect(model.slotWait.p90Ms).toBeCloseTo(await scalar(wait(0.9, inWindow('c.at'))), 6)
    expectDays(model.slotWait.perDayP50, await daily(wait(0.5, inDay('c.at'))), 6)
    // a day with no steps is null, not 0
    expect(model.slotWait.perDayP50.find((d) => d.day === '2026-11-03')?.value).toBeNull()

    // top steps by memory
    const stepRows: Array<Record<string, string | number>> = await sql.unsafe(
      `SELECT n.name,
         (SELECT count(*) FROM factory.step_costs c WHERE c.name = n.name AND c.peak_rss_mib IS NOT NULL AND ${inWindow('c.at')}) AS runs,
         (SELECT max(c.peak_rss_mib) FROM factory.step_costs c WHERE c.name = n.name AND ${inWindow('c.at')}) AS max_peak,
         (SELECT percentile_cont(0.8) WITHIN GROUP (ORDER BY c.peak_rss_mib) FROM factory.step_costs c WHERE c.name = n.name AND ${inWindow('c.at')}) AS p80,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY c.duration_ms) FROM factory.step_costs c WHERE c.name = n.name AND c.peak_rss_mib IS NOT NULL AND ${inWindow('c.at')}) AS dur,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY c.wait_ms) AS v FROM factory.step_costs c WHERE c.name = n.name AND c.peak_rss_mib IS NOT NULL AND ${inWindow('c.at')}) AS wait
       FROM (SELECT DISTINCT name FROM factory.step_costs WHERE ${inWindow('at')} AND peak_rss_mib IS NOT NULL) n
       ORDER BY max_peak DESC, n.name LIMIT 8`,
      [FROM, NOW],
    )
    expect(model.topSteps).toHaveLength(8)
    expect(model.topSteps).toEqual(
      stepRows.map((r) => ({
        name: String(r.name),
        runs: Number(r.runs),
        maxPeakMib: Number(r.max_peak),
        p80PeakMib: Number(r.p80),
        medianDurationMs: Number(r.dur),
        medianWaitMs: Number(r.wait),
      })),
    )
    expect(model.topSteps[0]).toMatchObject({ name: 'software-factory check', runs: 3, maxPeakMib: 4000 })

    // lead costs: peak per worktree, the newest 10 attempts, nearest rank 0.8, the newest attempt's peak
    const leadRows: Array<Record<string, string | number>> = await sql.unsafe(
      `SELECT r.repo,
         (SELECT count(DISTINCT worktree) FROM factory.lead_samples WHERE repo = r.repo) AS attempts,
         (SELECT array_agg(p ORDER BY p) FROM (
            SELECT max(rss_mib) AS p FROM factory.lead_samples WHERE repo = r.repo
            GROUP BY worktree ORDER BY max(at) DESC, worktree LIMIT 10) k) AS sorted,
         (SELECT max(rss_mib) FROM factory.lead_samples WHERE repo = r.repo
            AND worktree = (SELECT worktree FROM factory.lead_samples WHERE repo = r.repo ORDER BY at DESC, worktree LIMIT 1)) AS last_peak
       FROM (SELECT DISTINCT repo FROM factory.lead_samples) r`,
    )
    const expectedLeads = leadRows
      .map((r) => {
        const sorted = (r.sorted as unknown as Array<number | string>).map(Number)
        return {
          repo: String(r.repo),
          attempts: Number(r.attempts),
          peakMibP80: sorted[Math.ceil(0.8 * sorted.length) - 1] ?? Number.NaN,
          lastPeakMib: Number(r.last_peak),
          footprintAttempts: 0,
          footprintMibP80: null,
          lastFootprintMib: null,
          footprintToRss: null,
          restMibP50: null,
          restMinutes: 0,
        }
      })
      .sort((a, b) => b.peakMibP80 - a.peakMibP80 || a.repo.localeCompare(b.repo))
    expect(model.leadCosts).toEqual(expectedLeads)
    expect(model.leadCosts.map((l) => l.attempts).sort()).toEqual([12, 3])

    // reaped: signalled only
    const signalled = `r.signal IN ('SIGTERM', 'SIGKILL')`
    expect(model.reaped.total).toBe(
      await scalar(`SELECT count(*) AS v FROM factory.reaped_processes r WHERE ${signalled} AND ${inWindow('r.at')}`),
    )
    expect(model.reaped.perDay).toEqual(
      await daily(`SELECT count(*) AS v FROM factory.reaped_processes r WHERE ${signalled} AND ${inDay('r.at')}`),
    )
    expect(model.reaped.total).toBe(6)
    const newest: Array<{ comm: string; session: string; reason: 'session' | 'worktree'; at: Date }> = await sql.unsafe(
      `SELECT comm, session, reason, at FROM factory.reaped_processes r WHERE r.signal <> 'dry' AND ${inWindow('r.at')} ORDER BY r.at DESC LIMIT 5`,
      [FROM, NOW],
    )
    expect(model.reaped.newest).toEqual(newest.map((r) => ({ ...r, at: r.at.toISOString() })))
    expect(model.reaped.newest.map((r) => r.comm)).toEqual(['proc7', 'proc6', 'proc5', 'proc4', 'proc2'])

    expect(model.constants).toEqual(constants)
  })

  test('an empty database answers zeros and nulls, never an error', async () => {
    const empty = await startTestCluster()
    try {
      await migrate(empty.sql, await loadMigrations())
      const model = CapacityLoopModel.parse(await readCapacityLoop(empty.sql, { now: NOW, days: 1, constants }))
      expect(model.throughput.total).toBe(0)
      expect(model.slotWait).toMatchObject({ n: 0, p50Ms: null, p90Ms: null })
      expect(model.topSteps).toEqual([])
      expect(model.leadCosts).toEqual([])
      expect(model.reaped).toMatchObject({ total: 0, newest: [] })
    } finally {
      await empty.stop()
    }
  })
})
