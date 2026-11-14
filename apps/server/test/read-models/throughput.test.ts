import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ThroughputModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { createApp } from '../../src/api/app.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readThroughput } from '../../src/read/throughput.ts'

/**
 * The throughput figures over seeded minutes, against hand-computed values and against plain SQL written here in another
 * shape (scalar subqueries, FILTER, array indexing). Seeded with the edge rows: a minute with a missing class, null
 * cpu, rows with no repo or tenant, rows outside the window and exactly at its end.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-07T12:00:00Z')
const HOURS = 24
const FROM = new Date(NOW.getTime() - HOURS * 3_600_000)
const t = (hhmm: string, day = '11-07'): Date => new Date(`2026-${day}T${hhmm}:00Z`)

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
  await seed()
})
afterAll(() => db.stop())

type Row = [Date, string, string | null, string | null, number, number | null, number]
async function classRows(rows: Row[]) {
  for (const [at, cls, repo, tenant, footprint, cpu, procs] of rows)
    await sql`INSERT INTO factory.host_class_samples (at, class, repo, tenant, footprint_mib, cpu_ms, procs)
      VALUES (${at}, ${cls}, ${repo}, ${tenant}, ${footprint}, ${cpu}, ${procs})`
}

let lastPid = 0
async function processRow(
  at: Date,
  name: string,
  cls: string,
  repo: string | null,
  tenant: string | null,
  footprint: number,
  cpu: number | null,
  why: string,
  grown: number | null,
) {
  const pid = lastPid + 1
  lastPid = pid
  await sql`INSERT INTO factory.host_process_samples (at, pid, ppid, name, class, repo, tenant, footprint_mib, cpu_ms, why, grown_mib)
    VALUES (${at}, ${pid}, 1, ${name}, ${cls}, ${repo}, ${tenant}, ${footprint}, ${cpu}, ${why}, ${grown})`
}

async function seed() {
  await classRows([
    // 10:00
    [t('10:00'), 'lead', 'app', null, 1000, 500, 3],
    [t('10:00'), 'lead', 'app', null, 500, 300, 2],
    [t('10:00'), 'step', 'app', null, 200, 1000, 4],
    [t('10:00'), 'step', 'lib', null, 300, null, 1],
    [t('10:00'), 'tenant', null, 'svc.one', 400, 200, 1],
    [t('10:00'), 'tenant', null, 'svc.two', 100, 50, 1],
    [t('10:00'), 'system', null, null, 2000, 4000, 50],
    // 10:01: no svc.two, no step in lib
    [t('10:01'), 'lead', 'app', null, 1200, 600, 3],
    [t('10:01'), 'step', 'app', null, 100, null, 1],
    [t('10:01'), 'tenant', null, 'svc.one', 600, 100, 1],
    [t('10:01'), 'system', null, null, 2100, 3000, 51],
    [t('10:01'), 'owner', null, null, 300, 100, 5],
    // 10:02: the app lead is missing
    [t('10:02'), 'lead', 'lib', null, 800, 100, 2],
    [t('10:02'), 'tenant', null, 'svc.two', 200, null, 1],
    [t('10:02'), 'system', null, null, 1900, null, 49],
    // 10:03: a lead with no repo and a tenant with no tenant name belong to their class only
    [t('10:03'), 'lead', null, null, 66, 10, 1],
    [t('10:03'), 'tenant', null, null, 77, 5, 1],
    [t('10:03'), 'step', 'app', null, 400, 700, 2],
    [t('10:03'), 'system', null, null, 2000, 1000, 50],
    [t('10:03'), 'other', null, null, 50, 10, 2],
    // outside: before the window, and exactly at its end
    [t('11:59', '11-06'), 'lead', 'app', null, 9999, 9999, 9],
    [NOW, 'lead', 'app', null, 8888, 8888, 8],
  ])

  const host = async (
    at: Date,
    v: [
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
    ],
  ) => {
    const [load, idle, compressor, swap, processes, vmFree, collector, pressure] = v
    await sql`INSERT INTO factory.host_samples (at, load, cpu_idle_pct, compressor_mib, swap_used_pct, processes, vm_free_gib, collector_cpu_ms, pressure_level)
      VALUES (${at}, ${load}, ${idle}, ${compressor}, ${swap}, ${processes}, ${vmFree}, ${collector}, ${pressure})`
  }
  await host(t('10:00'), [2, 80, 1000, 10, 500, 50, 600, 1])
  await host(t('10:01'), [4, 60, 2000, 20, 600, 40, 1200, 1])
  await host(t('10:02'), [10, 20, 3000, 30, 700, 30, null, 2])
  await host(t('10:03'), [null, null, null, null, null, null, null, 4])
  await host(t('10:04'), [6, null, null, null, null, 35, 1800, null])
  await host(t('11:00', '11-06'), [99, 1, 99999, 99, 9999, 1, 99999, 4]) // outside

  await processRow(t('10:00'), 'node', 'lead', 'app', null, 900, 100, 'top', null)
  await processRow(t('10:01'), 'node', 'lead', 'app', null, 1100, 200, 'growth', 250)
  await processRow(t('10:02'), 'node', 'lead', 'lib', null, 700, null, 'top', null)
  await processRow(t('10:02'), 'zed', 'tenant', null, 'svc.one', 700, 40, 'large', null)
  await processRow(t('10:00'), 'kernel_task', 'system', null, null, 1500, null, 'top', null)
  await processRow(t('10:01'), 'kernel_task', 'system', null, null, 1400, 10, 'top', 120)
  await processRow(t('11:59', '11-06'), 'huge', 'other', null, null, 99_999, 99_999, 'large', null)
  const finding = (id: string, project: string, kpi: string, before: number, status: string, filed: string) =>
    sql`INSERT INTO factory.throughput_findings (id, project, kpi, subject, before, target, direction, unit, cost_minutes, query, filed_at, status)
      VALUES (${id}, ${project}, ${kpi}, 'fast', ${before}, 2048, 'down', 'MiB', 90, 'factory read throughput', ${new Date(filed)}, ${status})`
  await finding('finding_a', 'app', 'failed_run_minutes', 60, 'open', '2026-11-01T08:00:00Z')
  await finding('finding_b', 'lib', 'step_peak_mib', 3000, 'moved', '2026-11-03T08:00:00Z')
  await sql`UPDATE factory.throughput_findings SET issue_id = 'issue_9', shipped_at = '2026-11-04T08:00:00Z',
    after = 1800, after_at = '2026-11-07T08:00:00Z' WHERE id = 'finding_b'`
  for (let i = 0; i < 16; i++)
    await processRow(t('10:03'), `small${String(i).padStart(2, '0')}`, 'other', null, null, 10 + i, 1, 'top', null)
}

const read = (hours = HOURS) => readThroughput(sql, { now: NOW, hours })
const one = async (query: Promise<unknown[]>) => (await query)[0] as Record<string, unknown>

describe('readThroughput', () => {
  test('the window and the snapshot minutes', async () => {
    const model = ThroughputModel.parse(await read())
    expect(model.hours).toBe(24)
    expect(model.window).toEqual({ from: FROM.toISOString(), to: NOW.toISOString() })
    expect(model.host.minutes).toBe(4)
    const narrow = await read(1)
    expect(narrow.host.minutes).toBe(0)
    expect(narrow.host.byClass.every((c) => c.footprintMib === 0 && c.cores === 0 && c.procs === 0)).toBe(true)
    expect(narrow.host.signals.load).toEqual({ p50: null, max: null })
    expect(narrow.host.collector.coreShare).toBeNull()
  })

  test('the host signals', async () => {
    const { signals, collector } = (await read()).host
    expect(signals.pressureMinutes).toEqual({ normal: 2, warning: 1, critical: 1, unread: 1 })
    expect(signals.load).toEqual({ p50: 5, max: 10 })
    expect(signals.cpuIdlePct).toEqual({ p50: 60, min: 20 })
    expect(signals.compressorMib).toEqual({ p50: 2000, max: 3000 })
    expect(signals.swapUsedPct).toEqual({ p50: 20, max: 30 })
    expect(signals.processes).toEqual({ p50: 600, max: 700 })
    expect(signals.vmFreeGib).toEqual({ min: 30, last: 35 })
    expect(collector.minutes).toBe(3)
    expect(collector.cpuSeconds).toBeCloseTo(3.6, 9)
    expect(collector.coreShare).toBeCloseTo(0.02, 9)

    const sqlSignals = await one(sql`
      SELECT
        (SELECT count(*) FROM factory.host_samples WHERE at >= ${FROM} AND at < ${NOW} AND pressure_level = 4)::int AS critical,
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY load) FROM factory.host_samples WHERE at >= ${FROM} AND at < ${NOW})::float8 AS load_p50,
        (SELECT vm_free_gib FROM factory.host_samples WHERE at >= ${FROM} AND at < ${NOW} AND vm_free_gib IS NOT NULL ORDER BY at DESC LIMIT 1)::float8 AS vm_last,
        (SELECT sum(collector_cpu_ms) FROM factory.host_samples WHERE at >= ${FROM} AND at < ${NOW})::float8 AS collector_ms`)
    expect(signals.pressureMinutes.critical).toBe(sqlSignals.critical as number)
    expect(signals.load.p50).toBe(sqlSignals.load_p50 as number)
    expect(signals.vmFreeGib.last).toBe(sqlSignals.vm_last as number)
    expect(collector.cpuSeconds).toBeCloseTo((sqlSignals.collector_ms as number) / 1000, 9)
  })

  test('byClass lists the seven classes, largest first', async () => {
    const { byClass } = (await read()).host
    expect(byClass.map((c) => c.class)).toEqual(['system', 'lead', 'tenant', 'step', 'owner', 'other', 'factory'])
    // lead: 1500 + 1200 + 800 + 66 over 4 minutes = 891.5, peak 1500, cpu 1.5 s over 240 s, 11 procs / 4
    expect(byClass.find((c) => c.class === 'lead')).toEqual({
      class: 'lead',
      footprintMib: 892,
      peakMib: 1500,
      cpuSeconds: 1.5,
      cores: 0.01,
      procs: 2.8,
      share: 0.2495,
    })
    // system: 8000 / 4, peak 2100, cpu 8 s (one null ignored), 200 procs / 4
    expect(byClass.find((c) => c.class === 'system')).toEqual({
      class: 'system',
      footprintMib: 2000,
      peakMib: 2100,
      cpuSeconds: 8,
      cores: 0.03,
      procs: 50,
      share: 0.5597,
    })
    expect(byClass.find((c) => c.class === 'factory')).toEqual({
      class: 'factory',
      footprintMib: 0,
      peakMib: 0,
      cpuSeconds: 0,
      cores: 0,
      procs: 0,
      share: 0,
    })
    // the shares of the seven classes add to one, each against plain SQL
    expect(byClass.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(1, 3)
    const total = await one(
      sql`SELECT sum(footprint_mib)::float8 AS fp FROM factory.host_class_samples WHERE at >= ${FROM} AND at < ${NOW}`,
    )
    for (const c of byClass) {
      const part = await one(
        sql`SELECT coalesce(sum(footprint_mib), 0)::float8 AS fp FROM factory.host_class_samples WHERE class = ${c.class} AND at >= ${FROM} AND at < ${NOW}`,
      )
      expect(c.share).toBeCloseTo((part.fp as number) / (total.fp as number), 4)
    }
    // a key's mean over every minute of the window, against plain SQL
    for (const c of byClass) {
      const expected = await one(sql`
        SELECT
          round((SELECT coalesce(sum(footprint_mib), 0) FROM factory.host_class_samples WHERE class = ${c.class} AND at >= ${FROM} AND at < ${NOW})::numeric
            / (SELECT count(DISTINCT at) FROM factory.host_class_samples WHERE at >= ${FROM} AND at < ${NOW}))::int AS fp,
          coalesce((SELECT max(s) FROM (SELECT sum(footprint_mib) AS s FROM factory.host_class_samples
            WHERE class = ${c.class} AND at >= ${FROM} AND at < ${NOW} GROUP BY at) m), 0)::int AS peak`)
      expect(c.footprintMib).toBe(expected.fp as number)
      expect(c.peakMib).toBe(expected.peak as number)
    }
  })

  test('the timeline: the worst pressure and the largest swap use and load of each bucket', async () => {
    const { timeline } = (await read()).host
    // 24 hours: 5-minute buckets; 10:00 to 10:04 are one bucket, the sample outside the window is none
    expect(timeline.bucketMinutes).toBe(5)
    expect(timeline.points).toEqual([{ at: t('10:00').toISOString(), pressureLevel: 4, swapUsedPct: 30, load: 10 }])
    const sqlBucket = await one(sql`
      SELECT max(pressure_level)::int AS level, max(swap_used_pct)::float8 AS swap, max(load)::float8 AS load
      FROM factory.host_samples WHERE at >= ${FROM} AND at < ${NOW}`)
    expect(timeline.points[0]).toMatchObject({
      pressureLevel: sqlBucket.level as number,
      swapUsedPct: sqlBucket.swap as number,
      load: sqlBucket.load as number,
    })
    // 72 hours: 15-minute buckets, 4 days: hourly
    const day3 = await read(72)
    expect(day3.host.timeline.bucketMinutes).toBe(15)
    const day4 = await read(96)
    expect(day4.host.timeline.bucketMinutes).toBe(60)
    expect(day4.host.timeline.points.map((p) => p.at)).toEqual([
      new Date('2026-11-06T11:00:00Z').toISOString(),
      new Date('2026-11-07T10:00:00Z').toISOString(),
    ])
    expect((await read(1)).host.timeline.points).toEqual([])
  })

  test('improvements: the loop findings, newest filing first, whatever the window', async () => {
    const { improvements } = await read(1)
    expect(improvements.map((f) => [f.id, f.status])).toEqual([
      ['finding_b', 'moved'],
      ['finding_a', 'open'],
    ])
    expect(improvements[0]).toEqual({
      id: 'finding_b',
      project: 'lib',
      kpi: 'step_peak_mib',
      subject: 'fast',
      before: 3000,
      target: 2048,
      after: 1800,
      direction: 'down',
      unit: 'MiB',
      costMinutes: 90,
      status: 'moved',
      issue: 'issue_9',
      filedAt: '2026-11-03T08:00:00.000Z',
      shippedAt: '2026-11-04T08:00:00.000Z',
      afterAt: '2026-11-07T08:00:00.000Z',
    })
    expect(improvements[1]).toMatchObject({ after: null, issue: null, shippedAt: null, afterAt: null })
  })

  test('byRepo: lead and step rows with a repo, split by class', async () => {
    const { byRepo } = (await read()).host
    // app: leads 1500 + 1200, steps 200 + 100 + 400; per minute 1700, 1300, 0, 400
    expect(byRepo).toEqual([
      { repo: 'app', footprintMib: 850, peakMib: 1700, cpuSeconds: 3.1, leadMib: 675, stepMib: 175 },
      { repo: 'lib', footprintMib: 275, peakMib: 800, cpuSeconds: 0.1, leadMib: 200, stepMib: 75 },
    ])
  })

  test('byTenant: tenant rows with a tenant', async () => {
    const { byTenant } = (await read()).host
    // svc.one 400 + 600, svc.two 100 + 200; the row with no tenant is left out
    expect(byTenant).toEqual([
      { tenant: 'svc.one', footprintMib: 250, peakMib: 600, cpuSeconds: 0.3 },
      { tenant: 'svc.two', footprintMib: 75, peakMib: 200, cpuSeconds: 0.1 },
    ])
  })

  test('topProcesses: grouped null-safe, largest peak first then name, at most 15', async () => {
    const { topProcesses } = (await read()).host
    expect(topProcesses).toHaveLength(15)
    expect(topProcesses[0]).toEqual({
      name: 'kernel_task',
      class: 'system',
      repo: null,
      tenant: null,
      peakMib: 1500,
      cpuSeconds: 0,
      minutes: 2,
      grownMib: 120,
    })
    expect(topProcesses[1]).toEqual({
      name: 'node',
      class: 'lead',
      repo: 'app',
      tenant: null,
      peakMib: 1100,
      cpuSeconds: 0.3,
      minutes: 2,
      grownMib: 250,
    })
    // equal peaks of 700 come out by name: node (repo lib) before zed
    expect(topProcesses.slice(2, 4).map((p) => [p.name, p.repo, p.tenant, p.grownMib])).toEqual([
      ['node', 'lib', null, null],
      ['zed', null, 'svc.one', null],
    ])
    expect(topProcesses.some((p) => p.name === 'huge')).toBe(false)
    // the 4 groups above and the 11 largest of the 16 small rows fill the 15
    expect(topProcesses.some((p) => p.name === 'small04')).toBe(false)
    expect(topProcesses.at(-1)?.name).toBe('small05')
  })
})

describe('GET /v1/throughput', () => {
  const TOKENS = {
    owner: 'owner-token-0123456789',
    orchestrator: 'orchestrator-token-0123456789',
    agent: 'agent-token-0123456789',
    read: 'read-token-0123456789',
  }
  let app: ReturnType<typeof createApp>
  beforeAll(() => {
    app = createApp({
      tokens: TOKENS,
      health: { read: () => Promise.reject(new Error('unused')) },
      log: () => {},
      readModels: { sql, now: () => NOW },
    })
  })
  const get = (path: string, token: string) =>
    app.handle(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } }))

  test('the owner and the orchestrator read it whole; the lead reads it with work names redacted; the read token not at all', async () => {
    await sql`INSERT INTO factory.planning_projects (name, repo, source, project) VALUES ('app', '/src/app', 'file', '{}'::jsonb)`
    try {
      for (const token of [TOKENS.owner, TOKENS.orchestrator]) {
        const whole = ThroughputModel.parse(await (await get('/v1/throughput', token)).json())
        expect(whole.host.byTenant.map((row) => row.tenant)).toContain('svc.one')
        expect(whole.host.byRepo.map((row) => row.repo)).toContain('lib')
      }
      expect((await get('/v1/throughput', TOKENS.read)).status).toBe(403)
      const lead = ThroughputModel.parse(await (await get('/v1/throughput', TOKENS.agent)).json())
      const whole = ThroughputModel.parse(await (await get('/v1/throughput', TOKENS.owner)).json())
      expect(lead.host.byTenant.every((row) => row.tenant === 'private')).toBe(true)
      expect(lead.host.byRepo.map((row) => row.repo)).toContain('app')
      expect(lead.host.byRepo.map((row) => row.repo)).not.toContain('lib')
      expect(lead.host.topProcesses.every((row) => row.tenant === null || row.tenant === 'private')).toBe(true)
      // the figures are the owner's
      expect(lead.host.byRepo.map((row) => row.footprintMib)).toEqual(whole.host.byRepo.map((row) => row.footprintMib))
      expect(lead.host.byClass).toEqual(whole.host.byClass)
      expect(JSON.stringify(lead)).not.toContain('svc.')
    } finally {
      await sql`DELETE FROM factory.planning_projects WHERE name = 'app'`
    }
  })

  test('hours: 1 to 336, default 24; anything else is a 422 with an ErrorBody', async () => {
    const day = ThroughputModel.parse(await (await get('/v1/throughput', TOKENS.owner)).json())
    expect(day.hours).toBe(24)
    expect(ThroughputModel.parse(await (await get('/v1/throughput?hours=336', TOKENS.owner)).json()).hours).toBe(336)
    expect(ThroughputModel.parse(await (await get('/v1/throughput?hours=1', TOKENS.owner)).json()).hours).toBe(1)
    for (const hours of ['0', '337', 'x', '-1', '2.5', '1000']) {
      const response = await get(`/v1/throughput?hours=${hours}`, TOKENS.owner)
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ code: 'invalid_request' })
    }
  })

  test('unbound, it answers 503', async () => {
    const unbound = createApp({
      tokens: TOKENS,
      health: { read: () => Promise.reject(new Error('unused')) },
      log: () => {},
    })
    const response = await unbound.handle(
      new Request('http://localhost/v1/throughput', { headers: { authorization: `Bearer ${TOKENS.owner}` } }),
    )
    expect(response.status).toBe(503)
  })
})
