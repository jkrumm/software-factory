/**
 * `bun apps/server/src/migrate-check.ts`: runs this release's pending migrations against the live database inside a
 * transaction that is rolled back, so `scripts/deploy.sh` learns before it stops the old server whether the new one will
 * get past its migrations. Needs `DATABASE_URL` (the deploy runs it through `secrets-run`). Exit 0: they apply (or none
 * is pending); 3: a lock the live server holds could not be had in time, which says nothing about the migrations; 1: a
 * migration is refused, with the database's words on stderr.
 */
import { connect } from './adapters/postgres/connection.ts'
import { loadMigrations, migrate } from './adapters/postgres/migrate.ts'

const LOCK_NOT_AVAILABLE = '55P03'
const EXIT_LOCKED = 3

const url = process.env.DATABASE_URL
if (!url) {
  console.error('migrate-check: DATABASE_URL is not set')
  process.exit(1)
}

const sql = connect(url)
try {
  const pending = await migrate(sql, await loadMigrations(), { dryRun: true })
  console.log(pending.length ? `migrations apply: ${pending.join(', ')}` : 'no migration pending')
} catch (error) {
  const state = (error as { errno?: unknown; code?: unknown }).errno ?? (error as { code?: unknown }).code
  console.error(`migrate-check: ${error instanceof Error ? error.message : String(error)}`)
  await sql.close()
  process.exit(state === LOCK_NOT_AVAILABLE ? EXIT_LOCKED : 1)
}
await sql.close()
