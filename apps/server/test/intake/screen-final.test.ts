import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { postgresIntakeStore } from '../../src/adapters/intake/store.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { FINAL_SCREEN_MS, MAX_SCREEN_ATTEMPTS, SCREEN_BATCH } from '../../src/domains/intake/screen.ts'
import { readNeeds } from '../../src/read/needs.ts'

/** Which held signals the screen loop picks up, and which leave Needs you once the last look decided: over a real Postgres. */
let db: TestCluster
const NOW = new Date('2026-11-13T08:00:00Z')
const HOUR = 3_600_000
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * HOUR)

beforeAll(async () => {
  db = await startTestCluster()
})
afterAll(() => db.stop())
beforeEach(async () => {
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
})

async function hold(id: string, receivedAt: Date, screening: { at?: Date; attempts?: number; retry?: Date } = {}) {
  await db.sql`INSERT INTO factory.intake_signals
    (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, screened_at, screen_attempts, screen_retry_at, screen_note)
    VALUES (${id}, 'github', 'remark', 'github', 'outside', 'ntfy-mac', ${`fp-${id}`}, ${`Title ${id}`}, 'a stranger asks', ${receivedAt}, 'held',
      ${screening.at ?? null}, ${screening.attempts ?? 0}, ${screening.retry ?? null}, ${screening.at ? 'unclear' : null})`
}

const due = async (): Promise<string[]> => {
  const rows = await postgresIntakeStore(db.sql).screenable(NOW, MAX_SCREEN_ATTEMPTS, SCREEN_BATCH, FINAL_SCREEN_MS)
  return rows.map((row) => row.id)
}

test('a young unscreened signal is picked up; a young one already screened is left to the owner', async () => {
  await hold('young_new', ago(2))
  await hold('young_left', ago(5), { at: ago(4) })
  expect(await due()).toEqual(['young_new'])
})

test('a signal 72 h old is screened again once, even after a leave, and failed calls do not cap it', async () => {
  await hold('old_left', ago(100), { at: ago(99) })
  await hold('old_capped', ago(100), { at: ago(99), attempts: MAX_SCREEN_ATTEMPTS + 3 })
  await hold('old_unscreened_capped', ago(100), { attempts: MAX_SCREEN_ATTEMPTS + 3 })
  // already screened since it got 72 h old: the last look is done
  await hold('old_done', ago(100), { at: ago(10) })
  // a failed call backs off
  await hold('old_backoff', ago(100), { at: ago(99), retry: new Date(NOW.getTime() + HOUR) })
  expect((await due()).toSorted()).toEqual(['old_capped', 'old_left', 'old_unscreened_capped'])
})

test('a held signal that the last look promoted or dismissed is no longer a need', async () => {
  await hold('old_left', ago(100), { at: ago(99) })
  expect((await readNeeds(db.sql, NOW)).items.map((item) => item.kind)).toEqual(['held_signal'])
  await db.sql`UPDATE factory.intake_signals SET state = 'dismissed', dismissed_at = ${NOW}, dismissed_by = 'judge', dismissed_reason = 'held 72 hours with no decision' WHERE id = 'old_left'`
  expect((await readNeeds(db.sql, NOW)).items).toEqual([])
})
