#!/usr/bin/env bun
/**
 * The KPI table of `docs/product.md`, rendered from the catalog (`packages/contract/src/kpi-catalog.ts`) between its two
 * markers. `bun scripts/kpi-table.ts` rewrites it; `--check` (run by `make check`) exits 1 when the file differs. The
 * contract's test holds the same comparison.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KPI_TABLE_END, KPI_TABLE_START, renderKpiTable } from '../packages/contract/src/kpi-catalog.ts'

const file = join(import.meta.dir, '..', 'docs', 'product.md')

/** `text` with the block between the markers replaced by `table`; null when a marker is missing. */
export function withTable(text: string, table: string): string | null {
  const start = text.indexOf(KPI_TABLE_START)
  const end = text.indexOf(KPI_TABLE_END)
  if (start === -1 || end === -1 || end < start) return null
  return text.slice(0, start) + table + text.slice(end + KPI_TABLE_END.length)
}

if (import.meta.main) {
  const text = await readFile(file, 'utf8')
  const next = withTable(text, renderKpiTable())
  if (next === null) {
    console.error(`docs/product.md has no KPI table markers (${KPI_TABLE_START} ... ${KPI_TABLE_END})`)
    process.exit(1)
  }
  if (process.argv.includes('--check')) {
    if (next !== text) {
      console.error('the KPI table of docs/product.md is not the catalog: run `bun scripts/kpi-table.ts`')
      process.exit(1)
    }
  } else if (next !== text) {
    await writeFile(file, next)
    console.log('docs/product.md: KPI table rewritten')
  }
}
