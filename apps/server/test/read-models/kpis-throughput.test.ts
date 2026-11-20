import { afterAll, beforeAll, expect, test } from 'bun:test'
import { KPI_CATALOG, KpiModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readKpis } from '../../src/read/kpis.ts'
import { FINDING_PREFIX } from '../../src/domains/intake/rules.ts'

/** The recommendation taken beside the owner's touches, and the catalog fields every KPI carries. */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-17T12:00:00Z')
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())

  // three Decisions the owner answered (the floor of a share is three): two with the recommended option (in other case and with spaces), one with the other
  await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES ('issue_5', 'app', 'working', 1)`
  for (const [id, answer] of [
    ['decision_1', ' PINO '],
    ['decision_2', 'winston'],
    ['decision_3', 'Pino'],
  ] as const)
    await sql`INSERT INTO factory.decisions
      (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at, answer, settled_by, answered_at)
      VALUES (${id}, ${`key_${id}`}, 'issue_5', 'app', 1, 'Which logger?', 'pino', 'checked', '[]'::jsonb,
        '{"consequence":"x","default":null,"waitMinutes":null}'::jsonb, ${ago(6)}, ${answer}, 'owner', ${ago(2)})`
})
afterAll(() => db.stop())

const read = async () => KpiModel.parse(await readKpis(sql, { now: NOW, days: 7 }))

test('the recommendation taken is the answers that name the recommended option, ignoring case and spaces, beside avoidable touches', async () => {
  const touches = (await read()).kpis.find((k) => k.key === 'avoidable_touches')
  const taken = touches?.beside.find((p) => p.key === 'recommendation_taken')
  expect(taken).toMatchObject({ unit: 'share' })
  expect(taken?.value).toBeCloseTo(2 / 3, 6)
  // the three answers are touches of the owner too; with no Issue filed in the window there is no rate, so no parts
  expect(touches).toMatchObject({ count: 3, n: 0, value: null, measured: false, parts: [] })
})

test('an Issue a loop filed (its intake subject a finding key) is left out of the touch rate and counted beside it', async () => {
  for (const id of ['issue_20', 'issue_21']) {
    await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${id}, 'app', 'queued', 1)`
    await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
      VALUES (${`event_filed_${id}`}, ${id}, ${`filed:${id}`}, 'filed', '{}'::jsonb, 'factory', ${ago(3)}, 'applied', 1, 'settling')`
  }
  // issue_21 is the weekly retro: the friction loop filed it through intake with its finding
  await sql`INSERT INTO factory.intake_subjects (source, subject, issue_id, filed_at, last_seen)
    VALUES ('agent:software-factory', 'finding:friction:retro:software-factory:retro', 'issue_21', ${ago(3)}, ${ago(3)})`
  // the read matches the prefix as a literal (read/ imports no domain code): it must be the one intake writes
  expect(FINDING_PREFIX).toBe('finding:')
  const touches = (await read()).kpis.find((k) => k.key === 'avoidable_touches')
  expect(touches).toMatchObject({ n: 1, count: 3 })
  expect(touches?.beside.find((p) => p.key === 'loop_filed')?.value).toBe(1)
})

test('every KPI carries its label, direction, target and target source from the catalog, and nothing the screen does not show', async () => {
  for (const k of (await read()).kpis) {
    expect(k).toMatchObject({
      label: KPI_CATALOG[k.key].label,
      direction: KPI_CATALOG[k.key].direction,
      target: KPI_CATALOG[k.key].target,
      targetSource: KPI_CATALOG[k.key].targetSource,
    })
    expect(Object.keys(k)).not.toContain('decision')
    expect(Object.keys(k)).not.toContain('numerator')
    // a target is never a band, so a value better than it is never off it
    expect(['at_most', 'at_least', 'trend'], k.key).toContain(k.target.kind)
  }
})
