import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { FixCommitsModel } from '@software-factory/contract'
import { type Lab, startLab } from '../planning/lab.ts'
import { callsOf, runLoop, script } from './support.ts'

/**
 * The fix-classes loop against the real server and Postgres, the real git reader and a fixture repo with conventional
 * commits dated now and ten days ago. `factory-fix-classes` is the fake agw, scripted per repo; every pass is driven through
 * `factory loop run fix-classes` (the intervals are off).
 */
let lab: Lab
let dir: string
let scriptFile: string

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
let n = 0
const commit = (message: string, days: number) =>
  lab.commit('f1', { [`file-${++n}.txt`]: message }, { message, date: ago(days) })

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-fix-classes-scenario-')
  scriptFile = join(dir, 'fix-classes.json')
  await script(scriptFile, [])
  lab = await startLab({
    leads: true,
    repos: { f1: { project: 'apiVersion: factory/v2\nname: f1\nleads: 2\n' }, work: {} },
    env: { FACTORY_FAKE_FIX_CLASSES_SCRIPT: scriptFile },
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
  await rm(dir, { recursive: true, force: true })
})

const sql = () => lab.world.db.sql

const shaOf = async (subject: string): Promise<string> => {
  const proc = Bun.spawn(['git', '-C', join(lab.root, 'f1'), 'log', '--format=%H%x09%s'], { stdout: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const line = out.split('\n').find((l) => l.split('\t')[1] === subject)
  if (!line) throw new Error(`no commit ${subject}`)
  return line.split('\t')[0] ?? ''
}

const stored = async (): Promise<Record<string, { class: string; by: string }>> => {
  const rows = (await sql()`SELECT subject, class, by FROM factory.fix_commits WHERE repo = 'f1'`) as {
    subject: string
    class: string
    by: string
  }[]
  return Object.fromEntries(rows.map((r) => [r.subject, { class: r.class, by: r.by }]))
}

const asks = async () => (await callsOf(lab, 'factory-fix-classes')).filter((c) => c.input.repo === 'f1')

const answers = async (entries: [string, string][]) => [
  {
    match: '"repo":"f1"',
    answer: {
      answers: await Promise.all(
        entries.map(async ([subject, cls]) => ({ sha: await shaOf(subject), class: cls, reason: 'scripted' })),
      ),
    },
  },
]

const BOTH: [string, string][] = [
  ['fix(queue): race on the claim', 'concurrency'],
  ['fix: wrong total with two coupons', 'logic'],
]

test('a bad answer leaves its batch unstored while the rules stored theirs; the next pass asks again', async () => {
  await script(scriptFile, await answers([BOTH[0] as [string, string]]))
  const first = await runLoop(lab, 'fix-classes')
  expect(first).toMatchObject({ started: true, error: null })
  expect(await stored()).toEqual({
    'fix(test): flaky timer in the suite': { class: 'tests', by: 'rule' },
    'fix(docs): a stale link': { class: 'docs', by: 'rule' },
    'fix(ci): pin the runner': { class: 'tooling', by: 'rule' },
  })
  const asked = await asks()
  expect(asked).toHaveLength(1)
  const shas = ((asked[0]?.input.commits ?? []) as { sha: string }[]).map((c) => c.sha).sort()
  expect(shas).toEqual([await shaOf(BOTH[0]?.[0] ?? ''), await shaOf(BOTH[1]?.[0] ?? '')].sort())

  await script(scriptFile, [
    { match: '"repo":"f1"', answer: { answers: [{ sha: shas[0], class: 'nonsense', reason: 'scripted' }] } },
  ])
  await runLoop(lab, 'fix-classes')
  expect(Object.keys(await stored())).toHaveLength(3)
  expect(await asks()).toHaveLength(2)
})

test('the good answer stores the rest, and a pass after it calls agw zero times', async () => {
  await script(scriptFile, await answers(BOTH))
  await runLoop(lab, 'fix-classes')
  const all = await stored()
  expect(all['fix(queue): race on the claim']).toEqual({ class: 'concurrency', by: 'workflow' })
  expect(all['fix: wrong total with two coupons']).toEqual({ class: 'logic', by: 'workflow' })
  expect(Object.keys(all)).toHaveLength(5)
  const before = (await asks()).length

  const again = await runLoop(lab, 'fix-classes')
  expect(again.error).toBeNull()
  expect(await asks()).toHaveLength(before)
  expect(Object.keys(await stored())).toHaveLength(5)
})

test('a workflow that fails never throws the loop and fabricates no class; its commit is stored once it answers', async () => {
  await commit('fix(api): the schema and the client disagree', 1)
  await script(scriptFile, [{ match: '"repo":"f1"', answer: {}, fail: true }])
  const failed = await runLoop(lab, 'fix-classes')
  expect(failed).toMatchObject({ started: true, error: null })
  expect(Object.keys(await stored())).toHaveLength(5)

  await script(scriptFile, await answers([['fix(api): the schema and the client disagree', 'contract']]))
  await runLoop(lab, 'fix-classes')
  expect((await stored())['fix(api): the schema and the client disagree']).toEqual({
    class: 'contract',
    by: 'workflow',
  })
})

test('factory read fix-commits counts each class in the week it was committed, the newest week first', async () => {
  const result = await lab.cli(['read', 'fix-commits'])
  expect(result.code).toBe(0)
  const model = FixCommitsModel.parse(result.json)
  expect(model.measured).toBe(true)
  expect(model.repos).toBe(1)
  expect(model.weeks).toHaveLength(4)
  const [thisWeek, lastWeek, ...older] = model.weeks
  expect(thisWeek?.byClass).toMatchObject({ tests: 1, tooling: 1, concurrency: 1, contract: 1, docs: 0, logic: 0 })
  expect(thisWeek?.total).toBe(4)
  expect(lastWeek?.byClass).toMatchObject({ docs: 1, logic: 1, tests: 0 })
  expect(lastWeek?.total).toBe(2)
  expect(older.map((w) => w.total)).toEqual([0, 0])
  expect(model.classes.map((c) => c.key)).toContain('environment')
})
