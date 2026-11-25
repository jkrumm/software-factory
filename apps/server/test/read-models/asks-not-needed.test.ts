import { afterAll, beforeAll, expect, test } from 'bun:test'
import { KpiModel, RetroModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readFriction } from '../../src/read/friction.ts'
import { readFrictionEvidence } from '../../src/read/friction-evidence.ts'
import { readKpis } from '../../src/read/kpis.ts'
import { readRetro } from '../../src/read/retro.ts'

/**
 * Whether an ask needed the owner is read from his answer: a verdict of Looks good with no note and no comment, a Decision
 * answered with the recommendation. A mark he sets afterwards counts for nothing, and neither do the answers of the factory
 * and of his delegate.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-12T12:00:00Z')
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)

const artifact = async (id: string, kind: string, source: string | null) => {
  await sql`INSERT INTO factory.artifacts (id, key, issue_id, kind, title, format, author, created_at)
    VALUES (${id}, ${`key_${id}`}, 'issue_1', ${kind}, ${id}, 'markdown', 'lead', ${ago(100)})`
  await sql`INSERT INTO factory.artifact_revisions (artifact_id, n, key, blob, sha256, bytes, created_at)
    VALUES (${id}, 1, ${`rev_${id}`}, 'blob', 'sha', 1, ${ago(100)})`
  if (source)
    await sql`INSERT INTO factory.spec_paths (artifact_id, revision, outcome, by, source, at)
      VALUES (${id}, 1, 'passed', 'rule', ${source}, ${ago(99)})`
}
const verdict = (id: string, verdict: string, note: string | null, by = 'owner') =>
  sql`INSERT INTO factory.verdicts (artifact_id, revision, key, verdict, note, at, by)
    VALUES (${id}, 1, ${`verdict_${id}`}, ${verdict}, ${note}, ${ago(10)}, ${by})`
const decision = (id: string, answer: string, by: string, at: Date) =>
  sql`INSERT INTO factory.decisions
    (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at, answer, settled_by, answered_at)
    VALUES (${id}, ${`key_${id}`}, 'issue_1', 'app', 1, ${`Which logger for ${id}?`}, 'Use pino', 'checked', '[]'::jsonb,
      '{"consequence":"x","default":null,"waitMinutes":null}'::jsonb, ${ago(200)}, ${answer}, ${by}, ${at})`

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
  await sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES ('issue_1', 'app', 'working', NULL, 1)`
  await artifact('s1', 'spec', 'filer')
  await artifact('s2', 'spec', 'triage')
  await artifact('s3', 'spec', null)
  await artifact('s4', 'spec', 'filer')
  await artifact('s5', 'spec', null)
  await artifact('s6', 'spec', 'filer')
  await artifact('s7', 'spec', 'filer')
  await artifact('c1', 'concept', null)
  await artifact('r1', 'report', null)
  // changed nothing: Looks good with no word
  await verdict('s1', 'looks_good', null)
  await verdict('s2', 'looks_good', null)
  await verdict('c1', 'looks_good', null)
  // changed something: a note, a comment on the revision, Changes
  await verdict('s3', 'looks_good', 'fewer words')
  await verdict('s4', 'looks_good', null)
  await sql`INSERT INTO factory.annotations (id, key, artifact_id, revision, quote, path, comment, author, at)
    VALUES ('annotation_1', 'k1', 's4', 1, 'a quote', NULL, 'shorter', 'owner', ${ago(11)})`
  await verdict('s5', 'changes', 'drop the third choice')
  // not his: the factory's default, his delegate's verdict, a Report (no ask)
  await verdict('s6', 'looks_good', null, 'factory')
  await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
    VALUES ('event_1', 'issue_1', 'verdict_given:s6:1', 'verdict_given', '{}'::jsonb, 'factory', ${ago(10)}, 'applied', 1, 'waiting', 'working')`
  await verdict('s7', 'looks_good', null, 'orchestrator')
  await verdict('r1', 'looks_good', null)
  // Decisions: the recommendation taken, his own answer, then the Judge's, his delegate's and one before the window
  await decision('decision_1', 'Use pino', 'owner', ago(8))
  await decision('decision_2', 'Use winston, it is already in the Console', 'owner', ago(7))
  await decision('decision_3', 'Use pino', 'judge', ago(6))
  await decision('decision_4', 'Use pino', 'orchestrator', ago(5))
  await decision('decision_5', 'Use pino', 'owner', new Date(NOW.getTime() - 20 * 24 * 3_600_000))
})
afterAll(() => db.stop())

test('the KPI is the share of his own answers that changed nothing, verdicts and Decisions together', async () => {
  const model = KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))
  const kpi = model.kpis.find((k) => k.key === 'asks_not_needed')
  // six verdicts on a Concept or Spec (three changed nothing) and two Decisions (one did)
  expect(kpi).toMatchObject({ n: 8, count: 4, value: 0.5, measured: true })
  expect(Object.fromEntries(kpi?.parts.map((p) => [p.key, p.value]) ?? [])).toEqual({
    'kind:spec': 2 / 5,
    'kind:concept': 1,
    'kind:decision': 1 / 2,
    'source:filer': 1 / 2,
    'source:triage': 1,
    'source:lead': 0,
  })
  // a part that is a share of its own group says how many of how many; the Specs by kind are the sum of the sources
  const counts = Object.fromEntries(kpi?.parts.map((p) => [p.key, p.count === undefined ? null : [p.count, p.n]]) ?? [])
  expect(counts).toMatchObject({
    'kind:spec': null,
    'kind:concept': [1, 1],
    'kind:decision': [1, 2],
    'source:filer': [1, 2],
    'source:triage': [1, 1],
    'source:lead': [0, 2],
  })
})

test('friction counts the same answers by kind and by who made the ask owed, and its evidence names their Issues', async () => {
  const friction = await readFriction(sql, { now: NOW, days: 7 })
  const counts = Object.fromEntries(
    friction.counts.filter((c) => c.group === 'ask_unneeded').map((c) => [c.key, c.count]),
  )
  expect(counts).toEqual({
    'ask_unneeded:triage': 1,
    'ask_unneeded:filer': 1,
    'ask_unneeded:replan': 0,
    'ask_unneeded:lead': 0,
    'ask_unneeded:concept': 1,
    'ask_unneeded:decision': 1,
  })
  expect(
    await readFrictionEvidence(sql, { now: NOW, days: 7 }, ['ask_unneeded:decision', 'ask_unneeded:filer']),
  ).toEqual({ 'ask_unneeded:decision': ['issue_1'], 'ask_unneeded:filer': ['issue_1'] })
})

test('the retro reads the Decisions he answered in his own words', async () => {
  const model = RetroModel.parse(await readRetro(sql, { now: NOW, days: 7 }))
  expect(model.taste.decisions.map((d) => [d.decision, d.recommendation, d.answer])).toEqual([
    ['decision_2', 'Use pino', 'Use winston, it is already in the Console'],
  ])
  const redacted = RetroModel.parse(await readRetro(sql, { now: NOW, days: 7, redact: true }))
  expect(redacted.taste.decisions.every((d) => d.answer === '' && d.question === '')).toBe(true)
})
