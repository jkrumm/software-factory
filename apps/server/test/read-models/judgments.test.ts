import { afterAll, beforeAll, expect, test } from 'bun:test'
import { JudgmentsModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readCaseFile } from '../../src/read/case-file.ts'
import { readFriction } from '../../src/read/friction.ts'
import { readJudgments } from '../../src/read/judgments.ts'
import { foldAnswers, isFinding } from '../../src/kernel/judgments.ts'

/**
 * The judge ledger: each judge has two fixtures, one answer that stood and one that did not, and a third too young to say.
 * What an answer came to is read from the events that followed it, never from a column of its own.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-21T12:00:00Z')
const HOUR = 3_600_000
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * HOUR)
const days = (n: number): Date => ago(n * 24)
let keys = 0

async function issue(id: string, repo = 'app') {
  await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, ${repo}, 'working', 1)`
  await event(id, 1, 'filed', days(60), null, 'settling', {}, { title: `Title of ${id}`, repo })
}
async function event(
  issueId: string,
  version: number,
  kind: string,
  at: Date,
  from: string | null,
  to: string,
  extra: { wait?: object; actor?: string } | Record<string, never> = {},
  payload: object = {},
) {
  const { wait, actor } = extra as { wait?: object; actor?: string }
  await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state, wait)
    VALUES (${`event_${++keys}`}, ${issueId}, ${`key_${keys}`}, ${kind}, ${JSON.stringify(payload)}::text::jsonb, ${actor ?? 'factory'}, ${at},
      'applied', ${version}, ${from}, ${to}, ${wait && Object.keys(wait).length ? JSON.stringify(wait) : null}::text::jsonb)`
}

const decision = (id: string, issueId: string, at: Date) =>
  sql`INSERT INTO factory.decisions
    (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at, answer, settled_by, answered_at)
    VALUES (${id}, ${`key_${id}`}, ${issueId}, 'app', 1, ${`Which logger for ${id}?`}, 'Use pino', 'checked', '[]'::jsonb,
      '{"consequence":"x","default":null,"waitMinutes":null}'::jsonb, ${new Date(at.getTime() - HOUR)}, 'Use pino', 'judge', ${at})`

const call = (n: number, issueId: string, at: Date, action = 'wake', subject = 'wait:2') =>
  sql`INSERT INTO factory.loop_calls (key, loop, issue_id, subject, round, claimed_at, lease_until, outcome, answer, finished_at)
    VALUES (${`steward:${n}`}, 'steward', ${issueId}, ${subject}, 1, ${at}, ${at}, 'answered',
      ${JSON.stringify({ action, note: 'n', reason: 'the block cleared', decision: null })}::text::jsonb, ${at})`

const signal = (
  id: string,
  fingerprint: string,
  at: Date,
  state: string,
  extra: { dismissed?: Date; key?: string | null; issue?: string } = {},
) =>
  sql`INSERT INTO factory.intake_signals
    (id, key, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, issue_id, dismissed_reason, dismissed_by, dismissed_at)
    VALUES (${id}, ${extra.key === undefined ? `k_${id}` : extra.key}, 'outside', 'feedback', 'feedback', 'outside', 'app', ${fingerprint}, ${`Signal ${id}`}, '', ${at}, ${state},
      ${state === 'dismissed' ? null : (extra.issue ?? null)}, ${extra.dismissed ? 'noise' : null}, ${extra.dismissed ? 'judge' : null}, ${extra.dismissed ?? null})`

const errand = (id: string, summary: string, raised: Date, extra: { turned?: Date; closed?: Date } = {}) =>
  sql`INSERT INTO factory.errands
    (id, key, issue_id, attempt, summary, raised_at, done_at, done_note, closed_kind, closed_by, turned_away_at, screen_by, screen_note)
    VALUES (${id}, ${`k_${id}`}, 'issue_70', 1, ${summary}, ${raised}, ${extra.turned ?? extra.closed ?? null}, ${extra.turned || extra.closed ? 'why' : null},
      ${extra.turned ? 'turned_away' : extra.closed ? 'not_needed' : null}, ${extra.turned || extra.closed ? 'judge' : null},
      ${extra.turned ?? null}, ${extra.turned ? 'judge' : null}, ${extra.turned ? 'why' : null})`

const commits = (issueId: string, paths: string[]) =>
  sql`INSERT INTO factory.quality_evidence (id, issue_id, attempt, source_key, kind, at, payload)
    VALUES (${`ev_${++keys}`}, ${issueId}, 1, ${`ship_${keys}`}, 'commits', ${days(1)}, ${JSON.stringify({ commits: [], landedAt: null, mergedAt: null, deploys: true, paths })}::text::jsonb)`

const edge = (issueId: string, after: string, by: string) =>
  sql`INSERT INTO factory.planning_edges (issue_id, after_issue, created_at, inferred_by) VALUES (${issueId}, ${after}, ${days(5)}, ${by})`

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
  for (const n of [11, 12, 13, 21, 22, 23, 24, 31, 32, 33, 34, 35, 36, 70]) await issue(`issue_${n}`)

  // the Judge: stood (nothing followed 10 days on), overruled (he noted the Issue a day later), too young (2 days)
  await decision('decision_1', 'issue_11', days(10))
  await decision('decision_2', 'issue_12', days(10))
  await event('issue_12', 2, 'noted', new Date(days(10).getTime() + 24 * HOUR), 'working', 'working', {
    actor: 'owner',
  })
  await decision('decision_3', 'issue_13', days(2))
  for (const [id, at] of [
    ['decision_1', days(10)],
    ['decision_2', days(10)],
    ['decision_3', days(2)],
  ] as const)
    await sql`INSERT INTO factory.decision_steps (decision_id, step, outcome, detail, at) VALUES (${id}, 'judge', 'answered', 'the plan names it', ${at})`

  // the steward: moved within 30 minutes, stalled again on the same cause, did not move, too young
  for (const [n, id] of [
    [1, 'issue_21'],
    [2, 'issue_22'],
    [3, 'issue_23'],
    [4, 'issue_24'],
  ] as const) {
    const at = n === 4 ? new Date(NOW.getTime() - 5 * 60_000) : ago(5)
    await event(id, 2, 'stalled', new Date(at.getTime() - HOUR), 'working', 'waiting', { wait: { reason: 'wall' } })
    await call(n, id, at)
  }
  await event('issue_21', 3, 'lead_started', new Date(ago(5).getTime() + 10 * 60_000), 'waiting', 'working')
  await event('issue_22', 3, 'lead_started', new Date(ago(5).getTime() + 10 * 60_000), 'waiting', 'working')
  await event('issue_22', 4, 'stalled', ago(3), 'working', 'waiting', { wait: { reason: 'wall' } })

  // an idle lead (its Issue still working, so no waiting event at the subject's version): the cause is unreported, and it stalled so again
  await issue('issue_25')
  await event('issue_25', 2, 'woken', days(1), 'waiting', 'working')
  await call(5, 'issue_25', ago(5), 'wake', 'wait:2:turn1')
  await event('issue_25', 3, 'stalled', ago(3), 'working', 'waiting', { wait: { reason: 'unreported' } })

  // triage amends: stood, and one whose words came back as an Issue of their own
  await signal('signal_t1', 'fp-t1', days(20), 'amended', { key: null, issue: 'issue_31' })
  await signal('signal_t2', 'fp-t2', days(20), 'amended', { key: null, issue: 'issue_32' })
  await signal('signal_t2b', 'fp-t2', days(10), 'filed', { issue: 'issue_33' })
  // triage and queue edges: needed (a file in common), not needed (none)
  await commits('issue_31', ['src/a.ts'])
  await commits('issue_32', ['src/a.ts', 'docs/plan.yaml'])
  await commits('issue_33', ['src/b.ts', 'docs/plan.yaml'])
  await commits('issue_34', ['src/c.ts'])
  await edge('issue_32', 'issue_31', 'triage: same file')
  await edge('issue_33', 'issue_32', 'triage: guess')
  await edge('issue_35', 'issue_34', 'queue: same file')
  await commits('issue_35', ['src/c.ts'])
  await edge('issue_36', 'issue_35', 'queue: guess')
  await commits('issue_36', ['src/z.ts'])
  // an edge the queue loop took back: both Issues shipped a file in common, and it was still wrong
  await sql`INSERT INTO factory.queue_edge_removals (issue_id, after_issue, inferred_by, added_at, removed_at, kind, reason)
    VALUES ('issue_35', 'issue_34', 'queue: again', ${days(5)}, ${days(4)}, 'disjoint', 'no path in common')`
  // the same pair taken back later because the blocker waited on the owner: it says nothing of the edge, which both Issues' files show was needed
  await sql`INSERT INTO factory.queue_edge_removals (issue_id, after_issue, inferred_by, added_at, removed_at, kind, reason)
    VALUES ('issue_35', 'issue_34', 'queue: again', ${days(5)}, ${days(3)}, 'owner_wait', 'waited 9 h')`
  // the calls whose edges those are
  await sql`INSERT INTO factory.loop_calls (key, loop, issue_id, subject, round, claimed_at, lease_until, outcome, answer, finished_at)
    VALUES ('triage:1', 'triage', 'issue_32', 'settle', 1, ${days(5)}, ${days(5)}, 'answered', '{}'::jsonb, ${days(5)}),
      ('triage:2', 'triage', 'issue_33', 'settle', 1, ${days(5)}, ${days(5)}, 'answered', '{}'::jsonb, ${days(5)})`
  await sql`INSERT INTO factory.loop_calls (key, loop, repo, subject, round, claimed_at, lease_until, outcome, answer, finished_at)
    VALUES ('queue:app:1', 'queue', 'app', 'shape', 1, ${days(5)}, ${days(5)}, 'answered', '{}'::jsonb, ${days(5)})`

  // the screen: dismissed and gone, dismissed and filed 5 days later, dismissed 3 days ago
  await signal('signal_s1', 'fp-s1', days(21), 'dismissed', { dismissed: days(20) })
  await signal('signal_s2', 'fp-s2', days(21), 'dismissed', { dismissed: days(20) })
  await signal('signal_s2b', 'fp-s2', days(15), 'filed', { issue: 'issue_34' })
  await signal('signal_s3', 'fp-s3', days(4), 'dismissed', { dismissed: days(3) })
  await sql`UPDATE factory.intake_signals SET screened_at = dismissed_at WHERE dismissed_by = 'judge'`

  // the Errand screen: turned away and never again, and the same ask raised 4 days later; then the not-needed check
  await errand('errand_1', 'Approve the log retention', days(25), { turned: days(20) })
  await errand('errand_2', 'Sign in to the portal', days(25), { turned: days(20) })
  await errand('errand_2b', 'Sign in to the portal', days(16))
  await errand('errand_3', 'Rotate the deploy key', days(25), { closed: days(20) })
  await errand('errand_4', 'Renew the certificate', days(25), { closed: days(20) })
  await errand('errand_4b', 'Renew the certificate', days(10))
})
afterAll(() => db.stop())

const model = async () => JudgmentsModel.parse(await readJudgments(sql, { now: NOW, days: 60 }))
const ledger = async (judge: string) => {
  const found = (await model()).judges.find((j) => j.judge === judge)
  if (!found) throw new Error(`no ledger for ${judge}`)
  return found
}

test('the Judge: an answer the owner noted within 7 days did not stand; one nothing followed did', async () => {
  const judge = await ledger('judge')
  expect(judge).toMatchObject({ answers: 3, stood: 1, didNotStand: 1, unknown: 1, share: 0.5 })
  expect(judge.newest.map((a) => [a.issue, a.outcome])).toEqual([['issue_12', 'overruled']])
})

test('the steward: moved within 30 minutes stood; stalled again on the same cause or did not move did not', async () => {
  const steward = await ledger('steward')
  expect(steward).toMatchObject({ answers: 5, stood: 1, didNotStand: 3, unknown: 1 })
  expect(steward.share).toBeCloseTo(3 / 4)
  expect(Object.fromEntries(steward.newest.map((a) => [a.issue, a.outcome]))).toEqual({
    issue_22: 'raised_again',
    issue_23: 'overruled',
    issue_25: 'raised_again',
  })
})

test('triage: an amend whose words came back as their own Issue, and an edge touching no common file, did not stand', async () => {
  const triage = await ledger('triage')
  // two amends (one came back); two edges (the plan file and the lockfiles do not count as a file in common)
  expect(triage).toMatchObject({ answers: 4, stood: 2, didNotStand: 2, unknown: 0 })
  expect(triage.newest.map((a) => a.outcome).toSorted()).toEqual(['overruled', 'raised_again'])
})

test('the queue loop: an edge needed stood, one touching no common file did not', async () => {
  const queue = await ledger('queue')
  // needed, touching no common file, taken back as disjoint though both shipped a file in common, and taken back for the owner's wait (stood)
  expect(queue).toMatchObject({ answers: 4, stood: 2, didNotStand: 2 })
  expect(queue.newest.map((a) => a.answer).toSorted()).toEqual([
    'edge added by queue',
    'edge added by queue, taken back (disjoint)',
  ])
})

test('the screen: a dismissed signal that came back as work did not stand', async () => {
  const screen = await ledger('screen')
  expect(screen).toMatchObject({ answers: 3, stood: 1, didNotStand: 1, unknown: 1, share: 0.5 })
  expect(screen.newest[0]?.subject).toBe('Signal signal_s2')
})

test('the Errand screen and the not-needed check: a need raised again did not stand', async () => {
  const turned = await ledger('errand')
  expect(turned).toMatchObject({ answers: 2, stood: 1, didNotStand: 1 })
  expect(turned.newest[0]).toMatchObject({ subject: 'Sign in to the portal', outcome: 'raised_again' })
  const needed = await ledger('errandNeeded')
  expect(needed).toMatchObject({ answers: 2, stood: 1, didNotStand: 1 })
  expect(needed.newest[0]).toMatchObject({ subject: 'Renew the certificate', outcome: 'raised_again' })
})

test('a judge with no answers has no share, and the window cuts at the counting epoch', async () => {
  const cut = JudgmentsModel.parse(await readJudgments(sql, { now: NOW, days: 60, epoch: days(5) }))
  expect(cut.since).toBe(days(5).toISOString())
  expect(cut.judges.find((j) => j.judge === 'judge')).toMatchObject({ answers: 1, share: null })
  const none = JudgmentsModel.parse(await readJudgments(sql, { now: NOW, days: 1 }))
  expect(none.judges.every((j) => j.share === null || j.answers > 0)).toBe(true)
})

test('a judge is a finding from ten decided answers with a share over 0.2', () => {
  const answer = (outcome: 'stood' | 'overruled') => ({
    at: NOW.toISOString(),
    issue: null,
    subject: 's',
    answer: 'a',
    outcome,
  })
  const many = (stood: number, failed: number) =>
    foldAnswers('judge', [...Array(stood).fill(answer('stood')), ...Array(failed).fill(answer('overruled'))])
  expect(isFinding(many(7, 3))).toBe(true)
  expect(isFinding(many(8, 2))).toBe(false) // 0.2 is not over 0.2
  expect(isFinding(many(4, 3))).toBe(false) // seven decided answers are too few
})

test("the case file's precedents carry what became of each earlier answer", async () => {
  const outcomes = async (judge: 'judge' | 'steward' | 'triage' | 'queue' | 'screen' | 'errand' | 'errandNeeded') =>
    ((await readCaseFile(sql, { judge, repo: 'app' }, 10_000, NOW)).case.precedents ?? []).map((p) => p.outcome)
  expect((await outcomes('triage')).toSorted()).toEqual(['overruled', 'stood'])
  expect(await outcomes('queue')).toEqual(['overruled'])
  expect((await outcomes('judge')).toSorted()).toEqual(['overruled', 'stood', 'unknown'])
  expect((await outcomes('steward')).toSorted()).toEqual([
    'overruled',
    'raised_again',
    'raised_again',
    'stood',
    'unknown',
  ])
  expect((await outcomes('screen')).toSorted()).toEqual(['raised_again', 'stood', 'unknown'])
  expect((await outcomes('errand')).toSorted()).toEqual(['raised_again', 'stood'])
  expect((await outcomes('errandNeeded')).toSorted()).toEqual(['raised_again', 'stood'])
})

test('the friction read is untouched by the ledger', async () => {
  expect((await readFriction(sql, { now: NOW, days: 7 })).counts.length).toBeGreaterThan(0)
})
