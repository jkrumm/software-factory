import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { FrictionModel, KpiModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import { fileIssue, recordIssueEvent, type IssueWrites } from '../../src/app/issues.ts'
import { noteIssue } from '../../src/app/issue-owner.ts'
import { PAYLOADS } from '../../src/domains/work/events.ts'
import { replay } from '../../src/domains/work/machine.ts'
import { fixedClock } from '../../src/kernel/clock.ts'
import { type IssueId, sequentialIds } from '../../src/kernel/ids.ts'
import { ok } from '../../src/kernel/result.ts'
import { key } from '../../src/kernel/keys.ts'
import { readFriction } from '../../src/read/friction.ts'
import { readFrictionEvidence } from '../../src/read/friction-evidence.ts'
import { readKpis } from '../../src/read/kpis.ts'

/** Which `noted` events are owner touches: only a note the owner sent with `issue note`, and not the orchestrator's. */
let db: TestCluster
let uow: IssueWrites
const clock = fixedClock('2026-03-01T12:00:00Z')
const ids = sequentialIds()
const NOW = new Date('2026-03-02T12:00:00Z')

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
  uow = postgresUnitOfWork(db.sql, (tx) => ({ work: postgresWorkStore(tx) }))
})
afterAll(() => db.stop())

const value = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

async function working(title: string): Promise<IssueId> {
  const deps = { uow, clock, ids }
  const { issue } = value(
    await fileIssue(deps, {
      key: key('request', ids.next('request')),
      event: { kind: 'filed', payload: { repo: 'example', title, kind: 'feature', origin: 'you' }, actor: 'owner' },
    }),
  )
  for (const kind of ['settled', 'admitted'] as const) {
    value(
      await recordIssueEvent(deps, {
        issueId: issue.id,
        key: key(issue.id, kind),
        event: { kind, payload: {}, actor: 'factory' },
      }),
    )
  }
  return issue.id
}

describe('owner touches by note', () => {
  test('only a plain `issue note` counts; the KPI, the count and the drill-down agree', async () => {
    const deps = { uow, clock, ids }
    const note = async (issueId: IssueId, name: string, text: string, actor: 'owner' | 'factory') =>
      value(
        await recordIssueEvent(deps, {
          issueId,
          key: key(...name.split('|')),
          event: { kind: 'noted', payload: { text }, actor },
        }),
      )

    const filedWithText = await working('filed with text')
    await note(filedWithText, 'request|request_1|note', 'the request', 'owner')
    const errand = await working('errand done')
    await note(errand, 'noted|errand|errand_1', 'The owner did the Errand', 'owner')
    const steered = await working('steered')
    value(
      await noteIssue(deps, { issueId: steered, text: 'carry on', actor: 'owner', via: 'orchestrator', call: 'c1' }),
    )
    const plain = await working('plain note')
    value(await noteIssue(deps, { issueId: plain, text: 'please use X', actor: 'owner', call: 'c2' }))
    const planRow = await working('plan row')
    await note(planRow, 'noted|plan|row', 'facts', 'factory')

    const [stored] =
      await db.sql`SELECT payload FROM factory.issue_events WHERE issue_id = ${steered} AND kind = 'noted'`
    expect(stored).toMatchObject({ payload: { via: 'orchestrator' } })

    const w = { now: NOW, days: 7 }
    const friction = FrictionModel.parse(await readFriction(db.sql, w))
    expect(friction.counts.find((c) => c.key === 'touch:noted')?.count).toBe(1)
    const kpis = KpiModel.parse(await readKpis(db.sql, w))
    expect(kpis.kpis.find((k) => k.key === 'avoidable_touches')?.count).toBe(1)
    expect(await readFrictionEvidence(db.sql, w, ['touch:noted'])).toEqual({ 'touch:noted': [plain] })
  })

  test('a note stored without `via` (the old shape) still parses and replays', async () => {
    expect(PAYLOADS.noted.safeParse({ text: 'old' }).success).toBe(true)
    expect(PAYLOADS.noted.safeParse({ text: 'x', via: 'someone' }).success).toBe(false)
    const id = await working('old shape')
    value(await noteIssue({ uow, clock, ids }, { issueId: id, text: 'plain', actor: 'owner', call: 'c3' }))
    const history = await uow.run(async ({ work }) => ok(await work.history(id)))
    const records = value(history) ?? []
    expect(records.at(-1)?.payload).toEqual({ text: 'plain' })
    expect(replay(id, records).version).toBe(records.length)
  })
})
