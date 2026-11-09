import { expect, test } from 'bun:test'
import { condense } from '../../src/domains/quality/output.ts'

const watchdog = (extra: unknown[] = []) =>
  JSON.stringify(
    [
      { name: 'otel_export_down:worker-ingest', ok: true, detail: `fingerprint ${'ab12'.repeat(200)}` },
      { name: 'round_integrity:blend', ok: false, detail: 'round 41 has no blend row' },
      ...extra,
    ],
    null,
    2,
  )

test('a JSON list of checks becomes the checks with ok false, by name and detail', () => {
  const got = condense(`go test ./...\n${watchdog()}\nmake: *** [verify] Error 1`, 1_500)
  expect(got).toBe('1 of 2 checks failing:\nround_integrity:blend: round 41 has no blend row')
})

test('a list in an object under checks, compact on one line, is read too; a passing list is plain output', () => {
  const one = JSON.stringify({
    checks: [
      { name: 'a', ok: false, detail: { why: 'x' } },
      { name: 'b', ok: true },
    ],
  })
  expect(condense(one, 100)).toBe('1 of 2 checks failing:\na: {"why":"x"}')
  const green = JSON.stringify([{ name: 'a', ok: true, detail: 'fine' }])
  expect(condense(green, 100)).toBe(green)
})

test('failing checks share the budget; a long detail is cut at its lines, one line is kept whole or not at all', () => {
  const lines = Array.from({ length: 40 }, (_, n) => `row ${n} is missing`).join('\n')
  const got = condense(
    JSON.stringify([
      { name: 'a', ok: false, detail: lines },
      { name: 'b', ok: false, detail: 'z'.repeat(5_000) },
    ]),
    600,
  )
  expect(got.length).toBeLessThanOrEqual(600)
  expect(got).toContain('a:\n  row 0 is missing')
  expect(got).toMatch(/\[… \d+ lines cut\]/)
  expect(got).toContain('b: [detail of 5000 chars omitted]')
  for (const line of got.split('\n')) expect(line === '' || !/row \d+ is$/.test(line)).toBe(true)
})

test('short plain output is untouched', () => {
  expect(condense('exit fine\nok', 1_500)).toBe('exit fine\nok')
})

test('a long plain output keeps its error lines and its last lines, cut at line boundaries and marked', () => {
  const lines = Array.from({ length: 300 }, (_, n) => `line ${n} passing quietly`)
  lines[120] = 'src/a.ts:4: error TS2322: wrong type'
  lines[200] = 'src/b.ts:9: error TS2304: no name'
  const input = lines.join('\n')
  const got = condense(input, 800)
  expect(got.length).toBeLessThanOrEqual(800)
  expect(got).toContain('error TS2322: wrong type')
  expect(got).toContain('error TS2304: no name')
  expect(got).toContain('line 299 passing quietly')
  expect(got).toMatch(/\[… \d+ lines cut\]/)
  expect(got.startsWith('[… ')).toBe(true)
  const original = new Set(lines)
  for (const line of got.split('\n')) expect(original.has(line) || /^\[… \d+ lines? cut\]$/.test(line)).toBe(true)
})

test('a line longer than the budget is left out whole, never cut', () => {
  const huge = `error: ${'x'.repeat(3_000)}`
  const got = condense(['start', huge, 'end'].join('\n'), 500)
  expect(got).not.toContain('xxx')
  expect(got).toContain('end')
  expect(got).toMatch(/\[… 1 line cut\]/)
})

test('log lines in brackets around the list do not hide it', () => {
  const noise = Array.from({ length: 8 }, (_, n) => `[INFO] step ${n} ok`).join('\n')
  const list = JSON.stringify([{ name: 'a', ok: false, detail: 'broken' }])
  expect(condense(`${noise}\n${list}\n[INFO] done`, 1_500)).toBe('1 of 1 checks failing:\na: broken')
})
