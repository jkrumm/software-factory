#!/usr/bin/env bun
/**
 * The cutover's import (`docs/rewrite/cutover-runbook.md`): the old core's schema `factory_legacy` into the new `factory`.
 *
 *   DATABASE_URL=… bun apps/server/scripts/import-legacy.ts                import (migrates first, then imports)
 *   DATABASE_URL=… bun apps/server/scripts/import-legacy.ts --compare      compare every Issue, old against new
 *
 * Idempotent: a second run changes nothing; a later run appends what the old core recorded after the first. Nothing is
 * ever deleted from the old schema (it is opened read only in effect: only SELECTs name it). The owner's token is not
 * involved: whoever holds the database credential may run it, as with the migrations. Exit 1 on an unexplained
 * mismatch (--compare), a conflict or a divergence (import).
 */
import { SQL } from 'bun'
import { join } from 'node:path'
import { loadMigrations, migrate } from '../src/adapters/postgres/migrate.ts'
import { compareLegacy, importLegacy } from './import/run.ts'

const args = process.argv.slice(2)
const flag = (name: string): boolean => args.includes(name)
const option = (name: string, fallback: string): string => {
  const at = args.indexOf(name)
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback
}

if (flag('--help') || flag('-h')) {
  console.log(
    'usage: import-legacy.ts [--compare] [--legacy-schema factory_legacy] [--data-dir <dir>] [--no-migrate] [--json]\n' +
      'DATABASE_URL names the shared database; FACTORY_DATA_DIR (default ~/.software-factory/data) holds the blobs.',
  )
  process.exit(0)
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error('import-legacy: DATABASE_URL is required (run under secrets-run, or the rehearsal)')
  process.exit(2)
}
const legacySchema = option('--legacy-schema', 'factory_legacy')
const dataDir = option(
  '--data-dir',
  process.env.FACTORY_DATA_DIR ?? join(process.env.HOME ?? '/tmp', '.software-factory', 'data'),
)
const json = flag('--json')

const sql = new SQL(url, { max: 4 })
try {
  const present = (await sql`SELECT 1 FROM pg_namespace WHERE nspname = ${legacySchema}`) as unknown[]
  if (present.length === 0) {
    console.error(`import-legacy: schema ${legacySchema} does not exist: rename the old core's schema first`)
    process.exit(2)
  }

  if (!flag('--no-migrate') && !flag('--compare')) {
    const applied = await migrate(sql, await loadMigrations())
    if (applied.length > 0 && !json) console.error(`import-legacy: migrated ${applied.length} files`)
  }

  if (flag('--compare')) {
    const report = await compareLegacy({ sql, legacySchema })
    if (json) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(
        `compared ${report.compared} Issues: ${report.matching} match, ${report.explained.length} explained, ${report.unexplained.length} unexplained, ${report.carried} carried (the new core worked them since)`,
      )
      console.log(`old events without a disposition: ${report.undisposed}`)
      if (report.explained.length > 0) {
        console.log('\nexplained differences')
        console.log('|issue|field|old|new|reason|')
        console.log('|-|-|-|-|-|')
        for (const m of report.explained) console.log(`|${m.legacyId}|${m.field}|${m.old}|${m.new}|${m.reason}|`)
      }
      if (report.unexplained.length > 0) {
        console.log('\nUNEXPLAINED differences')
        console.log('|issue|field|old|new|')
        console.log('|-|-|-|-|')
        for (const m of report.unexplained) console.log(`|${m.legacyId}|${m.field}|${m.old}|${m.new}|`)
      }
    }
    process.exit(report.unexplained.length === 0 && report.undisposed === 0 ? 0 : 1)
  }

  const report = await importLegacy({ sql, legacySchema, dataDir, now: new Date() })
  const count = (result: string): number => report.issues.filter((i) => i.result === result).length
  const bad = report.issues.filter((i) => i.result === 'conflict' || i.result === 'diverged')
  if (json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(
      `issues: ${count('imported')} imported, ${count('appended')} appended, ${count('unchanged')} unchanged, ${count('diverged')} diverged, ${count('conflict')} in conflict`,
    )
    console.log(
      `issue number sequence at ${report.sequence}; claims ${report.claims}; chain edges ${report.edges}; plan rows ${report.planRows}`,
    )
    console.log(`door: ${JSON.stringify(report.door)}`)
    console.log('old events, by what became of them:')
    for (const k of report.kinds) console.log(`  ${k.kind.padEnd(20)} ${k.disposition.padEnd(8)} ${k.count}`)
    console.log(
      `machine on the mapped events: ${report.machine.applied} applied, ${report.machine.refused} refused, ${report.machine.ignored} ignored`,
    )
    for (const r of report.machine.reasons) console.log(`  ${String(r.count).padStart(4)}  ${r.reason}`)
    for (const note of report.notes) console.log(`note: ${note}`)
    for (const item of bad) console.log(`${item.result}: Issue ${item.legacyId}: ${item.detail}`)
  }
  process.exit(bad.length === 0 ? 0 : 1)
} finally {
  await sql.close()
}
