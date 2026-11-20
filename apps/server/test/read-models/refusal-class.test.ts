import { afterAll, beforeAll, expect, test } from 'bun:test'
import { FrictionModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { annotationsOwed } from '../../src/app/quality-ship.ts'
import { patternsOver } from '../../src/domains/loops/friction.ts'
import { alertStillDown, ciStillRed, notDeployed } from '../../src/domains/quality/watch.ts'
import { refusalClass } from '../../src/read/refusal-class.ts'
import { readFriction } from '../../src/read/friction.ts'
import { readFrictionEvidence } from '../../src/read/friction-evidence.ts'

const HEX_RUN = /[0-9a-f]{7,}/i

/** The refusal texts of the week to 2026-11-20, as the gate, the git adapter and the work table wrote them. */
const sha = (n: number) => `${n.toString(16).padStart(12, 'a')}beef0123456789`.slice(0, 12)
const WEEK: { detail: string; class: string }[] = [
  ...Array.from({ length: 50 }, (_, i) => ({
    detail: `ship refused: commit ${sha(i + 1)} is not on origin/${i % 9 === 0 ? 'main' : 'master'}: merge it first`,
    class: 'commit_not_on_base',
  })),
  ...Array.from({ length: 12 }, (_, i) => ({
    detail: `ship refused: commit ${sha(i + 70)} is older than this attempt`,
    class: 'commit_older_than_cut',
  })),
  ...Array.from({ length: 8 }, (_, i) => ({
    detail: `ship refused: deployed ${sha(i + 100)} does not hold ${sha(i + 200)}, where the work landed. Deploy first (\`make deploy\`, inside \`factory deploy-lock --project app -- make deploy\` where leads share the deploy), then ship again with the same commits`,
    class: 'deployed_lacks_commit',
  })),
  {
    detail:
      'ship refused: commit ac1670d94fabcdef0123456789abcdef01234567 is not in /srv/work/basalt-ui: push it first',
    class: 'commit_not_pushed',
  },
  {
    detail: 'ship refused: factory/1239-1 holds work that is not on origin/main: merge it first',
    class: 'branch_not_on_base',
  },
  {
    detail: 'ship refused: factory/1181-1 holds work that is not on origin/master: merge it first',
    class: 'branch_not_on_base',
  },
  { detail: 'ship refused: ship names no merged commit', class: 'no_commit_named' },
  { detail: 'ship refused, review missing: review v4 at the tier agw review route', class: 'review_gate_retired' },
  {
    detail: "it waits for an Errand (errand_01j9abcdef: errand done by the owner's hands), so `ship` is not taken now",
    class: 'waits_for_errand',
  },
  {
    detail: "it waits for an Errand (errand_02k8abcdef: errand done by the owner's hands), so `defer` is not taken now",
    class: 'waits_for_errand',
  },
  {
    detail:
      'it waits for the answer to a Decision (decision_01j9abc: answered by the Judge), so `ship` is not taken now',
    class: 'waits_for_decision',
  },
  {
    detail:
      'it waits for the verdict on an artifact (artifact_01j9abc: verdict given on the page), so `ship` is not taken now',
    class: 'waits_for_verdict',
  },
  {
    detail:
      'it waits (regressed: woken by the steward, or turned into a Decision); `ship` is taken only from a timed wait',
    class: 'waits_stalled',
  },
  { detail: 'it is closed: reopen it first', class: 'closed' },
  { detail: 'it shipped: the watch is on, and verify ends it', class: 'watch_is_on' },
  { detail: 'a decision wait ends with its answer, not a wake', class: 'wake_of_answer_wait' },
  { detail: 'a errand wait ends with its answer, not a wake', class: 'wake_of_answer_wait' },
  {
    detail: 'it is already waiting for issue_12, issue_13: it resumes by itself when they close, so end the turn',
    class: 'waits_for_dependency',
  },
]

test('every refusal text of the week has the class its producer means', () => {
  for (const row of WEEK) expect(refusalClass(row.detail).id, row.detail).toBe(row.class)
})

test('the texts the producers export keep their class', () => {
  expect(
    refusalClass(notDeployed('deployed 6d29bc382201 does not hold e3b8d5ceb6d8, where the work landed', 'app')).id,
  ).toBe('deployed_lacks_commit')
  expect(refusalClass(alertStillDown(['api down'])).id).toBe('alert_still_down')
  expect(
    refusalClass(String(ciStillRed({ status: 'red', reason: 'tests', url: null } as never, 'abcdef0123456'))).id,
  ).toBe('ci_still_red')
  const owed = annotationsOwed([{ id: 'annotation_1', artifact: 'artifact_1', revision: 1, quote: 'why' }])
  expect(refusalClass(owed).id).toBe('annotations_undisposed')
  expect(refusalClass(annotationsOwed([{ id: 'a', artifact: 'b', revision: 2, quote: 'x' }], 'close')).id).toBe(
    'annotations_undisposed',
  )
})

test('a text no rule knows is a class by its wording, never by the shas, paths and numbers it names', () => {
  const a = refusalClass('something new about commit 0123456789abcdef in /srv/x/y after 12 tries')
  const b = refusalClass('something new about commit fedcba98765432 in /srv/z/w after 7 tries')
  expect(a.id).toBe(b.id)
  expect(a.id).not.toMatch(HEX_RUN)
  expect(refusalClass(null).id).toBe('no_reason_given')
})

let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-20T12:00:00Z')
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
})
afterAll(() => db.stop())

test("friction sums a week's refusals by class: one line each, no sha in a key", async () => {
  await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES ('issue_1', 'app', 'queued', 1)`
  // the gate's refusals and the table's both reach a ship; the events are the table's alone
  const ships = WEEK.filter(
    (row) => !['wake_of_answer_wait', 'review_gate_retired', 'waits_for_dependency'].includes(row.class),
  )
  const events = WEEK.filter(
    (row) => !row.class.startsWith('commit_') && !row.class.endsWith('_base') && row.class !== 'deployed_lacks_commit',
  )
  let n = 0
  for (const row of ships) {
    n += 1
    await sql`INSERT INTO factory.quality_ships (id, issue_id, attempt, event_key, at, result, detail, reported)
      VALUES (${`ship_${n}`}, 'issue_1', 1, ${`ship_key_${n}`}, ${ago(5)}, 'refused', ${row.detail}, '[]'::jsonb)`
  }
  for (const row of events) {
    n += 1
    await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, detail)
      VALUES (${`event_${n}`}, 'issue_1', ${`key_${n}`}, ${n % 2 ? 'shipped' : 'closed'}, '{}'::jsonb, 'lead', ${ago(5)}, 'refused', ${row.detail})`
  }
  const model = FrictionModel.parse(await readFriction(sql, { now: NOW, days: 7 }))
  const lines = model.counts.filter((c) => c.group === 'refusal')
  for (const line of lines) expect(line.key, line.key).not.toMatch(HEX_RUN)
  const shipLines = lines.filter((c) => c.key.startsWith('ship_refused:'))
  expect(shipLines.length).toBeLessThanOrEqual(15)

  const ship = (id: string) => lines.find((c) => c.key === `ship_refused:${id}`)?.count
  expect(ship('commit_not_on_base')).toBe(50)
  expect(ship('commit_older_than_cut')).toBe(12)
  expect(ship('deployed_lacks_commit')).toBe(8)
  expect(ship('total')).toBe(ships.length)
  expect(lines.find((c) => c.key === 'refusal:waits_for_errand')?.count).toBe(2)
  expect(lines.find((c) => c.key === 'refusal:total')?.count).toBe(events.length)

  const refs = await readFrictionEvidence(sql, { now: NOW, days: 7 }, [
    'ship_refused:commit_not_on_base',
    'refusal:closed',
  ])
  expect(refs['ship_refused:commit_not_on_base']).toEqual(['issue_1'])
  expect(refs['refusal:closed']).toEqual(['issue_1'])
})

test('60 ship refusals of one class among 1,000 closed Issues is a finding', () => {
  const counts = [
    {
      key: 'ship_refused:commit_not_on_base',
      group: 'refusal' as const,
      label: 'A ship was refused: a commit is not on the default branch',
      count: 60,
      perIssue: 0.06,
      previous: null,
    },
  ]
  expect(patternsOver(counts, 1000).map((p) => p.key)).toEqual(['ship_refused:commit_not_on_base'])
})
