import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ActResult, Fleet, reviewKey } from '@software-factory/contract'
import { runProcess } from '../src/exec.ts'
import { FleetActions } from '../src/fleet/act.ts'
import { GitReader } from '../src/fleet/git.ts'
import { FleetBuilder } from '../src/fleet/index.ts'
import { type HcLister, type HcTerminal, type QueueReader } from '../src/fleet/sources.ts'
import { decide } from '../src/fleet/triage.ts'
import type { ReviewLimits } from '../src/review/limits.ts'
import { createSpawn } from '../src/spawns.ts'
import { tick } from '../src/tick.ts'
import { startApp, TEST_ROLES, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { buildEstate, type Estate, estateTerminals } from './support/fleet-estate.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { usage } from './support/quota.ts'
import { FakeRunner } from './support/world.ts'

const NOW = new Date('2026-11-02T12:00:00.000Z')
const limits: ReviewLimits = { sessions: 10, deepCap: 1, idleMs: 600_000 }

let db: TestDb
let estate: Estate
let clock: FakeClock
let app: TestApp
let builder: FleetBuilder
let terminals: HcTerminal[]

const hc: HcLister = { list: async () => terminals }
const queue: QueueReader = { list: async () => [] }

beforeAll(async () => {
  db = await startTestDb()
  estate = buildEstate(NOW)
})
afterAll(async () => {
  await app?.stop()
  estate.cleanup()
  await db.stop()
})
beforeEach(async () => {
  await app?.stop()
  await db.reset()
  clock = new FakeClock(NOW)
  terminals = estateTerminals(estate)
  builder = new FleetBuilder({
    sql: db.sql,
    now: () => clock.now(),
    roots: [estate.src],
    visibleRoots: [estate.iu],
    home: estate.src,
    hc,
    queue,
    git: new GitReader(runProcess),
    triage: {
      hosts: new Map(),
      queueMachine: undefined,
      probes: { exists: async () => undefined, newerDeploy: async () => undefined },
    },
  })
  const actions = new FleetActions({
    sql: db.sql,
    clock,
    queue,
    roles: TEST_ROLES,
    repoRoots: [estate.src],
    visibleRoots: [estate.iu],
    home: estate.src,
    refresh: () => builder.refreshNow(),
  })
  app = startApp({ sql: db.sql, clock, fleet: builder, fleetActions: actions, repoRoots: [estate.src] })
  for (const account of ['a', 'b']) {
    await app.send(
      'PUT',
      `/quota/accounts/${account}`,
      usage(account === 'a' ? 10 : 20, 10, new Date(NOW.getTime() + 100 * 3_600_000)),
    )
  }
})

const repo = () => join(estate.src, 'linewatch')
const deep = (job: string) => ({
  key: reviewKey(job, 1),
  repo: repo(),
  prompt: `job=/tmp/${job} tier=deep round=1`,
  role: 'reviewer',
  tier: 'sonnet' as const,
  effort: 'medium' as const,
  placement: 'hidden' as const,
  review: { jobId: job, tier: 'deep' as const, effort: 'high' as const },
})
const get = async () => Fleet.parse(await (await app.get('/fleet')).json())
const heldAsk = (fleet: Fleet) =>
  fleet.asks.find((a) => a.source === 'factory' && a.text.startsWith('review review-rv_d3-a1 held'))

/** Two deep reviews started earlier today, one per account, and a third held by the cap. */
async function capReached(): Promise<void> {
  for (const [job, account] of [
    ['rv_d1', 'a'],
    ['rv_d2', 'b'],
  ] as const) {
    await createSpawn(db.sql, deep(job), clock.now(), limits)
    const before = new Date(NOW.getTime() - 120_000)
    await db.sql`
      UPDATE factory.spawns SET status = 'started', account = ${account}, assigned_at = ${before}, first_claimed_at = ${before}, hold = NULL
      WHERE key = ${reviewKey(job, 1)}`
  }
  const third = await createSpawn(db.sql, deep('rv_d3'), clock.now(), limits)
  expect(third.spawn).toMatchObject({ status: 'queued', hold: 'deep_cap' })
}

describe('allow on a held deep review', () => {
  test('the held spawn is an ask on /fleet with one click: allow', async () => {
    await capReached()
    await builder.refreshNow()
    const ask = heldAsk(await get())
    expect(ask).toMatchObject({
      kind: 'blocker',
      tier: 'one_click',
      repo: repo(),
      suggestion: { verb: 'allow' },
    })
    expect(ask?.actions.map((a) => a.intent)).toEqual(['allow', 'later'])
    expect(ask?.suggestion?.evidence).toContain('deep cap reached')
  })

  test('acting allow lets exactly that spawn past the cap, once, and the tick starts it at its own tier', async () => {
    await capReached()
    await createSpawn(db.sql, deep('rv_d4'), clock.now(), limits)
    await builder.refreshNow()
    const id = heldAsk(await get())?.id ?? ''
    const res = await app.send('POST', `/fleet/asks/${encodeURIComponent(id)}/act`, { intent: 'allow' })
    expect(res.status).toBe(201)
    expect(ActResult.parse(await res.json())).toMatchObject({ intent: 'allow', duplicate: false })
    expect((await db.sql`SELECT deep_allowed FROM factory.spawns WHERE key = 'review-rv_d3-a1'`)[0]?.deep_allowed).toBe(
      true,
    )
    expect((await db.sql`SELECT deep_allowed FROM factory.spawns WHERE key = 'review-rv_d4-a1'`)[0]?.deep_allowed).toBe(
      false,
    )

    // The same act again is the first one's answer; the ask is gone.
    const again = await app.send('POST', `/fleet/asks/${encodeURIComponent(id)}/act`, { intent: 'allow' })
    expect(again.status).toBe(200)
    expect(ActResult.parse(await again.json()).duplicate).toBe(true)
    expect((await db.sql`SELECT count(*)::int AS n FROM factory.fleet_acts WHERE intent = 'allow'`)[0]?.n).toBe(1)

    const result = await tick({ sql: db.sql, clock, runner: new FakeRunner(), reviewLimits: limits })
    expect(result.started).toEqual(['review-rv_d3-a1'])
    expect(
      (await db.sql`SELECT tier, review_tier, hold FROM factory.spawns WHERE key = 'review-rv_d3-a1'`)[0],
    ).toMatchObject({
      tier: 'sonnet',
      review_tier: 'deep',
      hold: null,
    })
    expect((await db.sql`SELECT hold FROM factory.spawns WHERE key = 'review-rv_d4-a1'`)[0]?.hold).toBe('deep_cap')
  })

  test('allow is offered for nothing else', () => {
    const ask = {
      id: 'factory:spawn:x:abcdef',
      kind: 'blocker' as const,
      repo: null,
      session: null,
      plan: null,
      short: null,
      text: 'spawn x failed: no pane',
      source: 'factory' as const,
      at: NOW.toISOString(),
      tier: 'yours' as const,
      suggestion: null,
      actions: [],
      folded: [],
      occurrence: 1,
    }
    const decided = decide({ ask, request: undefined, finding: undefined, repos: [], now: NOW })
    expect(decided.actions.map((a) => a.intent)).not.toContain('allow')
  })
})
