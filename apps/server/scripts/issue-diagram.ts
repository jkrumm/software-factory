#!/usr/bin/env bun
/**
 * Writes the Issue machine's diagram, generated from `TABLE`, into `docs/language.md` between its markers. `--check`
 * exits 1 when the block there is stale, so the words and the code cannot drift (`make check`).
 */
import { join } from 'node:path'
import { withDiagram } from '../src/domains/work/diagram.ts'

export const LANGUAGE = join(import.meta.dir, '..', '..', '..', 'docs', 'language.md')

const current = await Bun.file(LANGUAGE).text()
const next = withDiagram(current)
if (next === null) {
  console.error(`${LANGUAGE} has no issue-machine markers`)
  process.exit(1)
}
if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('docs/language.md: the Issue diagram is stale; run bun apps/server/scripts/issue-diagram.ts')
    process.exit(1)
  }
} else if (next !== current) {
  await Bun.write(LANGUAGE, next)
  console.log('docs/language.md: the Issue diagram is written')
}
