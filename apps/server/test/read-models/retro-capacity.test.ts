import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RetroModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import {
  capacityFigures,
  IDLE_HIGH_PER_DAY,
  MEMORY_SHARE_HIGH,
  OVER_HIGH_PER_DAY,
  tuneConstant,
  WAIT_HIGH_MS,
} from '../../src/read/capacity-tuning.ts'
import { readRetro } from '../../src/read/retro.ts'

/** The retro's capacity half: the figures against plain SQL, the ledger resolving a capacity key, the fixed tuning rules. */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-07T12:00:00Z')
const DAYS = 7
const FROM = new Date(NOW.getTime() - DAYS * 24 * 3_600_000)
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)
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
  slotAim: 'shadow' as const,
}

let keys = 0
const event = (issue: string, version: number, kind: string, at: Date, to: string, from: string | null) => sql`
  INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
  VALUES (${`event_${++keys}`}, ${issue}, ${`key_${keys}`}, ${kind}, '{}'::jsonb, 'factory', ${at}, 'applied', ${version}, ${from}, ${to})`

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
  // two Issues closed in the window; issue_9 closed and shipped before it (its retro signal is measured after the ship)
  for (const [id, closed] of [
    ['issue_1', ago(48)],
    ['issue_2', ago(24)],
  ] as const) {
    await sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES (${id}, 'app', 'closed', 'done', 2)`
    await event(id, 1, 'filed', ago(100), 'settling', null)
    await event(id, 2, 'closed', closed, 'closed', 'working')
  }
  await sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES ('issue_9', 'app', 'closed', 'done', 3)`
  await event('issue_9', 1, 'filed', ago(400), 'settling', null)
  await event('issue_9', 2, 'shipped', ago(300), 'watching', 'working')
  await event('issue_9', 3, 'closed', ago(290), 'closed', 'watching')
  // 30 host minutes, 12 of them over the ceiling of 8
  for (let m = 0; m < 30; m++)
    await sql`INSERT INTO factory.host_samples (at, load, leads, queued, seats, load_ceiling)
      VALUES (${new Date(ago(10).getTime() + m * 60_000)}, ${m < 12 ? 9 : 3}, 1, 2, 3, 8)`
  await sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, issue_id)
    VALUES ('signal_c1', 'agent:software-factory', 'request', 'factory', 'agent', 'app', 'c1', 'Fewer minutes over the ceiling',
      ${'Retro: 2026-10-20 kpi=minutes_over_ceiling_per_day before=9 direction=down'}, ${ago(400)}, 'filed', 'issue_9')`
})
afterAll(() => db.stop())

describe('the retro bundle carries the capacity loop', () => {
  test('without settings the capacity is null and a capacity marker has no number', async () => {
    const model = RetroModel.parse(await readRetro(sql, { now: NOW, days: DAYS }))
    expect(model.capacity).toBeNull()
    expect(model.ledger[0]).toMatchObject({ kpi: 'minutes_over_ceiling_per_day', now: null, moved: null })
  })

  test('the throughput part follows the window up to 14 days, drops the lead list and survives the redaction', async () => {
    await sql`INSERT INTO factory.throughput_findings (id, project, kpi, subject, before, target, direction, unit, cost_minutes, query, filed_at, status)
      VALUES ('finding_1', 'app', 'failed_run_minutes', '*', 60, 30, 'down', 'minutes', 120, 'factory read throughput', ${ago(30)}, 'open')`
    const week = RetroModel.parse(await readRetro(sql, { now: NOW, days: DAYS }))
    expect(week.throughput.hours).toBe(168)
    const month = RetroModel.parse(await readRetro(sql, { now: NOW, days: 30, redact: true }))
    expect(month.throughput.hours).toBe(336)
    expect(month.throughput.lead).not.toHaveProperty('issues')
    expect(month.throughput.improvements.map((f) => [f.id, f.project, f.status])).toEqual([
      ['finding_1', 'app', 'open'],
    ])
    // the two Issues closed inside the week are the project's closed Issues, with or without a lead
    expect(week.throughput.project.find((p) => p.repo === 'app')?.closedIssues).toBe(2)
    expect(week.throughput.host.byClass).toHaveLength(7)
  })

  test('the figures are per day and match SQL; the ledger measures a capacity key against the window', async () => {
    const model = RetroModel.parse(await readRetro(sql, { now: NOW, days: DAYS, capacityConstants: constants }))
    const figure = (key: string) => model.capacity?.figures.find((f) => f.key === key)?.value

    const [closed] = await sql`SELECT count(*)::float8 / ${DAYS} AS v FROM factory.issue_events
      WHERE result = 'applied' AND to_state = 'closed' AND at >= ${FROM} AND at < ${NOW}`
    const [over] = await sql`SELECT count(*)::float8 / ${DAYS} AS v FROM factory.host_samples
      WHERE load > load_ceiling AND at >= ${FROM} AND at < ${NOW}`
    const [idle] =
      await sql`SELECT (sum(greatest(seats - leads, 0))::float8 / 60) / ${DAYS} AS v FROM factory.host_samples
      WHERE queued > 0 AND at >= ${FROM} AND at < ${NOW}`
    expect(figure('closed_per_day')).toBeCloseTo(Number(closed.v), 9)
    expect(figure('closed_per_day')).toBeCloseTo(2 / DAYS, 9)
    expect(figure('minutes_over_ceiling_per_day')).toBeCloseTo(Number(over.v), 9)
    expect(figure('minutes_over_ceiling_per_day')).toBeCloseTo(12 / DAYS, 9)
    expect(figure('idle_seat_hours_per_day')).toBeCloseTo(Number(idle.v), 9)
    expect(figure('slot_wait_p90_ms')).toBeNull()

    // 12 / 7 = 1.7 minutes a day against 9 before: the whole window is after the ship
    expect(model.ledger[0]).toMatchObject({
      kpi: 'minutes_over_ceiling_per_day',
      before: 9,
      measured: 'after',
      moved: 'better',
    })
    expect(model.ledger[0]?.now).toBeCloseTo(12 / DAYS, 9)
    // nothing is out of range at 1.7 minutes a day
    expect(model.capacity?.tune).toBeNull()
  })
})

describe('the fixed tuning rules', () => {
  const loop = (over: number, idle: number, p90: number | null) =>
    capacityFigures({
      days: 1,
      throughput: { total: 5, perDay: [] },
      minutesOverCeiling: { total: over, perDay: [] },
      idleSeatHours: { total: idle, perDay: [] },
      slotWait: { n: p90 === null ? 0 : 3, p50Ms: p90, p90Ms: p90, perDayP50: [] },
    })

  test('too long over the ceiling lowers the seat bonus first, then the seats, then the extra slots', () => {
    const figures = loop(OVER_HIGH_PER_DAY, 0, null)
    expect(tuneConstant(figures, constants)).toMatchObject({ constant: 'seatsMaxBonus', direction: 'down' })
    expect(tuneConstant(figures, { ...constants, seatsMaxBonus: 0 })).toMatchObject({
      constant: 'leadsPerAccount',
      direction: 'down',
    })
    expect(tuneConstant(figures, { ...constants, seatsMaxBonus: 0, leadsPerAccount: 1 })).toMatchObject({
      constant: 'slotsMax',
    })
    expect(tuneConstant(figures, { ...constants, seatsMaxBonus: 0, leadsPerAccount: 1, slotsMax: 2 })).toBeNull()
  })

  test('idle seats behind a queue on a machine under the ceiling raise the load ceiling', () => {
    expect(tuneConstant(loop(5, IDLE_HIGH_PER_DAY, null), constants)).toMatchObject({
      constant: 'loadCeiling',
      direction: 'up',
    })
    // the load is not low: no raise
    expect(tuneConstant(loop(OVER_HIGH_PER_DAY / 2, IDLE_HIGH_PER_DAY, null), constants)).toBeNull()
  })

  test('idle seats held mostly by the memory gate name the memory ceiling, never the load ceiling', () => {
    const heaviest = { repo: 'basalt-ui', peakMibP80: 2560 }
    const held = tuneConstant(loop(5, IDLE_HIGH_PER_DAY, null), constants, {
      memoryShare: 0.9,
      trigger: 'swapout',
      heaviest,
    })
    expect(held).toMatchObject({ constant: 'swapoutCeilingMb', direction: 'up' })
    expect(held?.reason).toContain('basalt-ui')
    expect(held?.reason).toContain('2.5 GiB')
    // half or less of the idle time behind memory: the load ceiling stays the rule
    expect(
      tuneConstant(loop(5, IDLE_HIGH_PER_DAY, null), constants, {
        memoryShare: MEMORY_SHARE_HIGH,
        trigger: 'swapout',
        heaviest,
      }),
    ).toMatchObject({ constant: 'loadCeiling' })
    // swap in use was the gate that held it: that ceiling is the one named
    expect(
      tuneConstant(loop(5, IDLE_HIGH_PER_DAY, null), constants, { memoryShare: 0.9, trigger: 'swapUsed', heaviest }),
    ).toMatchObject({ constant: 'swapCeilingPct', direction: 'up' })
    // no repo cost yet: still the memory constant
    expect(
      tuneConstant(loop(5, IDLE_HIGH_PER_DAY, null), constants, { memoryShare: 1, trigger: 'swapout', heaviest: null }),
    ).toMatchObject({ constant: 'swapoutCeilingMb' })
  })

  test('a long slot wait on a quiet machine raises the base slots, never past the maximum', () => {
    const figures = loop(0, 0, WAIT_HIGH_MS)
    expect(tuneConstant(figures, constants)).toMatchObject({ constant: 'slots', direction: 'up' })
    expect(tuneConstant(figures, { ...constants, slots: 6 })).toBeNull()
    expect(tuneConstant(loop(0, 0, WAIT_HIGH_MS - 1), constants)).toBeNull()
  })
})
