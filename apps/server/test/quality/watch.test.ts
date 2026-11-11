import { expect, test } from 'bun:test'
import { deploys, isInert } from '../../src/domains/quality/evidence.ts'
import {
  type Check,
  ciCheck,
  markInherited,
  MAX_RETRIES,
  nextCheckAt,
  outcomeOf,
  type Ran,
  regressionDetail,
  stepOf,
  type Timing,
} from '../../src/domains/quality/watch.ts'

const green: Check = { name: 'make verify', ok: true, detail: 'exit 0' }
const red: Check = { name: 'make verify', ok: false, detail: 'exit 1: boom' }
const blocked: Check = { name: 'checkout', ok: false, blocked: true, detail: 'on another branch' }
const timing: Timing = { retryMs: 60_000, recheckMs: 300_000 }
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, minutes))

test('the outcome of checks: any blocked check blocks, any failed check is red, otherwise green; no check is green', () => {
  expect(outcomeOf([])).toBe('green')
  expect(outcomeOf([green, green])).toBe('green')
  expect(outcomeOf([green, red])).toBe('red')
  expect(outcomeOf([red, blocked])).toBe('blocked')
})

test('the first check is at the end of the window; after a red it waits 1, 2, then 4 retry delays', () => {
  const watch = { startedAt: at(0), windowMs: 30 * 60_000 }
  expect(nextCheckAt(watch, [], timing)).toEqual(at(30))
  const reds: Ran[] = []
  const due: Date[] = []
  for (let n = 0; n < MAX_RETRIES; n++) {
    reds.push({ at: at(30 + n * 10), outcome: 'red' })
    due.push(nextCheckAt(watch, reds, timing))
  }
  expect(due).toEqual([at(31), at(30 + 10 + 2), at(30 + 20 + 4)])
})

test('a blocked checkout is looked at again after the recheck delay and counts as no red', () => {
  const watch = { startedAt: at(0), windowMs: 0 }
  const ran: Ran[] = [{ at: at(10), outcome: 'blocked' }]
  expect(nextCheckAt(watch, ran, timing)).toEqual(at(15))
  expect(stepOf(ran, [red])).toEqual({ kind: 'again' })
})

test('green passes; a red is retried three times and the fourth red regresses, naming what failed', () => {
  expect(stepOf([], [green])).toEqual({ kind: 'pass' })
  const reds = (n: number): Ran[] => Array.from({ length: n }, (_, i) => ({ at: at(i), outcome: 'red' as const }))
  expect(stepOf(reds(0), [red])).toEqual({ kind: 'again' })
  expect(stepOf(reds(MAX_RETRIES - 1), [red])).toEqual({ kind: 'again' })
  expect(stepOf(reds(MAX_RETRIES), [green, red])).toEqual({
    kind: 'regress',
    detail: 'make verify failed: exit 1: boom',
  })
  expect(stepOf(reds(MAX_RETRIES), [green])).toEqual({ kind: 'pass' })
})

test('a regression detail names every failed check and is cut at line boundaries, marked, never inside a line', () => {
  const output = Array.from({ length: 200 }, (_, n) => `line ${n} of the output`).join('\n')
  const long: Check = { name: 'make verify', ok: false, detail: `exit 1: ${output}` }
  const other: Check = { name: 'probe', ok: false, detail: 'HTTP 503, expected 200' }
  const detail = regressionDetail([green, long, other])
  expect(detail.length).toBeLessThanOrEqual(1_900)
  expect(detail).toContain('make verify failed, first failing lines:')
  expect(detail).toContain('probe failed: HTTP 503, expected 200')
  expect(detail).toMatch(/\[… \d+ lines cut\]/)
  expect(detail).toContain('line 199 of the output')
})

test('docs, text, licences and tests are inert; everything else deploys', () => {
  for (const path of [
    'docs/a.md',
    'docs/plan.yaml',
    'project.yaml',
    'README.md',
    'notes/a.txt',
    'LICENSE',
    'a/LICENSE.md',
    'test/a.ts',
    'a/tests/b.ts',
    'a.test.ts',
    'x/y.spec.tsx',
    '.gitignore',
  ]) {
    expect(isInert(path)).toBe(true)
  }
  for (const path of [
    'src/a.ts',
    'apps/server/src/a.ts',
    'apps/project.yaml',
    'Makefile',
    'deploy/run.sh',
    'ui/a.tsx',
    'migrations/0001.sql',
  ]) {
    expect(isInert(path)).toBe(false)
  }
  expect(deploys(['docs/a.md', 'a.test.ts'])).toBe(false)
  expect(deploys(['project.yaml', 'docs/plan.yaml'])).toBe(false)
  expect(deploys(['project.yaml', 'apps/server/src/a.ts'])).toBe(true)
  expect(deploys(['docs/a.md', 'src/a.ts'])).toBe(true)
})

const SHA = 'abcdef0123456789'
const MERGED = new Date('2026-01-01T12:00:00Z')
const minutesAfter = (n: number) => new Date(MERGED.getTime() + n * 60_000)
const when = (now: Date) => ({ sha: SHA, mergedAt: MERGED, now })

test('CI green passes and red names the failing check with its page', () => {
  expect(ciCheck({ status: 'green', url: null, reason: null }, when(minutesAfter(1)))).toEqual({
    name: 'ci',
    ok: true,
    detail: 'CI green for abcdef0',
  })
  expect(
    ciCheck({ status: 'red', url: 'https://example.com/run/1', reason: 'build failure' }, when(minutesAfter(1))),
  ).toEqual({ name: 'ci', ok: false, detail: 'build failure for abcdef0 (https://example.com/run/1)' })
})

test('CI still running is blocked (neither a pass nor a regression) until an hour after the merge, then red', () => {
  const running = { status: 'running' as const, url: null, reason: 'build is still running' }
  const early = ciCheck(running, when(minutesAfter(59)))
  expect(early).toMatchObject({ ok: false, blocked: true, detail: expect.stringContaining('still running') })
  expect(outcomeOf([early])).toBe('blocked')
  const late = ciCheck(running, when(minutesAfter(61)))
  expect(late.blocked).toBeUndefined()
  expect(late).toMatchObject({ ok: false, detail: expect.stringContaining('CI did not finish') })
  expect(outcomeOf([late])).toBe('red')
})

test('no CI run is blocked for ten minutes after the merge, then passes: the repo may have none', () => {
  const missing = { status: 'missing' as const, url: null, reason: 'no check ran' }
  expect(ciCheck(missing, when(minutesAfter(9)))).toMatchObject({ ok: false, blocked: true })
  expect(ciCheck(missing, when(minutesAfter(10)))).toEqual({
    name: 'ci',
    ok: true,
    detail: 'no CI run found for abcdef0',
  })
  // with no merge time the commit is old enough
  expect(ciCheck(missing, { sha: SHA, mergedAt: null, now: MERGED }).ok).toBe(true)
})

test('a make target that failed the same way before the ship is inherited: not red, not in the regression detail', () => {
  const before = [{ name: 'make verify', ok: false, detail: 'exit 2: drift-check: 3 pending updates (pid 4121)' }]
  const now: Check = { name: 'make verify', ok: false, detail: 'exit 2: drift-check: 7 pending updates (pid 9)' }
  const marked = markInherited([now], before)
  expect(marked).toEqual([{ ...now, inherited: true }])
  expect(outcomeOf(marked)).toBe('green')
  expect(stepOf([], marked)).toEqual({ kind: 'pass' })
  expect(regressionDetail([...marked, { name: 'probe', ok: false, detail: 'HTTP 503, expected 200' }])).toBe(
    'probe failed: HTTP 503, expected 200',
  )
})

test('only a make target inherits, and only from the same failure: another output, a green run, no run, a probe or the version do not', () => {
  const failing = (name: string, detail: string): Check => ({ name, ok: false, detail })
  const drift = { name: 'make verify', ok: false, detail: 'exit 2: drift-check failed' }
  const before = [
    drift,
    { name: 'deployed version', ok: false, detail: 'deployed abc is behind' },
    { name: 'probe', ok: false, detail: 'HTTP 503, expected 200' },
  ]
  const inheritedOf = (check: Check, baseline: Parameters<typeof markInherited>[1]) =>
    markInherited([check], baseline)[0]?.inherited
  expect(inheritedOf(failing('make verify', 'exit 1: a test broke'), before)).toBeUndefined()
  expect(inheritedOf(failing('make verify', drift.detail), [{ ...drift, ok: true }])).toBeUndefined()
  expect(inheritedOf(failing('make verify', drift.detail), null)).toBeUndefined()
  expect(inheritedOf(failing('deployed version', 'deployed abc is behind'), before)).toBeUndefined()
  expect(inheritedOf(failing('probe', 'HTTP 503, expected 200'), before)).toBeUndefined()
  expect(inheritedOf(failing('make verify', drift.detail), before)).toBe(true)
  // a check that was itself inherited before still counts as the failure that was there
  expect(inheritedOf(failing('make verify', drift.detail), [{ ...drift, inherited: true }])).toBe(true)
})

test('two runs of one red target that differ by a drift line are inherited; a new failing line is not', () => {
  const drift = (items: string[]) => `exit 2: checking drift\n${items.map((item) => `DRIFT ${item}`).join('\n')}`
  const before = [{ name: 'make verify', ok: false, detail: drift(['macos 26.1 pending', 'tailscale 1.90 behind']) }]
  const check = (detail: string): Check => ({ name: 'make verify', ok: false, detail })
  const inheritedOf = (detail: string) => markInherited([check(detail)], before)[0]?.inherited
  // one drift line more or fewer, a changed number, a changed exit code: the same red
  expect(inheritedOf(drift(['macos 26.2 pending', 'tailscale 1.92 behind']))).toBe(true)
  expect(inheritedOf(drift(['macos 26.1 pending']))).toBe(true)
  expect(inheritedOf(drift(['macos 26.1 pending', 'tailscale 1.90 behind']).replace('exit 2', 'exit 1'))).toBe(true)
  // a line the baseline never had is the change's
  expect(inheritedOf(drift(['macos 26.1 pending', 'weatherorb build broke']))).toBeUndefined()
  expect(inheritedOf(drift(['macos 26.1 pending', 'tailscale 1.90 behind', 'node 24.1 behind']))).toBeUndefined()
  expect(inheritedOf('exit 1: a test broke')).toBeUndefined()
  // a cut marker is no line, and a run that printed nothing is compared whole
  expect(inheritedOf(`${drift(['macos 26.1 pending'])}\n[… 12 lines cut]`)).toBe(true)
  expect(
    markInherited([check('exit 2: ')], [{ name: 'make verify', ok: false, detail: 'exit 2: ' }])[0]?.inherited,
  ).toBe(true)
  expect(markInherited([check('exit 2: ')], before)[0]?.inherited).toBeUndefined()
})

test('the regression note names the failed checks first, then their first failing lines, then the cut output', () => {
  const output = [
    ...Array.from({ length: 150 }, (_, n) => `line ${n} of the output`),
    'ERROR: drift-check: tailscale is behind',
    'ERROR: drift-check: macos update pending',
    ...Array.from({ length: 50 }, (_, n) => `tail ${n}`),
  ].join('\n')
  const long: Check = { name: 'make verify', ok: false, detail: `exit 2: ${output}` }
  const probe: Check = { name: 'probe', ok: false, detail: 'HTTP 503, expected 200' }
  const detail = regressionDetail([long, probe])
  expect(detail.length).toBeLessThanOrEqual(1_900)
  const lines = detail.split('\n')
  expect(lines[0]).toBe('2 checks failed: make verify, probe')
  expect(lines[1]).toBe('make verify failed, first failing lines:')
  expect(lines[2]).toBe('  ERROR: drift-check: tailscale is behind')
  expect(lines[3]).toBe('  ERROR: drift-check: macos update pending')
  expect(detail.indexOf('output:')).toBeGreaterThan(detail.indexOf('macos update pending'))
  expect(detail).toMatch(/\[… \d+ lines cut\]/)
  expect(detail).toContain('probe failed: HTTP 503, expected 200')
})
