import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresLoopStore } from '../../src/adapters/postgres/loop-store.ts'
import { claimRound } from '../../src/app/loops/claim.ts'
import type { CallPolicy } from '../../src/domains/loops/calls.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'

/** The loops' table on a real Postgres: the claim, the restart that lapses an open call, and the retake under its own key. */
let db: TestCluster
const issue = 'issue_1' as IssueId
const policy: CallPolicy = { maxRounds: 3, retryMs: 600_000, leaseMs: 35 * 60_000 }
const keyFor = (round: number) => key('steward', issue, 9, round)

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
  await db.sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${issue}, 'app', 'queued', 1)`
})
afterAll(() => db.stop())

test('a claimed call is in flight; after a restart (lapseOpen) it is retaken under its own key, once', async () => {
  const loops = postgresLoopStore(db.sql)
  const now = new Date()
  const ask = (at: Date) =>
    claimRound({ loops }, { loop: 'steward', issue, subject: 'wait:9', now: at, policy, keyFor })

  expect(await ask(now)).toEqual({ kind: 'claimed', round: 1, key: keyFor(1) })
  // another pass inside the lease leaves it alone
  expect(await ask(new Date(now.getTime() + 1_000))).toEqual({ kind: 'in_flight' })

  // the server restarts: no call of the old process is running, so every open lease lapses now
  const later = new Date(now.getTime() + 5_000)
  expect(await loops.lapseOpen(later)).toBe(1)
  expect(await ask(later)).toEqual({ kind: 'claimed', round: 1, key: keyFor(1) })
  // taken once: the retaken call holds a new lease
  expect(await ask(new Date(later.getTime() + 1_000))).toEqual({ kind: 'in_flight' })
  expect((await loops.calls('steward', issue, 'wait:9')).map((row) => [row.round, row.outcome])).toEqual([[1, null]])

  // it ends; the next ask is not a retake but waits out the retry
  await loops.finishCall(keyFor(1), { outcome: 'failed', answer: null, detail: 'gone', at: later })
  expect((await ask(new Date(later.getTime() + 2_000))).kind).toBe('backoff')
  expect(await loops.lapseOpen(later)).toBe(0)
})
