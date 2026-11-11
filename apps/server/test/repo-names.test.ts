import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { FlowModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../src/adapters/postgres/migrate.ts'
import { repoNameOf } from '../src/domains/planning/sync.ts'
import { readFlow } from '../src/read/flow.ts'

let db: TestCluster
beforeAll(async () => {
  db = await startTestCluster()
})
afterAll(() => db.stop())

describe('the name of a repo text', () => {
  test('a name stays, a path and a worktree path are their main checkout directory name', () => {
    expect(repoNameOf('software-factory')).toBe('software-factory')
    expect(repoNameOf('/Users/x/SourceRoot/software-factory')).toBe('software-factory')
    expect(repoNameOf('/Users/x/SourceRoot/software-factory/')).toBe('software-factory')
    expect(repoNameOf('/Users/x/SourceRoot/software-factory/.claude/worktrees/factory-757-1')).toBe('software-factory')
    expect(repoNameOf('/')).toBe('/')
  })
})

describe('the migration that rewrites stored paths to names', () => {
  test('every stored repo path becomes its project name, so Flow counts one project once', async () => {
    const NOW = new Date('2026-11-11T12:00:00Z')
    const all = await loadMigrations()
    const before = all.filter((m) => m.name < '1012')
    expect(all.map((m) => m.name)).toContain('1012_repo_names.sql')
    await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
    await migrate(db.sql, before)

    const main = '/Users/x/SourceRoot/software-factory'
    const filed = async (id: string, n: number, repo: string) => {
      await db.sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, ${repo}, 'queued', 1)`
      await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
        VALUES (${`event_${n}`}, ${id}, ${`key_${n}`}, 'filed',
          ${JSON.stringify({ repo, title: `t${n}`, kind: 'feature', origin: 'you' })}::text::jsonb, 'owner', ${NOW}, 'applied', 1, 'settling')`
    }
    await filed('issue_1', 1, 'software-factory')
    await filed('issue_2', 2, main)
    await filed('issue_3', 3, `${main}/.claude/worktrees/factory-3-1`)
    await db.sql`INSERT INTO factory.capacity_claims (issue_id, repo, urgent, taken_at) VALUES ('issue_2', ${main}, false, ${NOW})`
    await db.sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state)
      VALUES ('signal_1', 'agent:x', 'request', 'factory', 'agent', ${main}, 'fp', 't', '', ${NOW}, 'held')`
    await db.sql`INSERT INTO factory.intake_door_routes (source, monitor, repo) VALUES ('kuma', 'm', ${main})`

    expect(await migrate(db.sql, all)).toEqual(['1012_repo_names.sql'])

    for (const table of ['issues', 'capacity_claims', 'intake_signals', 'intake_door_routes']) {
      const rows = await db.sql.unsafe(`SELECT repo FROM factory.${table} WHERE repo LIKE '/%'`)
      expect(rows).toHaveLength(0)
    }
    const events = await db.sql`SELECT payload->>'repo' AS repo FROM factory.issue_events ORDER BY id`
    expect(events.map((e: { repo: string }) => e.repo)).toEqual(Array(3).fill('software-factory'))

    const flow = FlowModel.parse(await readFlow(db.sql, { now: NOW }))
    expect(flow.perProject).toEqual([{ repo: 'software-factory', open: 3, working: 0, queued: 3 }])
  })
})
