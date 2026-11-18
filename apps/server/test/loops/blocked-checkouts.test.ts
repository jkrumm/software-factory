import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { loopReads } from '../../src/read/loops.ts'

/*
 * A blocked watch's runs carry the checks the store writes (name, ok, detail; no extra keys). A failing `checkout` check
 * means the checkout cannot move; a CI wait has none, and a red check beside it does not make the checkout blocked.
 */
let db: TestCluster
const T0 = new Date('2026-11-18T12:00:00Z')
const CHECKOUT = { name: 'checkout', ok: false, detail: 'on another branch' }
const CI_RUNNING = { name: 'ci', ok: false, detail: 'CI is still running for d991ad5' }
const VERIFY = { name: 'make verify', ok: true, detail: 'ok' }
const VERIFY_RED = { name: 'make verify', ok: false, detail: 'red' }

/** A watch of blocked runs, oldest first, each run the checks it recorded. */
async function watch(issue: string, runs: unknown[][], answer: 'ended' | null = null) {
  await db.sql`INSERT INTO factory.issues (id, repo, state, outcome, version)
    VALUES (${issue}, 'app', 'watching', null, 1)`
  const key = `w:${issue}`
  await db.sql`INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at)
    VALUES (${key}, ${issue}, 1, 1, ${T0}, 0, ${answer}, ${answer ? T0 : null})`
  for (const [i, checks] of runs.entries())
    await db.sql`INSERT INTO factory.quality_checks (watch_key, n, at, outcome, checks)
      VALUES (${key}, ${i + 1}, ${new Date(T0.getTime() + i * 60_000)}, 'blocked', ${checks})`
}

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
  // a checkout that cannot move for six runs in a row: the steward notes it
  await watch(
    'issue_1',
    Array.from({ length: 6 }, () => [CHECKOUT, VERIFY]),
  )
  // CI still running for six runs in a row: a wait that ends by itself (missing after ten minutes, red after an hour)
  await watch(
    'issue_2',
    Array.from({ length: 6 }, () => [CI_RUNNING, VERIFY]),
  )
  // CI blocked for five runs, then the checkout blocked too on the newest run: the checkout is what stands
  await watch('issue_3', [...Array.from({ length: 5 }, () => [CI_RUNNING, VERIFY]), [CI_RUNNING, CHECKOUT]])
  // CI still running beside a red check of its own: the red does not make the checkout blocked
  await watch(
    'issue_5',
    Array.from({ length: 6 }, () => [CI_RUNNING, VERIFY_RED]),
  )
  // the checkout reads fine in a scratch worktree (ok) while CI still runs: the newest run is a CI wait
  await watch(
    'issue_6',
    Array.from({ length: 6 }, () => [{ name: 'checkout', ok: true, detail: 'read in a scratch worktree' }, CI_RUNNING]),
  )
  // a checkout blocked for six runs, but answered: no longer open
  await watch(
    'issue_4',
    Array.from({ length: 6 }, () => [CHECKOUT, VERIFY]),
    'ended',
  )
})
afterAll(() => db.stop())

test('a watch blocked by its checkout is a blocked checkout; one waiting on CI is not', async () => {
  const blocked = await loopReads(db.sql).blockedCheckouts(3, 10)
  expect(blocked.map((b) => String(b.issue))).toEqual(['issue_1', 'issue_3'])
  expect(blocked.find((b) => String(b.issue) === 'issue_1')).toMatchObject({ watch: 1, attempt: 1, checks: 3 })
})
