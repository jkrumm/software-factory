import { afterAll, beforeAll, expect, test } from 'bun:test'
import { fileIssue } from '../flow.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { runLoop } from './support.ts'

/**
 * The friction loop against the real server and Postgres: the week's counts are seeded with SQL, and every pass is driven
 * through `factory loop run friction` (the intervals are off). No agw is involved; the signals go through intake's rules.
 */
let lab: Lab
let seeded = 0
const FRICTION = 'agent:software-factory'

beforeAll(async () => {
  lab = await startLab({
    leads: true,
    repos: {
      app: { project: 'apiVersion: factory/v2\nname: app\nleads: 8\n' },
      'software-factory': { project: 'apiVersion: factory/v2\nname: software-factory\nleads: 2\n' },
    },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(() => lab.stop())

const sql = () => lab.world.db.sql

const refuse = async (issue: string, kind: string, detail: string, times: number) => {
  for (let i = 0; i < times; i++) {
    await sql()`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, detail)
      VALUES (${`event_seed_${++seeded}`}, ${issue}, ${`seed-${seeded}`}, ${kind}, '{}'::jsonb, 'lead',
        now() - interval '1 day', 'refused', ${detail})`
  }
}

const refuseShips = async (issue: string, detail: string, times: number) => {
  for (let i = 0; i < times; i++) {
    await sql()`INSERT INTO factory.quality_ships (id, issue_id, attempt, event_key, at, result, detail, reported)
      VALUES (${`ship_seed_${++seeded}`}, ${issue}, 1, ${`seed-ship-${seeded}`}, now() - interval '1 day', 'refused',
        ${detail}, '[]'::jsonb)`
  }
}

const regress = (issue: string) =>
  sql()`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at)
    VALUES (${`watch-seed-${++seeded}`}, ${issue}, 1, 1, now() - interval '2 days', 0, 'regressed', now() - interval '1 day')`

const hold = async (source: string, times: number) => {
  for (let i = 0; i < times; i++) {
    await sql()`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state)
      VALUES (${`signal_seed_${++seeded}`}, ${source}, 'feedback', 'feedback', 'outside', 'app', ${`seed-${seeded}`},
        'A held complaint', 'words', now() - interval '1 day', 'held')`
  }
}

const filedSignals = async () =>
  (await sql()`SELECT title, text, state FROM factory.intake_signals WHERE source = ${FRICTION} ORDER BY title`) as {
    title: string
    text: string
    state: string
  }[]

const frictionIssues = async (): Promise<number> =>
  Number((await sql()`SELECT count(*) AS n FROM factory.issues WHERE repo = 'software-factory'`)[0].n)

const json = <T>(value: unknown): T => (typeof value === 'string' ? (JSON.parse(value) as T) : (value as T))

interface Pass {
  issues: number
  filed: { key: string; count: number; title: string }[]
  over_budget: { key: string; count: number }[]
  failed: { key: string; reason: string }[]
}

const passes = async (): Promise<Pass[]> => {
  const rows: Record<string, unknown>[] = await sql()`SELECT * FROM factory.friction_passes ORDER BY at`
  return rows.map((row) => ({
    issues: row.issues as number,
    filed: json<{ key: string; count: number; title: string }[]>(row.filed),
    over_budget: json<{ key: string; count: number }[]>(row.over_budget),
    failed: json<{ key: string; reason: string }[]>(row.failed),
  }))
}

const backdate = () => sql()`UPDATE factory.friction_passes SET at = at - interval '8 days'`

let issue: string

test('the first pass files one signal per pattern over its threshold and none under it, with the evidence', async () => {
  issue = await fileIssue(lab, { repo: 'app', title: 'a change that was refused' })
  await refuse(issue, 'noted', 'not allowed here', 3)
  await refuse(issue, 'started', 'too early', 2)
  await refuseShips(issue, 'the review is missing', 3)
  await regress(issue)
  await hold('feedback', 2)

  const ran = await runLoop(lab, 'friction')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('filed 3 signal(s)')

  const signals = await filedSignals()
  expect(signals.map((s) => s.title)).toEqual(
    [
      'Friction: A ship was refused: the review is missing',
      'Friction: A noted event was refused: not allowed here',
      'Friction: Watches that ended in a regression',
    ].sort(),
  )
  const ship = signals.find((s) => s.title.includes('ship was refused'))
  if (!ship) throw new Error('no signal for the refused ships')
  expect(ship.text).toContain('Count: 3')
  expect(ship.text).toContain('Threshold: 3')
  expect(ship.text).toContain(`Evidence (the most recent Issues, up to 5): ${issue}`)
  expect(ship.text).toContain('Window: ')
  expect(ship.text).toContain('Issues filed in the window: 1')
  expect(ship.text).toContain('factory read friction --days 7')

  const [pass] = await passes()
  expect(pass?.filed.map((f) => f.count).sort()).toEqual([1, 3, 3])
  expect(pass?.over_budget).toEqual([])
  expect(pass?.failed).toEqual([])
  expect(await frictionIssues()).toBe(3)
})

test('a second run in the same week is not due and files nothing', async () => {
  const ran = await runLoop(lab, 'friction')
  expect(ran.summary).toContain('not due (last pass ')
  expect(await filedSignals()).toHaveLength(3)
  expect(await passes()).toHaveLength(1)
})

test('a pass a week later does not file a second Issue for a pattern whose Issue is open', async () => {
  await backdate()
  const ran = await runLoop(lab, 'friction')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('filed 3 signal(s)')
  expect(await passes()).toHaveLength(2)
  expect(await frictionIssues()).toBe(3)
})

test('more than five patterns: five are filed, the rest are named in the pass record and its line', async () => {
  for (const source of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']) await hold(source, 3)
  await backdate()
  const ran = await runLoop(lab, 'friction')
  expect(ran.error).toBeNull()
  const last = (await passes()).at(-1)
  if (!last) throw new Error('no pass recorded')
  expect(last.filed).toHaveLength(5)
  expect(last.over_budget).toHaveLength(4)
  expect(last.over_budget.every((p) => p.key.startsWith('signal_held:') || p.key === 'regression')).toBe(true)
  expect(ran.summary).toContain('over budget, not filed: ')
  for (const left of last.over_budget) expect(ran.summary).toContain(left.key)
})

test('a week with nothing over a threshold still records its pass', async () => {
  await sql()`DELETE FROM factory.issue_events WHERE key LIKE 'seed-%'`
  await sql()`DELETE FROM factory.quality_ships WHERE event_key LIKE 'seed-ship-%'`
  await sql()`DELETE FROM factory.quality_watches WHERE key LIKE 'watch-seed-%'`
  await sql()`DELETE FROM factory.intake_signals WHERE id LIKE 'signal_seed_%'`
  await backdate()
  const before = (await passes()).length
  const ran = await runLoop(lab, 'friction')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('filed 0 signal(s)')
  const all = await passes()
  expect(all).toHaveLength(before + 1)
  expect(all.at(-1)).toMatchObject({ filed: [], over_budget: [], failed: [] })
})
