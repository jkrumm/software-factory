import { expect, test } from 'bun:test'
import { deploys, isInert } from '../../src/domains/quality/evidence.ts'
import {
  type Check,
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
  expect(detail).toContain('make verify failed: ')
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
