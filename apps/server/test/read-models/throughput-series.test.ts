import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ReadSessionCards, ThroughputModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { deriveSession } from '../../src/domains/leads/session.ts'
import { fixedClock } from '../../src/kernel/clock.ts'
import { readHostSamples } from '../../src/read/host.ts'
import { createReader } from '../../src/read/reader.ts'
import { readThroughput } from '../../src/read/throughput.ts'
import { redactThroughput } from '../../src/read/throughput-redact.ts'

/**
 * The series a retro needs, over rows seeded by hand: leads running and Issues queued at each bucket start (by repo and by
 * reason), the host samples' peaks and CPU split, the maxima beside the p90s, and session paging.
 */
let db: TestCluster
const NOW = new Date('2026-11-07T12:00:00Z')
const t = (hhmm: string): Date => new Date(`2026-11-07T${hhmm}:00Z`)

beforeAll(async () => {
  db = await startTestCluster()
  const { sql } = db
  await migrate(sql, await loadMigrations())
  await sql`INSERT INTO factory.planning_projects (name, repo, source, project) VALUES ('app', '/src/app', 'file', '{}')`
  for (const [n, repo] of [
    [1, 'app'],
    [2, 'lib'],
    [3, 'app'],
  ] as const)
    await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${`issue_${n}`}, ${repo}, 'queued', 1)`
  await sql`
    INSERT INTO factory.lead_attempts (issue_id, attempt, branch, first_try_at, started_at, gone_at) VALUES
      ('issue_1', 1, 'factory/1-1', ${t('10:01')}, ${t('10:02')}, ${t('10:12')}),
      ('issue_2', 1, 'factory/2-1', ${t('10:06')}, ${t('10:07')}, NULL),
      ('issue_3', 1, 'factory/3-1', ${t('10:06')}, ${t('10:07')}, ${t('10:08')}),
      ('issue_3', 2, 'factory/3-2', ${t('10:30')}, NULL, NULL)`
  // issue_2's lead is never marked gone: the close of its Issue ends it
  await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
    VALUES ('ev_close_2', 'issue_2', 'k_close_2', 'seeded', '{}'::jsonb, 'factory', ${t('10:20')}, 'applied', 2, 'closed')`
  await sql`
    INSERT INTO factory.queue_intervals (issue_id, project, kind, message, from_at, to_at) VALUES
      ('issue_3', 'app', 'memory_fit', 'm', ${t('10:00')}, ${t('10:11')}),
      ('issue_2', 'lib', 'seats', 's', ${t('10:05')}, NULL)`
  const host = (
    at: string,
    leads: number,
    queued: number,
    user: number,
    sys: number,
    idle: number,
    processes: number,
  ) =>
    sql`INSERT INTO factory.host_samples (at, leads, queued, cpu_user_pct, cpu_sys_pct, cpu_idle_pct, processes)
      VALUES (${t(at)}, ${leads}, ${queued}, ${user}, ${sys}, ${idle}, ${processes})`
  await host('10:03', 1, 2, 30, 10, 60, 400)
  await host('10:04', 3, 2, 50, 20, 30, 450)
  await host('10:12', 2, 1, 10, 5, 85, 380)
  await sql`INSERT INTO factory.step_costs (at, name, repo, duration_ms, wait_ms) VALUES
    (${t('10:20')}, 'app check', 'app', 1000, 1000), (${t('10:21')}, 'app check', 'app', 1000, 5000),
    (${t('10:22')}, 'app check', 'app', 1000, 3000)`
  await sql`INSERT INTO factory.merge_windows (project, requested_at, acquired_at, released_at) VALUES
    ('app', ${t('10:00')}, ${t('10:02')}, ${t('10:03')}), ('app', ${t('10:10')}, ${t('10:16')}, ${t('10:17')})`
})
afterAll(() => db.stop())

const read = () => readThroughput(db.sql, { now: NOW, hours: 2 })

describe('the series', () => {
  test('running leads and queued Issues at each bucket start, by repo and by reason', async () => {
    const { series } = ThroughputModel.parse(await read())
    expect(series.bucketMinutes).toBe(5)
    expect(series.points).toHaveLength(25)
    const at = (hhmm: string) => series.points.find((p) => p.at === t(hhmm).toISOString())
    expect(at('10:00')).toMatchObject({
      running: 0,
      queued: 1,
      queuedByReason: { memory_fit: 1 },
      queuedByRepo: { app: 1 },
    })
    expect(at('10:05')).toMatchObject({
      running: 1,
      runningByRepo: { app: 1 },
      queued: 2,
      queuedByReason: { memory_fit: 1, seats: 1 },
      queuedByRepo: { app: 1, lib: 1 },
    })
    // issue_3's lead is gone at 10:08 and its queue interval closed at 10:11; issue_1 is still running at 10:10
    expect(at('10:10')).toMatchObject({ running: 2, runningByRepo: { app: 1, lib: 1 }, queued: 2 })
    expect(at('10:15')).toMatchObject({
      running: 1,
      runningByRepo: { lib: 1 },
      queued: 1,
      queuedByReason: { seats: 1 },
    })
    // issue_2's Issue closed at 10:20: its lead is finished though never marked gone; an attempt that never started is not running
    expect(at('10:15')?.running).toBe(1)
    expect(at('10:20')?.running).toBe(0)
    expect(at('10:30')?.running).toBe(0)
    expect(at('11:55')).toMatchObject({ queued: 1, running: 0, peakRunning: null, peakQueued: null })
  })

  test('the minute samples give the peak of each bucket', async () => {
    const { series } = await read()
    const at = (hhmm: string) => series.points.find((p) => p.at === t(hhmm).toISOString())
    expect(at('10:00')).toMatchObject({ peakRunning: 3, peakQueued: 2 })
    expect(at('10:10')).toMatchObject({ peakRunning: 2, peakQueued: 1 })
  })

  test('a lead sees the work repos summed under one name', async () => {
    const model = await read()
    const open = [{ name: 'app', repo: '/src/app' }]
    const point = redactThroughput(model, open).series.points.find((p) => p.at === t('10:05').toISOString())
    expect(point?.queuedByRepo).toEqual({ app: 1, private: 1 })
    expect(point?.runningByRepo).toEqual({ app: 1 })
  })
})

test('the host signals carry the CPU split; the slot wait and the merge-lock wait carry their maximum', async () => {
  const model = await read()
  expect(model.host.signals.cpuUserPct).toEqual({ p50: 30, max: 50 })
  expect(model.host.signals.cpuSysPct).toEqual({ p50: 10, max: 20 })
  const app = model.project.find((p) => p.repo === 'app')
  expect(app?.slot.waitMaxMs).toBe(5000)
  expect(app?.slot.waitP90Ms).toBe(4600)
  // waits of 2 and 6 minutes
  expect(app?.mergeLock).toMatchObject({ windows: 2, waitMinutes: 8, waitMaxMinutes: 6, waitP90Minutes: 5.6 })
})

test('read host: a sample carries the process count and the user, system and idle CPU', async () => {
  const samples = await readHostSamples(db.sql, new Date('2026-11-07T10:20:00Z'))
  expect(samples.map((s) => [s.processes, s.cpuUserPct, s.cpuSysPct, s.cpuIdlePct])).toEqual([
    [400, 30, 10, 60],
    [450, 50, 20, 30],
    [380, 10, 5, 85],
  ])
})

describe('read sessions pages past 200', () => {
  const read = () =>
    createReader({
      sql: db.sql,
      clock: fixedClock(NOW),
      deriveSession,
      doorLines: async () => [],
      loops: () => [],
      blockedStreak: 3,
      mainCheckouts: () => [],
      macbookProbe: true,
      maxRunTries: 2,
      streamPollMs: 20,
    })

  beforeAll(async () => {
    const { sql } = db
    for (const n of [10, 11, 12, 13, 14, 20]) {
      await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${`issue_${n}`}, 'app', 'queued', 1)`
      await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
        VALUES (${`event_${n}`}, ${`issue_${n}`}, ${`k${n}`}, 'filed', ${{ repo: 'app', title: `T${n}`, kind: 'bug', origin: 'you' }}, 'factory', ${t('09:00')}, 'applied', 1, 'settling')`
      const first = n === 20 ? t('11:00') : new Date(t('09:00').getTime() + n * 60_000)
      await sql`INSERT INTO factory.lead_attempts (issue_id, attempt, branch, first_try_at) VALUES (${`issue_${n}`}, 1, ${`factory/${n}-1`}, ${first})`
    }
    // an Issue with two attempts, newer than the five the pages walk through
    await sql`INSERT INTO factory.lead_attempts (issue_id, attempt, branch, first_try_at) VALUES ('issue_20', 2, 'factory/20-2', ${t('11:01')})`
  })

  test('limit cuts a page and `next` is the cursor of the following one', async () => {
    const reader = read()
    const start = t('10:00')
    const first = await reader.sessions({ redact: false, limit: 2, before: start })
    expect(first?.sessions.map((s) => s.id).sort()).toEqual(['lead-13-1', 'lead-14-1'])
    expect(first?.next).toBe(new Date(t('09:00').getTime() + 13 * 60_000).toISOString())

    const second = await reader.sessions({ redact: false, limit: 2, before: new Date(first?.next ?? '') })
    expect(second?.sessions.map((s) => s.id).sort()).toEqual(['lead-11-1', 'lead-12-1'])
    const last = await reader.sessions({ redact: false, limit: 2, before: new Date(second?.next ?? '') })
    expect(last?.sessions.map((s) => s.id)).toEqual(['lead-10-1'])
    expect(last?.next).toBeNull()
    ReadSessionCards.parse(first)
  })

  test('an Issue’s own list is whole and has no next page', async () => {
    const found = await read().sessions({ redact: false, issue: '20' })
    expect(found?.sessions.map((s) => s.id).sort()).toEqual(['lead-20-1', 'lead-20-2'])
    expect(found?.next).toBeNull()
  })
})
