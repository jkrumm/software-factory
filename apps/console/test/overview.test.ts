import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FlowModel, NeedItem } from '@software-factory/contract'
import { needsOf, productionOf, queueBindingOf, regressedOf, shippedOf } from '../src/lib/overview.ts'
import { parentOf, SHORTCUT_GROUPS, stepChoice, stepIndex } from '../src/lib/shortcuts.ts'
import { SCREENS as NAV } from '../src/lib/screens.ts'

type Open = FlowModel['states']['queued']['issues'][number]

const issue = (id: number, repo: string, extra: Partial<Open> = {}): Open => ({
  id: `issue_${id}`,
  repo,
  title: `Issue ${id}`,
  origin: 'you',
  kind: 'feature',
  since: '2026-11-17T00:00:00.000Z',
  waitReason: null,
  queue: null,
  seat: null,
  ...extra,
})

const column = (issues: Open[]) => ({ count: issues.length, issues })

const states = (parts: Partial<Record<keyof FlowModel['states'], Open[]>>): FlowModel['states'] => ({
  settling: column(parts.settling ?? []),
  queued: column(parts.queued ?? []),
  working: column(parts.working ?? []),
  waiting: column(parts.waiting ?? []),
  watching: column(parts.watching ?? []),
})

describe('needsOf', () => {
  test('counts every item and names the three open longest', () => {
    const items = [5, 50, 1, 30, 20].map((ageMs, i) => ({ id: `n${i}`, ageMs }) as NeedItem)
    const { total, top } = needsOf({ items })
    expect(total).toBe(5)
    expect(top.map((item) => item.ageMs)).toEqual([50, 30, 20])
  })
})

describe('productionOf', () => {
  test('a project with an open incident Issue is red; a ship in Watch is checking', () => {
    const data = {
      states: states({
        working: [issue(1, 'argo', { kind: 'incident' }), issue(2, 'argo', { kind: 'incident' })],
        queued: [issue(3, 'iris', { kind: 'incident' })],
        watching: [issue(4, 'argo'), issue(5, 'basalt'), issue(6, 'basalt')],
      }),
    }
    const { red, checking } = productionOf(data)
    expect(red).toEqual([
      { project: 'argo', count: 2 },
      { project: 'iris', count: 1 },
    ])
    expect(checking).toEqual([
      { project: 'basalt', count: 2 },
      { project: 'argo', count: 1 },
    ])
  })
})

describe('shippedOf', () => {
  test('counts done and healed by project, not dropped or cancelled', () => {
    const closed = (repo: string, outcome: FlowModel['closedRecently'][number]['outcome']) => ({
      id: 'issue_1',
      repo,
      title: 't',
      origin: 'you' as const,
      kind: 'feature' as const,
      outcome,
      closedAt: '2026-11-17T00:00:00.000Z',
      seat: null,
    })
    const result = shippedOf({
      closedRecently: [closed('a', 'done'), closed('b', 'healed'), closed('a', 'done'), closed('a', 'dropped')],
    })
    expect(result.total).toBe(3)
    expect(result.byProject).toEqual([
      { project: 'a', count: 2 },
      { project: 'b', count: 1 },
    ])
  })
})

describe('queueBindingOf', () => {
  test('names the reason holding the most Issues out, with the first message of it', () => {
    const memory = (id: number, message: string) =>
      issue(id, 'a', { queue: { kind: 'memory', message, opensAt: null } })
    const result = queueBindingOf({
      states: states({
        queued: [
          issue(1, 'a'),
          memory(2, 'the host is short of memory'),
          memory(3, 'later'),
          issue(4, 'b', { queue: { kind: 'chain', message: 'after #2', opensAt: null } }),
        ],
        settling: [issue(5, 'a')],
      }),
      queueStates: { global: 'run', projects: {} },
    })
    // Not started is Ready plus Held: the settling Issue counts, though no queue reason holds it
    expect(result.notStarted).toBe(5)
    expect(result.binding).toEqual({
      kind: 'memory',
      words: 'Host memory',
      count: 2,
      message: 'the host is short of memory',
    })
    expect(result.state).toBeNull()
  })

  test('nothing held out is no binding; a paced queue says so', () => {
    const result = queueBindingOf({ states: states({}), queueStates: { global: 'pace', projects: {} } })
    expect(result.binding).toBeNull()
    expect(result.state).toBe('pace')
  })
})

describe('purposes', () => {
  test("DESIGN.md's table of questions is the one each screen shows", () => {
    const design = readFileSync(join(import.meta.dir, '..', 'DESIGN.md'), 'utf8')
    for (const item of NAV) expect(design).toContain(`| ${item.label} | ${item.purpose} |`)
  })
})

describe('shortcuts', () => {
  test('the overlay lists a g chord for every screen of the navigation', () => {
    const goTo = SHORTCUT_GROUPS.find((group) => group.title === 'Go to')
    expect(goTo?.items.map((item) => item.keys)).toEqual(NAV.map((item) => ['G', item.key]))
    expect(new Set(NAV.map((item) => item.key)).size).toBe(NAV.length)
  })

  test('j and k step through rows and hold at the ends', () => {
    expect(stepIndex(-1, 3, 1)).toBe(0)
    expect(stepIndex(-1, 3, -1)).toBe(2)
    expect(stepIndex(2, 3, 1)).toBe(2)
    expect(stepIndex(0, 3, -1)).toBe(0)
    expect(stepIndex(-1, 0, 1)).toBe(-1)
  })

  test('[ and ] step through windows and hold at the ends', () => {
    expect(stepChoice(['24h', '7d', '30d'], '7d', 1)).toBe('30d')
    expect(stepChoice(['24h', '7d', '30d'], '30d', 1)).toBe('30d')
    expect(stepChoice([7, 14, 30], 7, -1)).toBe(7)
  })

  test('Escape leaves a page of one thing for its list, and nothing else', () => {
    expect(parentOf('/issues/12')).toBe('/')
    expect(parentOf('/artifacts/abc')).toBe('/artifacts')
    expect(parentOf('/artifacts/collections/x')).toBe('/artifacts')
    expect(parentOf('/projects/argo/plan')).toBe('/projects')
    expect(parentOf('/projects')).toBeNull()
    expect(parentOf('/')).toBeNull()
  })
})

describe('regressedOf', () => {
  const row = (name: string, incidents: number, regressionAt: string | null) => ({
    name,
    production: { incidents, incidentAt: null, regressionAt },
  })
  test('lists projects that regressed in the week and have no open incident, the newest first', () => {
    expect(
      regressedOf([
        row('old', 0, '2026-11-12T00:00:00.000Z'),
        row('red', 1, '2026-11-16T00:00:00.000Z'),
        row('quiet', 0, null),
        row('new', 0, '2026-11-16T12:00:00.000Z'),
      ]),
    ).toEqual([
      { project: 'new', count: 1 },
      { project: 'old', count: 1 },
    ])
  })
})
