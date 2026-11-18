import { expect, test } from 'bun:test'
import { HYGIENE_DEFAULTS } from '@software-factory/contract'
import { foldDependencies, judgeRefresh } from '../../src/domains/loops/dependency-refresh.ts'
import type { AdvisoryRow, DependencyRow, ProbeFinding, ProbeRun } from '../../src/domains/loops/hygiene-model.ts'

const DAY = 86_400_000
const now = new Date('2026-11-18T12:00:00Z')
const thresholds = HYGIENE_DEFAULTS.deps
const ago = (days: number) => new Date(now.getTime() - days * DAY)

const row = (over: Partial<DependencyRow> & Pick<DependencyRow, 'name' | 'size'>): DependencyRow => ({
  ecosystem: 'npm',
  current: '1.0.0',
  latest: over.size === 'major' ? '2.0.0' : over.size === 'minor' ? '1.1.0' : '1.0.1',
  dev: false,
  releasedAt: ago(90),
  ...over,
})
const advisory = (over: Partial<AdvisoryRow> = {}): AdvisoryRow => ({
  pkg: 'minimist',
  version: '>=1.0.0 <1.2.6',
  id: 'GHSA-xvch-5gv4-984h',
  severity: 'high',
  fixedIn: '1.2.6',
  source: 'bun',
  ...over,
})
const judge = (rows: DependencyRow[], advisories: AdvisoryRow[] = []) =>
  judgeRefresh({ rows, advisories, thresholds, now })

test('one dev dependency one patch behind files nothing', () => {
  expect(judge([row({ name: 'typescript', size: 'patch', dev: true })]).reasons).toEqual([])
})

test('a lone runtime patch, and a runtime minor younger than 30 days, file nothing', () => {
  expect(judge([row({ name: 'hono', size: 'patch' })]).reasons).toEqual([])
  expect(judge([row({ name: 'hono', size: 'minor', releasedAt: ago(29) })]).reasons).toEqual([])
  // a release date nobody could look up is not an age
  expect(judge([row({ name: 'hono', size: 'minor', releasedAt: undefined })]).reasons).toEqual([])
})

test('a high advisory with a fixed version files', () => {
  expect(judge([], [advisory()]).reasons).toEqual(['1 high or critical advisory with a fixed version (minimist)'])
})

test('a runtime major files, a dev major and a GitHub Actions major do not alone', () => {
  expect(judge([row({ name: 'zod', size: 'major' })]).reasons).toEqual(['1 runtime major behind (zod)'])
  expect(judge([row({ name: 'typescript', size: 'major', dev: true })]).reasons).toEqual([])
  expect(judge([row({ name: 'actions/checkout', size: 'major', ecosystem: 'actions', dev: true })]).reasons).toEqual([])
  expect(judge([row({ name: 'node', size: 'major', ecosystem: 'docker' })]).reasons).toEqual([
    '1 runtime major behind (node)',
  ])
})

test('a runtime minor is material at 30 days', () => {
  expect(judge([row({ name: 'hono', size: 'minor', releasedAt: ago(30) })]).reasons).toEqual([
    '1 runtime dependency a minor behind for 30+ days (hono)',
  ])
})

test('ten dependencies behind file, nine do not, whatever they are', () => {
  const dev = (n: number) => Array.from({ length: n }, (_, i) => row({ name: `tool-${i}`, size: 'patch', dev: true }))
  expect(judge(dev(9)).reasons).toEqual([])
  expect(judge(dev(10)).reasons).toEqual(['10 dependencies behind, the bar is 10'])
})

test("a version inside its cooldown never counts: 7 days, 14 for a major, and the package manager's own hold", () => {
  const held = [
    row({ name: 'a', size: 'minor', releasedAt: ago(3) }),
    row({ name: 'b', size: 'major', releasedAt: ago(10) }),
    row({ name: 'c', size: 'major', releasedAt: undefined, heldBack: true }),
  ]
  const out = judge(held)
  expect(out.reasons).toEqual([])
  expect(out.held.map((r) => r.name)).toEqual(['a', 'b', 'c'])
  expect(judge([row({ name: 'b', size: 'major', releasedAt: ago(14) })]).reasons).toEqual([
    '1 runtime major behind (b)',
  ])
})

const run = (probe: 'deps' | 'advisories', over: Partial<ProbeRun> = {}): ProbeRun => ({
  probe,
  outcome: 'clean',
  detail: probe,
  covers: probe,
  ...over,
})
const depsFinding = (rows: DependencyRow[], key = 'deps'): ProbeFinding => ({
  probe: 'deps',
  key,
  title: 'Hygiene: outdated dependencies',
  lines: rows.map((r) => r.name),
  count: rows.length,
  rows,
})
const advisoriesFinding = (advisories: AdvisoryRow[]): ProbeFinding => ({
  probe: 'advisories',
  key: 'advisories:bun',
  title: 'Hygiene: security advisories in Bun dependencies',
  lines: [],
  count: advisories.length,
  advisories,
})
const fold = (findings: ProbeFinding[], runs: ProbeRun[]) => foldDependencies({ findings, runs, thresholds, now })

test('every ecosystem and the advisories are one finding with a section each, one procedure, and no stored rows', () => {
  const out = fold(
    [
      depsFinding([row({ name: 'zod', size: 'major' }), row({ name: 'hono', size: 'patch' })]),
      depsFinding([row({ name: 'serde', size: 'minor', ecosystem: 'cargo' })], 'deps:cargo'),
      depsFinding([row({ name: 'mariadb', size: 'major', ecosystem: 'docker', releasedAt: ago(2) })], 'deps:docker'),
      advisoriesFinding([advisory()]),
    ],
    [run('deps', { outcome: 'found' }), run('advisories', { outcome: 'found' })],
  )
  expect(out.findings).toHaveLength(1)
  const [finding] = out.findings
  expect(finding).toMatchObject({ probe: 'deps', key: 'deps', title: 'Hygiene: dependency refresh', count: 4 })
  expect(finding?.rows).toBeUndefined()
  expect(finding?.advisories).toBeUndefined()
  const plan = (finding?.plan ?? []).join('\n')
  for (const heading of ['## Advisories with a fixed version', '## npm (', '## Cargo (', '## Docker ('])
    expect(plan).toContain(heading)
  // the cooldown is planned from the release date: a major published 2 days ago opens on day 14
  expect(plan).toContain('until 2026-11-30 (14-day cooldown): mariadb 1.0.0 -> 2.0.0 (major)')
  expect(plan.match(/Procedure \(light seat/g)).toHaveLength(1)
  expect(finding?.lines[0]).toBe(
    'Why filed: 1 high or critical advisory with a fixed version (minimist); 1 runtime major behind (zod); 1 runtime dependency a minor behind for 30+ days (serde)',
  )
  expect(out.runs[0]?.detail).toContain('filed as one refresh')
})

test('below the bar: no finding, the deps run is clean and says what is behind', () => {
  const out = fold(
    [depsFinding([row({ name: 'hono', size: 'patch' })])],
    [run('deps', { outcome: 'found', detail: 'bun outdated, 1 packages' })],
  )
  expect(out.findings).toEqual([])
  expect(out.runs[0]).toMatchObject({ outcome: 'clean' })
  expect(out.runs[0]?.detail).toBe(
    'bun outdated, 1 packages; below the bar, not filed: 1 of 10 behind (1 runtime): hono',
  )
})

test('findings of other probes pass through untouched', () => {
  const other: ProbeFinding = { probe: 'links', key: 'links:a', title: 't', lines: [], count: 1 }
  expect(fold([other], [run('deps')]).findings).toEqual([other])
})

test('a deps run is no verdict on the key when the advisories it folds in were not judged', () => {
  const judged = fold([], [run('deps'), run('advisories')])
  expect(judged.runs[0]?.unjudged).toBeUndefined()
  for (const advisories of [
    run('advisories', { outcome: 'failed' }),
    run('advisories', { outcome: 'clean', unjudged: ['advisories:osv'] }),
    run('advisories', { outcome: 'skipped', detail: 'osv-scanner is not installed on this host' }),
  ]) {
    expect(fold([], [run('deps'), advisories]).runs[0]?.unjudged).toEqual(['deps'])
  }
  // nothing to scan, or the project opted out: nothing was left unjudged
  for (const detail of ['no supported lockfile is tracked', 'the project opts out: generated']) {
    expect(fold([], [run('deps'), run('advisories', { outcome: 'skipped', detail })]).runs[0]?.unjudged).toBeUndefined()
  }
})

test('a steady pass has no deps run: advisories alone can file, and nothing else is said', () => {
  const out = fold([advisoriesFinding([advisory()])], [run('advisories', { outcome: 'found' })])
  expect(out.findings.map((f) => f.key)).toEqual(['deps'])
  expect(out.runs).toHaveLength(1)
})
