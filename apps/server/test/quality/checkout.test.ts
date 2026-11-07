import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { postgresLeadStore } from '../../src/adapters/leads/store.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { leadCheckoutOf } from '../../src/app/quality-checkout.ts'
import { issueId } from '../../src/kernel/ids.ts'
import { ok } from '../../src/kernel/result.ts'

let db: TestCluster
beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
})
afterAll(async () => {
  await db.stop()
})

test('quality reads where an attempt worked from the leads store: its directory, branch and cut', async () => {
  const uow = postgresUnitOfWork(db.sql, (tx) => ({ leads: postgresLeadStore(tx) }))
  const checkout = leadCheckoutOf(uow)
  const issue = issueId(7)
  expect(await checkout.of(issue, 1)).toEqual({ ok: true, value: null })

  const at = new Date('2026-03-01T12:00:00Z')
  await uow.run(async ({ leads }) => {
    await leads.tried(issue, 1, 'factory/issue_7-1', at)
    return ok(undefined)
  })
  // The attempt is known before its worktree is: the branch only.
  expect(await checkout.of(issue, 1)).toEqual({
    ok: true,
    value: { repo: null, branch: 'factory/issue_7-1', cut: null },
  })

  await uow.run(async ({ leads }) => {
    await leads.saveWorktree(issue, 1, {
      account: 'me',
      repoPath: '/roots/example',
      worktreePath: '/roots/example/.worktrees/issue_7-1',
      baseSha: 'c'.repeat(40),
    })
    return ok(undefined)
  })
  expect(await checkout.of(issue, 1)).toEqual({
    ok: true,
    value: { repo: '/roots/example', branch: 'factory/issue_7-1', cut: 'c'.repeat(40) },
  })
  expect(await checkout.of(issue, 2)).toEqual({ ok: true, value: null })
})
