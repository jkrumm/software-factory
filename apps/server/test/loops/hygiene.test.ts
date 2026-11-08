import { expect, test } from 'bun:test'
import { loadLoopSettings } from '../../src/app/loops/settings.ts'
import type { HygieneAnswer, HygieneRequest } from '@software-factory/contract'
import {
  checkAnswer,
  judgmentBudget,
  judgmentKey,
  judgmentSignalText,
  judgmentTitle,
  MAX_PROBE_SIGNALS,
  MAX_SIGNALS_PER_PASS,
  NO_REF,
  planHygiene,
  probeBudget,
  probeSignalText,
  rankProbeFindings,
  requestOf,
  skipped,
} from '../../src/domains/loops/hygiene.ts'
import type { HygieneChecker, Probe, ProbeFinding } from '../../src/domains/loops/hygiene-model.ts'
import type { HygienePassRecord, LoopStore } from '../../src/domains/loops/ports.ts'
import { hygienePass, type HygieneDeps } from '../../src/app/loops/hygiene.ts'
import type { StoredProject } from '../../src/domains/planning/sync.ts'
import { sequentialIds } from '../../src/kernel/ids.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'

const finding = (probe: Probe, key: string, count: number): ProbeFinding => ({
  probe,
  key,
  title: `title of ${key}`,
  lines: ['a line'],
  count,
})

test('probe findings rank in probe order, then count descending, then key', () => {
  const ranked = rankProbeFindings([
    finding('cochange', 'cochange:a', 9),
    finding('links', 'links:b.md', 2),
    finding('links', 'links:a.md', 2),
    finding('links', 'links:c.md', 5),
    finding('check', 'check', 1),
  ])
  expect(ranked.map((f) => f.key)).toEqual(['check', 'links:c.md', 'links:a.md', 'links:b.md', 'cochange:a'])
})

test('the probes take three slots, the rest is named, and the judgment keeps at least two', () => {
  const many = Array.from({ length: 5 }, (_, i) => finding('links', `links:${i}.md`, 5 - i))
  const { file, overBudget } = probeBudget(rankProbeFindings(many))
  expect(file).toHaveLength(MAX_PROBE_SIGNALS)
  expect(overBudget.map((f) => f.key)).toEqual(['links:3.md', 'links:4.md'])
  expect(judgmentBudget(0)).toBe(MAX_SIGNALS_PER_PASS)
  expect(judgmentBudget(1)).toBe(4)
  expect(judgmentBudget(3)).toBe(2)
})

const report = {
  stale: [{ path: 'docs/a.md', why: 'old' }],
  slop: [
    { path: 'docs/a.md', why: 'recent' },
    { path: 'README.md', why: 'recent' },
  ],
}

test('the request lists each document once and is null with nothing to read or no budget', () => {
  const request = requestOf({ repo: 'app', cwd: '/tmp/x', ref: 'abcdef1234', report, max: 3 })
  expect(request?.stale.map((c) => c.path)).toEqual(['docs/a.md'])
  expect(request?.slop.map((c) => c.path)).toEqual(['README.md'])
  expect(
    requestOf({ repo: 'app', cwd: '/tmp/x', ref: 'abcdef1234', report: { stale: [], slop: [] }, max: 3 }),
  ).toBeNull()
  expect(requestOf({ repo: 'app', cwd: '/tmp/x', ref: 'abcdef1234', report, max: 0 })).toBeNull()
})

const answerOf = (...paths: [HygieneAnswer['findings'][number]['kind'], string][]): HygieneAnswer => ({
  findings: paths.map(([kind, path], i) => ({ kind, path, title: `t${i}`, evidence: 'e', fix: 'f' })),
  read: 2,
  reason: 'r',
})

test('an answer is checked again: unknown paths and repeats are dropped, the excess is named', () => {
  const request = requestOf({ repo: 'app', cwd: '/tmp/x', ref: 'abcdef1234', report, max: 2 }) as HygieneRequest
  const checked = checkAnswer(
    answerOf(
      ['stale', 'docs/a.md'],
      ['stale', 'docs/a.md'],
      ['stale', 'elsewhere.md'],
      ['slop', 'docs/a.md'],
      ['slop', 'README.md'],
    ),
    request,
  )
  expect(checked.findings.map((f) => `${f.kind}:${f.path}`)).toEqual(['stale:docs/a.md', 'slop:docs/a.md'])
  expect(checked.rejected).toHaveLength(2)
  expect(checked.overBudget.map((f) => f.path)).toEqual(['README.md'])
})

test('signal titles carry no counts and the text names what was swept, the evidence and how to look again', () => {
  const a = probeSignalText(finding('links', 'links:docs/a.md', 3), { repo: 'app', ref: '0123456789abcdef' })
  expect(a).toContain('Swept: app @ 0123456')
  expect(a).toContain('a line')
  expect(a).toContain('Sweep: factory read loops')
  expect(probeSignalText(finding('check', 'check', 1), { repo: 'app', ref: '0123456789' })).toContain(
    'Reproduce: make check',
  )
  const f = { kind: 'stale' as const, path: 'docs/a.md', title: 'The doc is behind', evidence: 'ev', fix: 'fx' }
  expect(judgmentTitle(f)).toBe(`Hygiene: ${f.kind} document ${f.path}`)
  expect(judgmentKey(f)).toBe('judgment:stale:docs/a.md')
  const text = judgmentSignalText(f, { repo: 'app', ref: '0123456789' })
  for (const part of ['app @ 0123456', 'Evidence: ev', 'Fix: fx', 'Reproduce:']) expect(text).toContain(part)
})

const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = new Date('2026-11-20T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)
const row = (repo: string, at: Date, judgment: Partial<HygienePassRecord['judgment']> = {}): HygienePassRecord => ({
  id: `hygiene_${repo}`,
  repo,
  at,
  ref: 'abcdef1234',
  report: { ref: 'abcdef1234', runs: [], findings: [], stale: [], slop: [] },
  judgment: { ...skipped('none'), ...judgment },
  filed: [],
  overBudget: [],
  failed: [],
})
const plan = (rows: HygienePassRecord[], over: { allow?: string[] | null; projects?: string[] } = {}) =>
  planHygiene({
    projects: over.projects ?? ['a', 'b', 'c'],
    rows,
    now,
    everyMs: 7 * DAY,
    retryMs: 6 * HOUR,
    allow: over.allow ?? null,
  })

test('a project never swept comes first, then the oldest pass, and nothing when all are fresh', () => {
  expect(plan([row('a', ago(8 * DAY)), row('b', ago(9 * DAY))])).toEqual({ kind: 'full', repo: 'c' })
  expect(plan([row('a', ago(8 * DAY)), row('b', ago(9 * DAY)), row('c', ago(1 * DAY))])).toEqual({
    kind: 'full',
    repo: 'b',
  })
  expect(plan([row('a', ago(DAY)), row('b', ago(DAY)), row('c', ago(DAY))])).toEqual({ kind: 'none' })
})

test('the allow-list narrows the projects', () => {
  expect(plan([], { allow: ['b'] })).toEqual({ kind: 'full', repo: 'b' })
  expect(plan([row('b', ago(DAY))], { allow: ['b'] })).toEqual({ kind: 'none' })
})

test('a failed judgment is retried after the gap while attempts remain; a full pass comes before a retry', () => {
  const fresh = [row('b', ago(DAY)), row('c', ago(DAY))]
  const failed = (attempts: number, judgedAgo: number) =>
    row('a', ago(DAY), { outcome: 'failed', attempts, judgedAt: ago(judgedAgo) })
  expect(plan([failed(1, 7 * HOUR), ...fresh])).toMatchObject({ kind: 'retry', repo: 'a' })
  expect(plan([failed(1, HOUR), ...fresh])).toEqual({ kind: 'none' })
  expect(plan([failed(3, 7 * HOUR), ...fresh])).toEqual({ kind: 'none' })
  expect(plan([failed(1, 7 * HOUR), row('b', ago(DAY))])).toEqual({ kind: 'full', repo: 'c' })
  expect(plan([row('a', ago(DAY), { outcome: 'skipped' }), ...fresh])).toEqual({ kind: 'none' })
})

// ---- a checkout that cannot be made ---------------------------------------------------------------------------------------

const project = (name: string, hygiene: { check: boolean; reason?: string } = { check: true }) =>
  ({ name, repo: `/src/${name}`, source: 'file', project: { hygiene } }) as unknown as StoredProject

function world(names: string[], broken: Set<string>, projects: StoredProject[] = names.map((n) => project(n))) {
  const rows: HygienePassRecord[] = []
  let at = now
  const sweeps: string[] = []
  const skips: (string | undefined)[] = []
  const loops = {
    hygienePasses: async () => {
      const newest = new Map<string, HygienePassRecord>()
      for (const r of rows) if (!newest.has(r.repo) || (newest.get(r.repo)?.at ?? r.at) <= r.at) newest.set(r.repo, r)
      return [...newest.values()]
    },
    recordHygienePass: async (r: HygienePassRecord) => void rows.push(r),
  } as unknown as LoopStore
  const checker: HygieneChecker = {
    withCheckout: async (repo, _ref, use) =>
      broken.has(repo)
        ? err(portError('gone', 'fetch failed'))
        : ok(await use({ path: '/tmp/x', ref: 'abcdef1234abcdef', source: '/tmp/src' })),
    sweep: async (co, options) => {
      sweeps.push(co.ref)
      skips.push(options?.skipCheck)
      return { ref: co.ref, runs: [], findings: [], stale: [], slop: [] }
    },
  }
  const deps: HygieneDeps = {
    uow: {
      run: async (work) => work({ loops, planning: { projects: async () => projects } as never }),
      inTransaction: () => false,
    },
    clock: { now: () => at },
    ids: sequentialIds(),
    checker,
    workflow: { ask: async () => err(portError('gone', 'not asked')) },
    file: async () => err({ kind: 'refused' } as never),
    everyMs: 7 * DAY,
    retryMs: 6 * HOUR,
    repos: null,
  }
  return { deps, rows, sweeps, skips, advance: (ms: number) => (at = new Date(at.getTime() + ms)) }
}

test('a checkout that fails records a pass, is not due before the retry gap, and the next project is swept meanwhile', async () => {
  const w = world(['a', 'b'], new Set(['a']))
  const first = await hygienePass(w.deps)
  expect(first.ok).toBe(true)
  expect(w.rows).toHaveLength(1)
  expect(w.rows[0]).toMatchObject({ repo: 'a', ref: NO_REF, judgment: { outcome: 'skipped', reason: 'no checkout' } })
  expect(w.rows[0]?.failed[0]).toMatchObject({ key: 'checkout' })

  // the second tick takes the project that was never swept, not the one that failed
  expect(await hygienePass(w.deps)).toMatchObject({ ok: true, value: { due: true, record: { repo: 'b' } } })
  expect(await hygienePass(w.deps)).toEqual(ok({ due: false }))

  w.advance(HOUR)
  expect(await hygienePass(w.deps)).toEqual(ok({ due: false }))
  w.advance(6 * HOUR)
  expect(await hygienePass(w.deps)).toMatchObject({ ok: true, value: { due: true, record: { repo: 'a' } } })
  expect(w.rows.filter((r) => r.repo === 'a')).toHaveLength(2)
})

test('a project with hygiene.check false is swept with its reason; the default asks for the check', async () => {
  const reason = 'needs the owner photo library'
  const w = world([], new Set(), [project('lab', { check: false, reason }), project('plain')])
  expect(await hygienePass(w.deps)).toMatchObject({ ok: true, value: { due: true, record: { repo: 'lab' } } })
  expect(await hygienePass(w.deps)).toMatchObject({ ok: true, value: { due: true, record: { repo: 'plain' } } })
  expect(w.skips).toEqual([reason, undefined])
})

test('planHygiene treats a no-checkout row as due after the retry gap, not after the week', () => {
  const failedRow = { ...row('a', ago(7 * HOUR)), ref: NO_REF }
  expect(plan([failedRow, row('b', ago(DAY)), row('c', ago(DAY))])).toEqual({ kind: 'full', repo: 'a' })
  const recent = { ...row('a', ago(HOUR)), ref: NO_REF }
  expect(plan([recent, row('b', ago(DAY)), row('c', ago(DAY))])).toEqual({ kind: 'none' })
})

test('the loop ticks every 15 minutes at most, is off with the tick, and a setting wins', () => {
  expect(loadLoopSettings({}).intervalMs.hygiene).toBe(15 * 60_000)
  expect(loadLoopSettings({}).intervalMs.friction).toBe(10_000)
  expect(loadLoopSettings({ FACTORY_TICK_MS: '0' }).intervalMs.hygiene).toBe(0)
  expect(loadLoopSettings({ FACTORY_TICK_MS: '3600000' }).intervalMs.hygiene).toBe(3_600_000)
  expect(loadLoopSettings({ FACTORY_LOOP_HYGIENE_MS: '60000' }).intervalMs.hygiene).toBe(60_000)
})
