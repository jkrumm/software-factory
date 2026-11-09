import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { FACTS_EXAMPLE, FACTS_KEYS } from '@software-factory/contract'
import { parseYamlText } from '../../src/adapters/planning/git-projects.ts'
import { factsNote, filable, parsePlan, type PlanFile, rowStatuses } from '../../src/domains/planning/plan.ts'
import { issueId } from '../../src/kernel/ids.ts'

const ROOT = join(import.meta.dir, '..', '..', '..', '..')
const parsed = (text: string) => {
  const yaml = parseYamlText(text)
  if (!yaml.ok) throw new Error(yaml.message)
  return parsePlan(yaml.value)
}
const plan = (rows: object[]): PlanFile => {
  const result = parsePlan({ version: 1, rows })
  if (!result.ok) throw new Error(result.message)
  return result.plan
}
const row = (key: string, extra: object = {}) => ({ key, title: key, facts: { why: key }, ...extra })

describe('docs/plan.yaml', () => {
  test("the factory's own plan parses without a warning", async () => {
    const result = parsed(await Bun.file(join(ROOT, 'docs', 'plan.yaml')).text())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.rows.some((r) => r.issue === 149)).toBe(true)
    expect(result.plan.rows.some((r) => r.not_before !== undefined)).toBe(true)
    expect(result.warnings).toEqual([])
  })

  test('the example in docs/plan.md parses, and shows every key a new row can use', async () => {
    const doc = await Bun.file(join(ROOT, 'docs', 'plan.md')).text()
    const example = /```yaml\n([\s\S]*?)```/.exec(doc)?.[1]
    expect(example).toBeDefined()
    const result = parsed(example ?? '')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toEqual([])
    const used = new Set(result.plan.rows.flatMap((r) => Object.keys(r)))
    for (const key of ['key', 'title', 'facts', 'kind', 'repo', 'after', 'not_before', 'issue'])
      expect(used.has(key)).toBe(true)
    const adopted = result.plan.rows.find((r) => r.issue !== undefined)
    expect(adopted && Object.keys(adopted).sort()).toEqual(['issue', 'key'])
    expect(result.plan.rows.some((r) => r.after?.some((on) => on.includes(':')))).toBe(true)
    // the facts of a filed row follow the filing contract's keys
    const filed = result.plan.rows.find((r) => r.key === 'export-paging')
    expect(filed && Object.keys(filed.facts ?? {})).toEqual(FACTS_KEYS.map((k) => k.key))
    expect(filed?.facts).toEqual(FACTS_EXAMPLE)
  })

  test('the retired stable_days is read, flagged and never evaluated', () => {
    const result = parsePlan({ version: 1, rows: [row('a', { stable_days: 7 })] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings.some((w) => w.includes('stable_days is retired'))).toBe(true)
  })

  test('a duplicate key, an unknown after, a self wait, a cycle and a row without a title are refused', () => {
    const bad = (rows: object[]) => parsePlan({ version: 1, rows })
    expect(bad([row('a'), row('a')])).toMatchObject({ ok: false, message: expect.stringContaining('duplicate key a') })
    expect(bad([row('a', { after: ['zz'] })])).toMatchObject({
      ok: false,
      message: expect.stringContaining('unknown key zz'),
    })
    expect(bad([row('a', { after: ['a'] })])).toMatchObject({
      ok: false,
      message: expect.stringContaining('waits for itself'),
    })
    expect(bad([row('a', { after: ['b'] }), row('b', { after: ['a'] })])).toMatchObject({
      ok: false,
      message: expect.stringContaining('cycle: a -> b -> a'),
    })
    expect(bad([{ key: 'a' }])).toMatchObject({ ok: false, message: expect.stringContaining('title is required') })
    expect(bad([{ key: 'a', issue: 5, after: ['b'] }, row('b')])).toMatchObject({ ok: false })
  })

  test('the facts become the first note the lead reads', () => {
    const [first] = plan([row('a', { facts: { why: 'because', acceptance: 'it works' } })]).rows
    expect(first && factsNote(first)).toBe('Plan row a.\nwhy: because\nacceptance: it works')
  })
})

describe('row states', () => {
  const now = new Date('2026-11-10T00:00:00Z')
  const states = (entries: [number, 'open' | 'closed'][]) => new Map(entries.map(([n, s]) => [issueId(n), s]))
  const facts = (
    plans: Record<string, PlanFile>,
    filed: Record<string, number> = {},
    closed: [number, 'open' | 'closed'][] = [],
  ) => ({
    plans: Object.entries(plans).map(([project, p]) => ({ project, plan: p })),
    projects: new Set(['app', 'lib']),
    filed: new Map(Object.entries(filed).map(([k, n]) => [k, issueId(n)])),
    states: states(closed),
    now,
  })
  const stateOf = (statuses: ReturnType<typeof rowStatuses>, project: string, key: string) =>
    statuses.find((s) => s.project === project && s.key === key)

  test('a row is filable until it has an Issue, open while the Issue is, done when it closed in any outcome', () => {
    const p = plan([row('a'), row('b', { after: ['a'] })])
    const fresh = rowStatuses(facts({ app: p }))
    expect(stateOf(fresh, 'app', 'a')?.state).toBe('filable')
    expect(stateOf(fresh, 'app', 'b')).toMatchObject({ state: 'waiting', reason: 'after app:a' })

    const open = rowStatuses(facts({ app: p }, { 'app:a': 1 }, [[1, 'open']]))
    expect(stateOf(open, 'app', 'a')).toMatchObject({ state: 'open', issue: 'issue_1' })
    expect(stateOf(open, 'app', 'b')?.state).toBe('waiting')

    const done = rowStatuses(facts({ app: p }, { 'app:a': 1 }, [[1, 'closed']]))
    expect(stateOf(done, 'app', 'a')?.state).toBe('done')
    expect(filable(done).map((s) => s.key)).toEqual(['b'])
  })

  test('not_before waits for its time; an unknown project waits with the name; a row targets another repo', () => {
    const p = plan([
      row('later', { not_before: '2026-11-13' }),
      row('past', { not_before: '2026-11-09T09:00:00Z' }),
      row('elsewhere', { repo: 'lib' }),
      row('nowhere', { repo: 'ghost' }),
    ])
    const statuses = rowStatuses(facts({ app: p }))
    expect(stateOf(statuses, 'app', 'later')).toMatchObject({ state: 'waiting', reason: 'not before 2026-11-13' })
    expect(stateOf(statuses, 'app', 'past')?.state).toBe('filable')
    expect(stateOf(statuses, 'app', 'elsewhere')).toMatchObject({ state: 'filable', target: 'lib' })
    expect(stateOf(statuses, 'app', 'nowhere')).toMatchObject({
      state: 'waiting',
      reason: 'unknown project ghost',
      target: null,
    })
  })

  test('an adopted row is done when its Issue closes, and nothing is filed for it', () => {
    const p = plan([{ key: 'old', issue: 149 }, row('next', { after: ['old'] })])
    const open = rowStatuses(facts({ app: p }, {}, [[149, 'open']]))
    expect(stateOf(open, 'app', 'old')).toMatchObject({ state: 'open', issue: 'issue_149' })
    const done = rowStatuses(facts({ app: p }, {}, [[149, 'closed']]))
    expect(stateOf(done, 'app', 'old')?.state).toBe('done')
    expect(filable(done).map((s) => s.key)).toEqual(['next'])
    expect(stateOf(rowStatuses(facts({ app: p })), 'app', 'old')).toMatchObject({ state: 'waiting' })
  })

  test('after names a row of another project; a cycle across projects keeps every row in it waiting', () => {
    const app = plan([row('ship', { after: ['lib:api'] })])
    const lib = plan([row('api')])
    const cross = rowStatuses(facts({ app, lib }))
    expect(stateOf(cross, 'app', 'ship')).toMatchObject({ state: 'waiting', reason: 'after lib:api' })
    expect(stateOf(cross, 'lib', 'api')?.state).toBe('filable')
    expect(stateOf(rowStatuses(facts({ app })), 'app', 'ship')?.reason).toBe('after lib:api: no such row')

    const a = plan([row('x', { after: ['lib:y'] })])
    const b = plan([row('y', { after: ['app:x'] })])
    const cyclic = rowStatuses(facts({ app: a, lib: b }))
    expect(stateOf(cyclic, 'app', 'x')?.reason).toContain('cycle')
    expect(stateOf(cyclic, 'lib', 'y')?.reason).toContain('cycle')
  })
})
