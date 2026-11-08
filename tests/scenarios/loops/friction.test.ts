import { afterAll, beforeAll, expect, test } from 'bun:test'
import { fileIssue } from '../flow.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { runLoop } from './support.ts'

/**
 * The friction loop against the real server and Postgres: the counts are seeded with SQL, and every pass is driven through
 * `factory loop run friction` (the intervals are off). No agw is involved; the signals go through intake's rules.
 *
 * The seeded history has two halves. What was recorded a day ago is the old core's, imported (the import marker sits twelve
 * hours ago); what was recorded an hour ago is the new core's own. Only the second half may count.
 */
let lab: Lab
let seeded = 0
const FRICTION = 'agent:software-factory'
const OLD = '1 day'
const NEW = '1 hour'

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

const refuse = async (issue: string, kind: string, detail: string, times: number, ago = NEW) => {
  for (let i = 0; i < times; i++) {
    await sql()`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, detail)
      VALUES (${`event_seed_${++seeded}`}, ${issue}, ${`seed-${seeded}`}, ${kind}, '{}'::jsonb, 'lead',
        now() - ${ago}::interval, 'refused', ${detail})`
  }
}

/** Issues closed: what every rate divides by. The facts only; the Issue itself is not touched. */
const close = async (issue: string, times: number, ago = NEW) => {
  for (let i = 0; i < times; i++) {
    await sql()`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
      VALUES (${`event_seed_${++seeded}`}, ${issue}, ${`seed-${seeded}`}, 'closed', '{}'::jsonb, 'factory',
        now() - ${ago}::interval, 'applied', ${1000 + seeded}, 'closed')`
  }
}

const refuseShips = async (issue: string, detail: string, times: number) => {
  for (let i = 0; i < times; i++) {
    await sql()`INSERT INTO factory.quality_ships (id, issue_id, attempt, event_key, at, result, detail, reported)
      VALUES (${`ship_seed_${++seeded}`}, ${issue}, 1, ${`seed-ship-${seeded}`}, now() - interval '1 hour', 'refused',
        ${detail}, '[]'::jsonb)`
  }
}

const regress = (issue: string, ago = NEW) =>
  sql()`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at)
    VALUES (${`watch-seed-${++seeded}`}, ${issue}, 1, ${seeded}, now() - interval '2 days', 0, 'regressed', now() - ${ago}::interval)`

const hold = async (source: string, times: number) => {
  for (let i = 0; i < times; i++) {
    await sql()`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state)
      VALUES (${`signal_seed_${++seeded}`}, ${source}, 'feedback', 'feedback', 'outside', 'app', ${`seed-${seeded}`},
        'A held complaint', 'words', now() - interval '1 hour', 'held')`
  }
}

const filedSignals = async () =>
  (await sql()`SELECT title, text, state, issue_id FROM factory.intake_signals WHERE source = ${FRICTION} ORDER BY title`) as {
    title: string
    text: string
    state: string
    issue_id: string | null
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

/** What an Issue was told after it was filed: the notes on it, oldest first. */
const notesOn = async (issue: string): Promise<string[]> => {
  const rows: { payload: unknown }[] = await sql()`
    SELECT payload FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'noted' AND result = 'applied'
    ORDER BY version`
  return rows.map((row) => json<{ text: string }>(row.payload).text)
}

let issue: string

test('the first pass counts only the new core, files each pattern over its rate and none under it, with the evidence', async () => {
  issue = await fileIssue(lab, { repo: 'app', title: 'a change that was refused' })
  // the old core's history, imported: a day ago, before the marker. Every pattern here is far over any threshold.
  await sql()`INSERT INTO factory.import_issues (issue_id, legacy_id, imported_at, last_event, carried_version)
    VALUES (${issue}, 1, now() - interval '12 hours', 1, 1)`
  await close(issue, 30, OLD)
  await refuse(issue, 'noted', 'an old reason', 20, OLD)
  await regress(issue, OLD)
  await regress(issue, OLD)

  // the new core's own: 40 Issues closed, so a rate of 0.1 is four
  await close(issue, 40)
  await refuse(issue, 'noted', 'not allowed here', 5) // 0.125 per Issue closed: over 0.1
  await refuse(issue, 'started', 'too early', 3) // 0.075: three, but under the rate
  await refuse(issue, 'closed', 'a typo', 2) // under the count
  await refuseShips(issue, 'ship refused, review missing: review v4 at the tier `agw review route`…', 8) // retired
  await regress(issue) // serious at any rate
  await hold('feedback', 3) // 0.075 per Issue closed against 0.2

  const ran = await runLoop(lab, 'friction')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('filed 2 signal(s)')

  const signals = await filedSignals()
  expect(signals.map((s) => s.title)).toEqual([
    'Friction: A noted event was refused: not allowed here',
    'Friction: Watches that ended in a regression',
  ])
  const refusal = signals[0]
  if (!refusal) throw new Error('no signal for the refusals')
  expect(refusal.text).toContain('Count: 5 (0.13 per Issue closed)')
  expect(refusal.text).toContain('closed: 40')
  expect(refusal.text).toContain('Threshold: 3 in the window and 0.10 per Issue closed (judged from 10 closed)')
  expect(refusal.text).toContain('cut at the import')
  expect(refusal.text).toContain(`Evidence (the most recent Issues, up to 5): ${issue}`)
  expect(refusal.text).toContain('factory read friction --days 7')
  // nothing of the old core got through
  for (const signal of signals) {
    expect(signal.text).not.toContain('an old reason')
    expect(signal.text).not.toContain('Count: 22')
  }
  expect(signals[1]?.text).toContain('Count: 1 ')

  const [pass] = await passes()
  expect(pass?.filed.map((f) => f.count).sort()).toEqual([1, 5])
  expect(pass?.over_budget).toEqual([])
  expect(pass?.failed).toEqual([])
  expect(await frictionIssues()).toBe(2)
})

test('a second run in the same week is not due and files nothing', async () => {
  const ran = await runLoop(lab, 'friction')
  expect(ran.summary).toContain('not due (last pass ')
  expect(await filedSignals()).toHaveLength(2)
  expect(await passes()).toHaveLength(1)
})

test('a pass a week later amends the open Issue of a pattern with what it counted now, and files no second', async () => {
  const [first] = await filedSignals().then((all) => all.filter((s) => s.title.includes('regression')))
  if (!first?.issue_id) throw new Error('the regression signal has no Issue')
  expect(await notesOn(first.issue_id)).toEqual([])

  await regress(issue)
  await backdate()
  const ran = await runLoop(lab, 'friction')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('filed 2 signal(s)')
  expect(await passes()).toHaveLength(2)
  expect(await frictionIssues()).toBe(2)

  const notes = await notesOn(first.issue_id)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('Count: 2 ')
})

test('more than five patterns: five are filed, the rest are named in the pass record and its line', async () => {
  for (const source of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']) await hold(source, 9) // 0.225 against 0.2
  await backdate()
  const ran = await runLoop(lab, 'friction')
  expect(ran.error).toBeNull()
  const last = (await passes()).at(-1)
  if (!last) throw new Error('no pass recorded')
  expect(last.filed).toHaveLength(5)
  expect(last.over_budget).toHaveLength(3)
  expect(
    last.over_budget.every(
      (p) => p.key.startsWith('signal_held:') || p.key.startsWith('refusal:') || p.key === 'regression',
    ),
  ).toBe(true)
  expect(ran.summary).toContain('over budget, not filed: ')
  for (const left of last.over_budget) expect(ran.summary).toContain(left.key)
})

test('under the minimum sample no rate is judged; the patterns that need no rate still are', async () => {
  // five Issues closed: the old and the new sample are both gone from the window's rate, only the count of the serious stays
  await sql()`DELETE FROM factory.issue_events WHERE kind = 'closed' AND key LIKE 'seed-%' AND at > now() - interval '12 hours'`
  await close(issue, 5)
  await backdate()
  const ran = await runLoop(lab, 'friction')
  expect(ran.error).toBeNull()
  const last = (await passes()).at(-1)
  if (!last) throw new Error('no pass recorded')
  expect(last.filed.map((f) => f.key)).toEqual(['regression'])
  expect(last.over_budget).toEqual([])
})

test('a window with nothing over a threshold still records its pass', async () => {
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
