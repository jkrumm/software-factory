import { expect, test } from 'bun:test'
import { applyFixes, fixable, probesOf } from '../../src/domains/hygiene/hygiene-fixes.ts'
import type { FixEntry, Probe, ProbeFinding, ProbeRun, SweepReport } from '../../src/domains/hygiene/hygiene-model.ts'

const finding = (probe: Probe, key: string, extra: Partial<ProbeFinding> = {}): ProbeFinding => ({
  probe,
  key,
  title: key,
  lines: ['a'],
  count: 1,
  ...extra,
})
const run = (probe: Probe, outcome: ProbeRun['outcome']): ProbeRun => ({
  probe,
  outcome,
  detail: outcome,
  covers: probe,
})
const report = (runs: ProbeRun[], findings: ProbeFinding[]): SweepReport => ({
  ref: 'abc',
  runs,
  findings,
  stale: [],
  slop: [],
})

test('only the keys a catalogue entry names under fix are fixable: bun deps yes, other ecosystems and other probes no', () => {
  const list = [
    finding('stale', 'stale:branches'),
    finding('stale', 'stale:worktrees'),
    finding('deps', 'deps'),
    finding('deps', 'deps:cargo'),
    finding('links', 'links:a.md'),
  ]
  expect(fixable(list).map((f) => f.key)).toEqual(['stale:branches', 'stale:worktrees', 'deps'])
  expect(probesOf(fixable(list))).toEqual(['stale', 'deps'])
})

test('a probe that ran again takes its runs and findings from the second run; the others stay', () => {
  const first = report(
    [run('stale', 'found'), run('links', 'found')],
    [finding('stale', 'stale:branches'), finding('links', 'links:a.md')],
  )
  const again = report([run('stale', 'clean')], [])
  const merged = applyFixes({ report: first, rerun: again, fixes: [] })
  expect(merged.findings.map((f) => f.key)).toEqual(['links:a.md'])
  expect(merged.runs.map((r) => `${r.probe}:${r.outcome}`).sort()).toEqual(['links:found', 'stale:clean'])
})

test('a second run that could not give a verdict heals nothing', () => {
  const first = report([run('stale', 'found')], [finding('stale', 'stale:branches')])
  const merged = applyFixes({ report: first, rerun: report([run('stale', 'failed')], []), fixes: [] })
  expect(merged.findings.map((f) => f.key)).toEqual(['stale:branches'])
  expect(merged.runs[0]?.outcome).toBe('found')
})

test('a finding still red after its script carries what the script did and printed, first in its plan', () => {
  const fix: FixEntry = { key: 'deps', outcome: 'failed', detail: 'make check is red', output: ['boom'] }
  const first = report([run('deps', 'found')], [finding('deps', 'deps', { plan: ['Upgrade plan'] })])
  const merged = applyFixes({ report: first, rerun: null, fixes: [fix] })
  expect(merged.findings[0]?.plan).toEqual([
    'The scripted fix failed, so this is yours: make check is red',
    '  boom',
    'Upgrade plan',
  ])
})

test('a deferred or skipped fix adds nothing to its finding', () => {
  const first = report([run('deps', 'found')], [finding('stale', 'stale:branches')])
  const merged = applyFixes({
    report: first,
    rerun: null,
    fixes: [
      { key: 'stale:branches', outcome: 'deferred', detail: 'later' },
      { key: 'deps', outcome: 'skipped', detail: 'ships by pull request' },
    ],
  })
  expect(merged.findings[0]?.plan).toBeUndefined()
})
