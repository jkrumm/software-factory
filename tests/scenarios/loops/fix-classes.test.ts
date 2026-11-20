import { afterAll, beforeAll, expect, test } from 'bun:test'
import { FixCommitsModel } from '@software-factory/contract'
import { type Lab, startLab } from '../planning/lab.ts'
import { runLoop } from './support.ts'

/**
 * The fix-classes loop against the real server and Postgres, the real git reader and a fixture repo with conventional
 * commits dated now and ten days ago. The classes are the rules' alone (no agw is called); every pass is driven through
 * `factory loop run fix-classes` (the intervals are off).
 */
let lab: Lab

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
let n = 0
const commit = (message: string, days: number) =>
  lab.commit('f1', { [`file-${++n}.txt`]: message }, { message, date: ago(days) })

beforeAll(async () => {
  lab = await startLab({
    leads: true,
    repos: { f1: { project: 'apiVersion: factory/v2\nname: f1\nleads: 2\n' }, work: {} },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
  // oldest first: git stops walking at a commit older than the window
  await commit('fix!: outside the window', 100)
  await commit('fix(docs): a stale link', 10)
  await commit('fix: wrong total with two coupons', 10)
  await commit('feat: a new thing', 0)
  await commit('fix(test): flaky timer in the suite', 0)
  await commit('fix(ci): pin the runner', 0)
  await commit('fix(queue): race on the claim', 0)
  await commit('docs: fix a typo', 0)
})

afterAll(async () => {
  await lab.stop()
})

const sql = () => lab.world.db.sql

const stored = async (): Promise<Record<string, { class: string; by: string }>> => {
  const rows = (await sql()`SELECT subject, class, by FROM factory.fix_commits WHERE repo = 'f1'`) as {
    subject: string
    class: string
    by: string
  }[]
  return Object.fromEntries(rows.map((r) => [r.subject, { class: r.class, by: r.by }]))
}

test('a pass stores the fix commits of the window by rule, a commit no rule classes as other, and a later pass nothing new', async () => {
  const first = await runLoop(lab, 'fix-classes')
  expect(first).toMatchObject({ started: true, error: null })
  const expected = {
    'fix(test): flaky timer in the suite': { class: 'tests', by: 'rule' },
    'fix(docs): a stale link': { class: 'docs', by: 'rule' },
    'fix(ci): pin the runner': { class: 'tooling', by: 'rule' },
    'fix(queue): race on the claim': { class: 'other', by: 'rule' },
    'fix: wrong total with two coupons': { class: 'other', by: 'rule' },
  }
  expect(await stored()).toEqual(expected)

  expect((await runLoop(lab, 'fix-classes')).error).toBeNull()
  expect(await stored()).toEqual(expected)
})

test('a commit made after a pass is stored by the next one', async () => {
  await commit('fix(api): the schema and the client disagree', 1)
  await runLoop(lab, 'fix-classes')
  expect((await stored())['fix(api): the schema and the client disagree']).toEqual({ class: 'other', by: 'rule' })
  expect(Object.keys(await stored())).toHaveLength(6)
})

test('factory read fix-commits counts each class in the week it was committed, the newest week first', async () => {
  const result = await lab.cli(['read', 'fix-commits'])
  expect(result.code).toBe(0)
  const model = FixCommitsModel.parse(result.json)
  expect(model.measured).toBe(true)
  expect(model.repos).toBe(1)
  expect(model.weeks).toHaveLength(4)
  const [thisWeek, lastWeek, ...older] = model.weeks
  expect(thisWeek?.byClass).toMatchObject({ tests: 1, tooling: 1, other: 2, docs: 0, logic: 0 })
  expect(thisWeek?.total).toBe(4)
  expect(lastWeek?.byClass).toMatchObject({ docs: 1, other: 1, tests: 0 })
  expect(lastWeek?.total).toBe(2)
  expect(older.map((w) => w.total)).toEqual([0, 0])
  expect(model.classes.map((c) => c.key)).toContain('environment')
})
