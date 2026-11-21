import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOOP_NAMES } from '../../packages/contract/src/loops.ts'
import { asked, intervalText, problemsIn, render } from '../loops-table.ts'

const DOC = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'architecture.md'), 'utf8')

describe('the loops table of docs/architecture.md', () => {
  test('is what the code says', () => {
    expect(problemsIn(DOC)).toEqual([])
  })

  test('has one row per loop', () => {
    const rows = render().split('\n').slice(2)
    expect(rows.length).toBe(LOOP_NAMES.length)
    for (const name of LOOP_NAMES) expect(rows.some((row) => row.startsWith(`| \`${name}\` |`))).toBe(true)
  })

  test('names the workflows a loop asks', () => {
    expect(render()).toContain('| `steward` | 10 s | `factory-steward` |')
  })

  test('reads an agw name from a WORKFLOWS use', () => {
    expect(asked('agw.run(WORKFLOWS.queue.agw, req, WORKFLOWS.queue.key(a))')).toEqual([
      'factory-queue',
      'factory-queue',
    ])
    expect(asked('WORKFLOWS.nothing.key()')).toEqual([])
  })

  test('says an interval in its own unit', () => {
    expect([0, 10_000, 300_000, 21_600_000].map(intervalText)).toEqual(['off', '10 s', '5 min', '6 h'])
  })

  test('refuses a document without markers, and a stale block', () => {
    expect(problemsIn('no markers')).toHaveLength(1)
    const stale = DOC.replace('| `host` | 1 min |', '| `host` | 2 min |')
    expect(problemsIn(stale)).toHaveLength(1)
  })
})
