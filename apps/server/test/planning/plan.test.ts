import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { FACTS_EXAMPLE, FACTS_KEYS, MAX_AFTER_IDS, PLAN_LIMITS } from '@software-factory/contract'
import { parseYamlText } from '../../src/adapters/planning/git-projects.ts'
import { factsNote, filable, parsePlan, type PlanFile, rowStatuses } from '../../src/domains/planning/plan.ts'
import { issueId } from '../../src/kernel/ids.ts'

const ROOT = join(import.meta.dir, '..', '..', '..', '..')
const parsed = (text: string, lanes: string[] = []) => {
  const yaml = parseYamlText(text)
  if (!yaml.ok) throw new Error(yaml.message)
  return parsePlan(yaml.value, lanes)
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
    const result = parsed(example ?? '', ['docs'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toEqual([])
    const used = new Set(result.plan.rows.flatMap((r) => Object.keys(r)))
    for (const key of [
      'key',
      'title',
      'facts',
      'kind',
      'lane',
      'repo',
      'after',
      'after_needs',
      'after_days',
      'not_before',
      'issue',
    ])
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

  test('a lane the project does not declare is a warning, not a broken plan; a bad name or an adopted row is refused', () => {
    const rows = [row('a', { lane: 'apple' }), row('b', { lane: 'web' }), row('c')]
    const result = parsePlan({ version: 1, rows }, ['apple'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toEqual([expect.stringContaining('row b: lane web is not declared')])
    expect(result.plan.rows.map((r) => r.lane)).toEqual(['apple', 'web', undefined])
    const undeclared = parsePlan({ version: 1, rows })
    expect(undeclared.ok && undeclared.warnings).toHaveLength(2)
    expect(parsePlan({ version: 1, rows: [row('a', { lane: 'Apple Build' })] }).ok).toBe(false)
    expect(parsePlan({ version: 1, rows: [{ key: 'a', issue: 5, lane: 'apple' }] })).toMatchObject({
      ok: false,
      message: expect.stringContaining('no lane'),
    })
  })

  test("a row prio is an integer within the verb's range, and an adopted row has none", () => {
    const rows = (prio: unknown) => ({ version: 1, rows: [row('a', { prio })] })
    expect(parsePlan(rows(5)).ok).toBe(true)
    expect(parsePlan(rows(-1000)).ok).toBe(true)
    expect(parsePlan(rows(1001)).ok).toBe(false)
    expect(parsePlan(rows(1.5)).ok).toBe(false)
    expect(parsePlan({ version: 1, rows: [{ key: 'a', issue: 5, prio: 1 }] })).toMatchObject({
      ok: false,
      message: expect.stringContaining('no prio'),
    })
  })

  test('a row with more after keys than issue new accepts is refused, naming the row and its count', () => {
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`)
    const rows = (n: number) => [...keys(n).map((k) => row(k)), row('top', { after: keys(n) })]
    expect(parsePlan({ version: 1, rows: rows(MAX_AFTER_IDS) }).ok).toBe(true)
    const result = parsePlan({ version: 1, rows: rows(MAX_AFTER_IDS + 1) })
    expect(result.ok).toBe(false)
    const message = result.ok ? '' : result.message
    expect(message).toContain(`row top: ${MAX_AFTER_IDS + 1} after keys`)
    expect(message).toContain('transitive reduction')
    expect(PLAN_LIMITS.maxAfter).toBe(MAX_AFTER_IDS)
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
    expect(bad([row('a', { seat: { tier: 'gpt', effort: 'high' } })])).toMatchObject({
      ok: false,
      message: expect.stringContaining('seat.tier'),
    })
    expect(bad([row('a', { seat: { role: 'lead', effort: 'high' } })])).toMatchObject({
      ok: false,
      message: expect.stringContaining('seat:'),
    })
    expect(bad([{ key: 'a', issue: 5, seat: { role: 'lead' } }])).toMatchObject({
      ok: false,
      message: expect.stringContaining('no seat'),
    })
    expect(parsePlan({ version: 1, rows: [row('a', { seat: { role: 'lead' } })] }).ok).toBe(true)
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
    closedAt: [number, string][] = [],
    outcomes: [number, string][] = [],
  ) => ({
    plans: Object.entries(plans).map(([project, p]) => ({ project, plan: p })),
    projects: new Set(['app', 'lib']),
    filed: new Map(Object.entries(filed).map(([k, n]) => [k, issueId(n)])),
    states: states(closed),
    outcomes: new Map(outcomes.map(([n, outcome]) => [issueId(n), outcome])),
    closedAt: new Map(closedAt.map(([n, at]) => [issueId(n), new Date(at)])),
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

  test('a waiting row lists every unmet after, in order, and names a ref that is no row', () => {
    const p = plan([row('a'), row('b'), row('c', { after: ['a', 'lib:ghost', 'b'] })])
    const statuses = rowStatuses(facts({ app: p }, { 'app:b': 2 }, [[2, 'closed']]))
    expect(stateOf(statuses, 'app', 'c')?.reason).toBe('after app:a, lib:ghost (no such row)')
    expect(stateOf(rowStatuses(facts({ app: p })), 'app', 'c')?.reason).toBe(
      'after app:a, lib:ghost (no such row), app:b',
    )
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

  test('after_days holds a row until that many days after the latest close among its after rows', () => {
    const p = plan([row('a'), row('b'), row('c', { after: ['a', 'b'], after_days: 7 })])
    const filed = { 'app:a': 1, 'app:b': 2 }
    const closed: [number, 'closed'][] = [
      [1, 'closed'],
      [2, 'closed'],
    ]
    const within = rowStatuses(
      facts({ app: p }, filed, closed, [
        [1, '2026-11-01T00:00:00Z'],
        [2, '2026-11-04T06:00:00Z'],
      ]),
    )
    expect(stateOf(within, 'app', 'c')).toMatchObject({
      state: 'waiting',
      reason: 'after_days 7: closed 2026-11-04T06:00:00.000Z, until 2026-11-11T06:00:00.000Z',
    })
    const past = rowStatuses(
      facts({ app: p }, filed, closed, [
        [1, '2026-11-01T00:00:00Z'],
        [2, '2026-11-03T00:00:00Z'],
      ]),
    )
    expect(stateOf(past, 'app', 'c')?.state).toBe('filable')
    // an after row still open keeps the plain `after` reason; the window starts at its close
    const open = rowStatuses(facts({ app: p }, filed, [[1, 'closed']], [[1, '2026-11-01T00:00:00Z']]))
    expect(stateOf(open, 'app', 'c')?.reason).toBe('after app:b')
  })

  test('after_days and not_before both have to be past; an unknown close time never holds a row', () => {
    const p = plan([row('a'), row('b', { after: ['a'], after_days: 1, not_before: '2026-11-12' })])
    const at = (iso: string) => rowStatuses(facts({ app: p }, { 'app:a': 1 }, [[1, 'closed']], [[1, iso]]))
    expect(stateOf(at('2026-11-01T00:00:00Z'), 'app', 'b')?.reason).toBe('not before 2026-11-12')
    expect(stateOf(at('2026-11-09T12:00:00Z'), 'app', 'b')?.reason).toContain('after_days 1')
    expect(stateOf(rowStatuses(facts({ app: p }, { 'app:a': 1 }, [[1, 'closed']])), 'app', 'b')?.reason).toBe(
      'not before 2026-11-12',
    )
  })

  describe('after_needs shipped', () => {
    const p = plan([
      row('a'),
      row('b', { after: ['a'], after_needs: 'shipped' }),
      row('c', { after: ['a'] }),
      row('d', { after: ['lib:x'], after_needs: 'shipped' }),
    ])
    const at = (outcome: string, extra: Record<string, number> = {}) =>
      rowStatuses(facts({ app: p }, { 'app:a': 1, ...extra }, [[1, 'closed']], [], [[1, outcome]]))

    test.each(['dropped', 'cancelled'])('a %s predecessor holds the row and releases the plain one', (outcome) => {
      const statuses = at(outcome)
      expect(stateOf(statuses, 'app', 'b')).toMatchObject({
        state: 'waiting',
        reason: expect.stringContaining(`held: app:a (issue_1 closed ${outcome})`),
        heldBy: [{ row: 'app:a', issue: 'issue_1', outcome }],
      })
      expect(stateOf(statuses, 'app', 'c')).toMatchObject({ state: 'filable', heldBy: [] })
      expect(filable(statuses).map((s) => s.key)).toEqual(['c'])
    })

    test.each(['done', 'healed'])('a %s predecessor releases the row', (outcome) => {
      expect(stateOf(at(outcome), 'app', 'b')).toMatchObject({ state: 'filable', heldBy: [] })
    })

    test('an open predecessor keeps the usual reason, and a held one wins over an unmet one', () => {
      const open = rowStatuses(facts({ app: p }, { 'app:a': 1 }, [[1, 'open']]))
      expect(stateOf(open, 'app', 'b')).toMatchObject({ reason: 'after app:a', heldBy: [] })
      const two = plan([row('a'), row('b'), row('c', { after: ['a', 'b'], after_needs: 'shipped' })])
      const mixed = rowStatuses(
        facts(
          { app: two },
          { 'app:a': 1, 'app:b': 2 },
          [
            [1, 'closed'],
            [2, 'open'],
          ],
          [],
          [[1, 'dropped']],
        ),
      )
      expect(stateOf(mixed, 'app', 'c')?.reason).toContain('held: app:a')
    })

    test('a reopened predecessor releases the hold by itself, and a row with an Issue is never held', () => {
      const reopened = rowStatuses(facts({ app: p }, { 'app:a': 1 }, [[1, 'open']], [], []))
      expect(stateOf(reopened, 'app', 'b')?.heldBy).toEqual([])
      const filed = rowStatuses(
        facts(
          { app: p },
          { 'app:a': 1, 'app:b': 2 },
          [
            [1, 'closed'],
            [2, 'open'],
          ],
          [],
          [[1, 'dropped']],
        ),
      )
      expect(stateOf(filed, 'app', 'b')).toMatchObject({ state: 'open', heldBy: [] })
    })

    test('it judges a row of another project too, and an unknown outcome never holds', () => {
      const lib = plan([row('x')])
      const held = rowStatuses(facts({ app: p, lib }, { 'lib:x': 7 }, [[7, 'closed']], [], [[7, 'dropped']]))
      expect(stateOf(held, 'app', 'd')).toMatchObject({
        state: 'waiting',
        heldBy: [{ row: 'lib:x', outcome: 'dropped' }],
      })
      const unknown = rowStatuses(facts({ app: p, lib }, { 'lib:x': 7 }, [[7, 'closed']]))
      expect(stateOf(unknown, 'app', 'd')?.state).toBe('filable')
    })

    test('the field needs after, and an adopted row has none', () => {
      expect(parsePlan({ version: 1, rows: [row('a', { after_needs: 'shipped' })] })).toMatchObject({
        ok: false,
        message: expect.stringContaining('after_needs judges its after rows'),
      })
      expect(parsePlan({ version: 1, rows: [{ key: 'a', issue: 3, after_needs: 'shipped' }] })).toMatchObject({
        ok: false,
        message: expect.stringContaining('an adopted row (issue) has no after_needs'),
      })
      expect(parsePlan({ version: 1, rows: [row('a'), row('b', { after: ['a'], after_needs: 'any' })] }).ok).toBe(false)
    })
  })

  test('after_days needs after, and an adopted row has none', () => {
    expect(parsePlan({ version: 1, rows: [row('a', { after_days: 3 })] })).toMatchObject({
      ok: false,
      message: expect.stringContaining('after_days counts from its after rows'),
    })
    expect(parsePlan({ version: 1, rows: [{ key: 'a', issue: 5, after_days: 3 }] })).toMatchObject({
      ok: false,
      message: expect.stringContaining('no after_days'),
    })
    expect(parsePlan({ version: 1, rows: [row('a'), row('b', { after: ['a'], after_days: 0 })] }).ok).toBe(false)
    expect(parsePlan({ version: 1, rows: [row('a'), row('b', { after: ['a'], after_days: 7 })] }).ok).toBe(true)
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
    expect(stateOf(rowStatuses(facts({ app })), 'app', 'ship')?.reason).toBe('after lib:api (no such row)')

    const a = plan([row('x', { after: ['lib:y'] })])
    const b = plan([row('y', { after: ['app:x'] })])
    const cyclic = rowStatuses(facts({ app: a, lib: b }))
    expect(stateOf(cyclic, 'app', 'x')?.reason).toContain('cycle')
    expect(stateOf(cyclic, 'lib', 'y')?.reason).toContain('cycle')
  })
})
