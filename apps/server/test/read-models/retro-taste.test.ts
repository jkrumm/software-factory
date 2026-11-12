import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RetroModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { retroText } from '../../src/domains/loops/retro.ts'
import { readRetro } from '../../src/read/retro.ts'

/** The retro's taste: the owner's own verdict notes and annotations, never the factory's defaults, and the share of verdicts that asked for more. */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-12T12:00:00Z')
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000)

let n = 0
const artifact = async (id: string, issue: string, kind: string, title: string) => {
  await sql`INSERT INTO factory.artifacts (id, key, issue_id, kind, title, format, author, created_at)
    VALUES (${id}, ${`key_${id}`}, ${issue}, ${kind}, ${title}, 'markdown', 'lead', ${ago(100)})`
  await sql`INSERT INTO factory.artifact_revisions (artifact_id, n, key, blob, sha256, bytes, created_at)
    VALUES (${id}, 1, ${`rev_${id}`}, 'blob', 'sha', 1, ${ago(100)})`
}
const verdict = async (id: string, verdict: string, note: string | null, at: Date, by: 'owner' | 'factory') => {
  await sql`INSERT INTO factory.verdicts (artifact_id, revision, key, verdict, note, at) VALUES (${id}, 1, ${`verdict_${id}`}, ${verdict}, ${note}, ${at})`
  // the event is recorded while the Issue waits for the review; a verdict nobody saw wait has none
  await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state)
    VALUES (${`event_${++n}`}, 'issue_1', ${`verdict_given:${id}:1`}, 'verdict_given', '{}'::jsonb, ${by}, ${at}, 'applied', ${n}, 'waiting', 'working')`
}

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
  await sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES ('issue_1', 'app', 'working', NULL, 1)`
  for (const [id, kind, title] of [
    ['artifact_a', 'spec', 'Spec A'],
    ['artifact_b', 'spec', 'Spec B'],
    ['artifact_c', 'concept', 'Concept C'],
    ['artifact_d', 'spec', 'Spec D'],
    ['artifact_e', 'spec', 'Spec E'],
  ] as const)
    await artifact(id, 'issue_1', kind, title)
  await verdict('artifact_a', 'with_notes', 'fewer words in the title', ago(30), 'owner')
  await verdict('artifact_b', 'changes', 'drop the third choice', ago(20), 'owner')
  await verdict('artifact_c', 'looks_good', null, ago(10), 'owner')
  await verdict('artifact_d', 'looks_good', 'no verdict in 24 hours: go on', ago(5), 'factory')
  await verdict(
    'artifact_e',
    'with_notes',
    'older than the window',
    new Date(NOW.getTime() - 20 * 24 * 3_600_000),
    'owner',
  )
  await sql`INSERT INTO factory.annotations (id, key, artifact_id, revision, quote, path, comment, author, at)
    VALUES ('annotation_1', 'k1', 'artifact_a', 1, 'a long sentence', NULL, 'shorter', 'owner', ${ago(29)}),
           ('annotation_2', 'k2', 'artifact_a', 1, 'another', NULL, 'the lead wrote this', 'lead', ${ago(28)})`
})
afterAll(() => db.stop())

describe('the retro bundle carries the owner’s taste', () => {
  test('his own verdict notes and annotations of the window, with artifact, repo and Issue', async () => {
    const model = RetroModel.parse(await readRetro(sql, { now: NOW, days: 7 }))
    expect(model.taste.verdicts.map((v) => [v.artifact, v.verdict, v.note, v.repo, v.issue])).toEqual([
      ['artifact_b', 'changes', 'drop the third choice', 'app', 'issue_1'],
      ['artifact_a', 'with_notes', 'fewer words in the title', 'app', 'issue_1'],
    ])
    expect(model.taste.annotations.map((a) => [a.artifact, a.quote, a.comment, a.repo, a.issue])).toEqual([
      ['artifact_a', 'a long sentence', 'shorter', 'app', 'issue_1'],
    ])
  })

  test('verdict_changes_share is the owner’s with_notes and changes over all his verdicts, the factory’s default not counted', async () => {
    const model = RetroModel.parse(await readRetro(sql, { now: NOW, days: 7 }))
    const share = model.kpis.kpis.find((k) => k.key === 'verdict_changes_share')
    expect(share).toMatchObject({ n: 3, count: 2 })
    expect(share?.value).toBeCloseTo(2 / 3, 9)
  })

  test('the read token gets the shape without the words', async () => {
    const model = RetroModel.parse(await readRetro(sql, { now: NOW, days: 7, redact: true }))
    expect(model.taste.verdicts).toHaveLength(2)
    expect(model.taste.verdicts.every((v) => v.note === null && v.title === '')).toBe(true)
    expect(model.taste.annotations.every((a) => a.comment === '' && a.quote === '')).toBe(true)
  })
})

describe('the retro text', () => {
  test('part 2d groups the taste into preferences and files the recurring ones with the verdict KPI', () => {
    const text = retroText({ to: NOW.toISOString(), days: 7 })
    expect(text).toContain('2d. The owner')
    expect(text).toContain('taste.verdicts')
    expect(text).toContain('seen twice or more')
    expect(text).toContain('kpi=verdict_changes_share')
    expect(text).toContain('direction=down')
  })
})
