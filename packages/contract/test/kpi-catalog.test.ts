import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KPI_CATALOG, KPI_KEYS, KPI_TABLE_END, KPI_TABLE_START, renderKpiTable } from '../src/index.ts'

describe('the KPI catalog', () => {
  test('docs/product.md carries the table the catalog renders', async () => {
    const text = await readFile(join(import.meta.dir, '..', '..', '..', 'docs', 'product.md'), 'utf8')
    const start = text.indexOf(KPI_TABLE_START)
    const end = text.indexOf(KPI_TABLE_END)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    // a failure here means the catalog changed without the page: `bun scripts/kpi-table.ts` rewrites it
    expect(text.slice(start, end + KPI_TABLE_END.length)).toBe(renderKpiTable())
  })

  test('every KPI key has a row, and nothing else has', () => {
    expect(Object.keys(KPI_CATALOG).toSorted()).toEqual([...KPI_KEYS].toSorted())
  })

  test('every KPI names what it counts, over what, its target source and the decision it drives', () => {
    for (const [key, spec] of Object.entries(KPI_CATALOG)) {
      for (const field of ['label', 'targetSource', 'numerator', 'denominator', 'decision'] as const)
        expect(spec[field].trim().length, `${key}.${field}`).toBeGreaterThan(8)
    }
  })

  test('a target follows its direction, so a value better than the target is never off it', () => {
    for (const [key, spec] of Object.entries(KPI_CATALOG)) {
      const { kind, min, max } = spec.target
      if (spec.direction === 'lower' && kind === 'at_most') {
        expect(min, key).toBeNull()
        expect(max, key).not.toBeNull()
      } else if (spec.direction === 'higher' && kind === 'at_least') {
        expect(max, key).toBeNull()
        expect(min, key).not.toBeNull()
      } else {
        // no number: a trend, and the source says why
        expect(kind, `${key} has direction ${spec.direction} and target ${kind}`).toBe('trend')
        expect(spec.targetSource, key).toMatch(/^Watch only/)
      }
    }
  })
})
