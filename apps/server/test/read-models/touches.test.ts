import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { FrictionModel, KpiModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import { fileIssue, recordIssueEvent, type IssueWrites } from '../../src/app/issues.ts'
import { cancelIssue, noteIssue } from '../../src/app/issue-owner.ts'
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

describe('the orchestrator steers on its own line', () => {
  const w = { now: NOW, days: 7 }
  const countsOf = async () => {
    const friction = FrictionModel.parse(await readFriction(db.sql, w))
    const at = (key: string) => friction.counts.find((c) => c.key === key)
    return {
      touch: (kind: string) => at(`touch:${kind}`)?.count ?? 0,
      steer: (kind: string) => at(`steer:${kind}`)?.count ?? 0,
      group: at('steer:noted')?.group,
    }
  }
  const decide = async (id: string, issueId: IssueId, by: string) => {
    await db.sql`INSERT INTO factory.decisions
      (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at, answer, settled_by, answered_at, worth_asking)
      VALUES (${id}, ${`key_${id}`}, ${issueId}, 'app', 1, 'Which logger?', 'Use pino', 'checked', '[]'::jsonb,
        '{"consequence":"x","default":null,"waitMinutes":null}'::jsonb, ${new Date('2026-03-01T10:00:00Z')}, 'pino', ${by}, ${new Date('2026-03-01T11:00:00Z')}, false)`
  }

  test('an orchestrator note, cancel, reopen and answered Decision are steering and not owner touches', async () => {
    const deps = { uow, clock, ids }
    const before = await countsOf()
    const noted = await working('orchestrator note')
    value(await noteIssue(deps, { issueId: noted, text: 'carry on', actor: 'orchestrator', call: 'o1' }))
    const [event] =
      await db.sql`SELECT actor, key, payload FROM factory.issue_events WHERE issue_id = ${noted} AND kind = 'noted'`
    expect(event).toMatchObject({ actor: 'orchestrator', payload: { text: 'carry on' } })
    expect(String(event?.key)).toContain(':orchestrator:')
    const cancelled = await working('orchestrator cancel')
    value(await cancelIssue(deps, { issueId: cancelled, reason: 'not wanted', actor: 'orchestrator', call: 'o2' }))
    value(
      await recordIssueEvent(deps, {
        issueId: cancelled,
        key: key('reopened', cancelled, 'o3'),
        event: { kind: 'reopened', payload: { reason: 'wrong call' }, actor: 'orchestrator' },
      }),
    )
    const answered = await working('orchestrator answer')
    await decide('decision_orch', answered, 'orchestrator')
    await decide('decision_owner', answered, 'owner')

    const after = await countsOf()
    expect(after.group).toBe('orchestrator_steer')
    expect(after.steer('noted') - before.steer('noted')).toBe(1)
    expect(after.steer('cancelled') - before.steer('cancelled')).toBe(1)
    expect(after.steer('reopened') - before.steer('reopened')).toBe(1)
    expect(after.steer('decision_answered') - before.steer('decision_answered')).toBe(1)
    expect(after.touch('noted') - before.touch('noted')).toBe(0)
    expect(after.touch('cancelled') - before.touch('cancelled')).toBe(0)
    expect(after.touch('reopened') - before.touch('reopened')).toBe(0)
    expect(after.touch('decision_answered') - before.touch('decision_answered')).toBe(1)

    const evidence = await readFrictionEvidence(db.sql, w, ['steer:noted', 'steer:decision_answered'])
    expect(evidence['steer:noted']).toContain(noted)
    expect(evidence['steer:decision_answered']).toContain(answered)
    expect((await readFrictionEvidence(db.sql, w, ['touch:noted']))['touch:noted'] ?? []).not.toContain(noted)
  })

  test('a legacy note (the owner actor, via orchestrator) reads as steering, not as a touch', async () => {
    const before = await countsOf()
    const id = await working('legacy steer')
    value(
      await noteIssue(
        { uow, clock, ids },
        { issueId: id, text: 'old', actor: 'owner', via: 'orchestrator', call: 'l1' },
      ),
    )
    const after = await countsOf()
    expect(after.steer('noted') - before.steer('noted')).toBe(1)
    expect(after.touch('noted') - before.touch('noted')).toBe(0)
  })

  test('an owner note stays an owner touch and is not steering', async () => {
    const before = await countsOf()
    const id = await working('owner note')
    // an hour after the notes above: touches of one kind within a minute count as one action
    value(
      await noteIssue(
        { uow, clock: fixedClock('2026-03-01T13:00:00Z'), ids },
        { issueId: id, text: 'by hand', actor: 'owner', call: 'p1' },
      ),
    )
    const after = await countsOf()
    expect(after.touch('noted') - before.touch('noted')).toBe(1)
    expect(after.steer('noted') - before.steer('noted')).toBe(0)
  })
})
