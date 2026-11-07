import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { compareLegacy, importLegacy } from '../../scripts/import/run.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'

let db: TestCluster
let dataDir = ''

beforeAll(async () => {
  db = await startTestCluster()
  dataDir = await mkdtemp('/tmp/factory-import-')
})

afterAll(async () => {
  await db.stop()
  await rm(dataDir, { recursive: true, force: true })
})

/** The old core's tables the importer reads, with the columns it reads and the ones its queries name. */
const LEGACY = `
  CREATE SCHEMA factory_legacy;
  CREATE TABLE factory_legacy.issues (
    id integer PRIMARY KEY, state text NOT NULL, source text NOT NULL, source_key text NOT NULL, repo text NOT NULL,
    title text NOT NULL, facts jsonb NOT NULL DEFAULT '{}', kind text, reason text, outcome text, attempt integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL, closed_at timestamptz);
  CREATE TABLE factory_legacy.issue_events (
    id bigint PRIMARY KEY, issue_id integer NOT NULL, kind text NOT NULL, from_state text, to_state text,
    at timestamptz NOT NULL, payload jsonb);
  CREATE TABLE factory_legacy.decisions (
    id bigint PRIMARY KEY, issue_id integer NOT NULL, question text NOT NULL, options jsonb, default_option text,
    expires_at timestamptz, answer text, answered_by text, answered_at timestamptz, created_at timestamptz NOT NULL);
  CREATE TABLE factory_legacy.issue_deps (issue_id integer NOT NULL, on_issue integer NOT NULL);
  CREATE TABLE factory_legacy.door_routes (source text, monitor text, repo text, quiet integer DEFAULT 0, last_quiet_at timestamptz, last_event text);
  CREATE TABLE factory_legacy.door_sources (source text, first_seen timestamptz, last_accepted timestamptz, refused integer DEFAULT 0, refused_since timestamptz, last_refused timestamptz);
  CREATE TABLE factory_legacy.door_unrouted (source text, monitor text, count integer, last_seen timestamptz, last_title text, last_event text, status text, down_since timestamptz, is_group boolean DEFAULT false, filed_at timestamptz, filed_issue integer);
  CREATE TABLE factory_legacy.door_issues (issue_id integer, source text, monitor text, fingerprint text, repeats integer DEFAULT 0, last_seen timestamptz);
  CREATE TABLE factory_legacy.intake_seen (key text, seen_at timestamptz);
`

const at = (minutes: number): string => new Date(Date.parse('2026-11-01T10:00:00Z') + minutes * 60_000).toISOString()

let eventId = 0
async function legacyIssue(
  id: number,
  fields: { state: string; reason?: string; outcome?: string; attempt?: number; source?: string; sourceKey?: string },
  events: { kind: string; from?: string; to?: string; minutes: number; payload?: unknown }[],
): Promise<void> {
  await db.sql.unsafe(
    `INSERT INTO factory_legacy.issues (id, state, source, source_key, repo, title, kind, reason, outcome, attempt, created_at, closed_at)
     VALUES ($1, $2, $3, $4, '/Users/example/SourceRoot/example', $5, 'bug', $6, $7, $8, $9, $10)`,
    [
      id,
      fields.state,
      fields.source ?? 'request',
      fields.sourceKey ?? `request:${id}`,
      `Issue ${id}`,
      fields.reason ?? null,
      fields.outcome ?? null,
      fields.attempt ?? 0,
      at(0),
      fields.state === 'closed' ? at(90) : null,
    ],
  )
  for (const e of events) {
    await db.sql.unsafe(
      'INSERT INTO factory_legacy.issue_events (id, issue_id, kind, from_state, to_state, at, payload) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [++eventId, id, e.kind, e.from ?? null, e.to ?? null, at(e.minutes), e.payload ?? null],
    )
  }
}

beforeEach(async () => {
  eventId = 0
  await db.sql.unsafe('DROP SCHEMA IF EXISTS factory CASCADE')
  await db.sql.unsafe('DROP SCHEMA IF EXISTS factory_legacy CASCADE')
  await db.sql.unsafe(LEGACY)
  await migrate(db.sql, await loadMigrations())
  // 1: closed done. 2: working (a lead runs). 3: waiting on a Decision. 4: queued. 5: stopped.
  await legacyIssue(1, { state: 'closed', outcome: 'done', attempt: 1 }, [
    { kind: 'created', to: 'queued', minutes: 0, payload: { source: 'request' } },
    { kind: 'admitted', from: 'queued', to: 'working', minutes: 5 },
    { kind: 'close', from: 'working', to: 'closed', minutes: 90, payload: { summary: 'done' } },
  ])
  await legacyIssue(2, { state: 'working', attempt: 1 }, [
    { kind: 'created', to: 'queued', minutes: 0 },
    { kind: 'admitted', from: 'queued', to: 'working', minutes: 5 },
  ])
  await legacyIssue(3, { state: 'waiting', reason: 'decision', attempt: 1 }, [
    { kind: 'created', to: 'queued', minutes: 0 },
    { kind: 'admitted', from: 'queued', to: 'working', minutes: 5 },
    {
      kind: 'ask',
      from: 'working',
      to: 'waiting',
      minutes: 10,
      payload: { attempt: 1, question: 'Delete it?', options: ['delete', 'keep'], default: 'keep' },
    },
  ])
  await db.sql.unsafe(
    `INSERT INTO factory_legacy.decisions (id, issue_id, question, options, default_option, created_at) VALUES (9, 3, 'Delete it?', '["delete","keep"]', 'keep', $1)`,
    [at(10)],
  )
  await legacyIssue(4, { state: 'queued' }, [{ kind: 'created', to: 'queued', minutes: 0 }])
  await legacyIssue(5, { state: 'closed', outcome: 'dropped', attempt: 0 }, [
    { kind: 'created', to: 'queued', minutes: 0 },
    { kind: 'stop', from: 'queued', to: 'closed', minutes: 20, payload: { reason: 'not needed' } },
  ])
  await db.sql.unsafe(`INSERT INTO factory_legacy.issue_deps (issue_id, on_issue) VALUES (4, 1)`)
  await db.sql.unsafe(
    `INSERT INTO factory_legacy.door_routes (source, monitor, repo) VALUES ('kuma', 'Example - HTTP', '/Users/example/SourceRoot/example')`,
  )
  await db.sql.unsafe(`INSERT INTO factory_legacy.intake_seen (key, seen_at) VALUES ('kuma:x:down', now())`)
})

const options = () => ({ sql: db.sql, legacySchema: 'factory_legacy', dataDir, now: new Date('2026-11-07T12:00:00Z') })
const count = async (table: string): Promise<number> =>
  ((await db.sql.unsafe(`SELECT count(*)::int AS n FROM factory.${table}`)) as { n: number }[])[0]?.n ?? 0

describe('importLegacy', () => {
  test('every Issue comes over with its number, its state and what hangs off it', async () => {
    const report = await importLegacy(options())
    expect(report.issues.map((i) => i.result)).toEqual(['imported', 'imported', 'imported', 'imported', 'imported'])

    const rows = (await db.sql.unsafe(
      'SELECT id, state, wait_reason, outcome FROM factory.issues ORDER BY id',
    )) as Record<string, unknown>[]
    expect(rows.map((r) => [r.id, r.state, r.wait_reason, r.outcome])).toEqual([
      ['issue_1', 'closed', null, 'done'],
      ['issue_2', 'working', null, null],
      ['issue_3', 'waiting', 'decision', null],
      ['issue_4', 'queued', null, null],
      ['issue_5', 'closed', null, 'cancelled'],
    ])
    // the Decision is open, with its form as an artifact
    expect(await count('decisions')).toBe(1)
    expect(await count('artifacts')).toBe(1)
    expect(await count('artifact_revisions')).toBe(1)
    // the working Issue holds its repo's claim, so it blocks nothing
    expect((await db.sql.unsafe('SELECT issue_id FROM factory.capacity_claims')) as unknown[]).toEqual([
      { issue_id: 'issue_2' },
    ])
    expect(report.claims).toBe(1)
    // the chain, the door's registry
    expect(report.edges).toBe(1)
    expect(report.door.routes).toBe(1)
    const edge = (await db.sql.unsafe('SELECT issue_id, after_issue, satisfied_at FROM factory.planning_edges')) as {
      issue_id: string
      after_issue: string
      satisfied_at: Date | null
    }[]
    expect(edge[0]).toMatchObject({ issue_id: 'issue_4', after_issue: 'issue_1' })
    expect(edge[0]?.satisfied_at).toBeInstanceOf(Date)
    // the next Issue takes a number past the largest
    const [next] = (await db.sql.unsafe("SELECT nextval('factory.issue_numbers')::int AS n")) as { n: number }[]
    expect(next?.n).toBe(6)
    // nothing was imported as an effect: the new core starts nothing by itself
    expect(await count('issue_effects')).toBe(0)
  })

  test('a claim the new core released is not taken again by a later run', async () => {
    await importLegacy(options())
    await db.sql.unsafe("DELETE FROM factory.capacity_claims WHERE issue_id = 'issue_2'")
    const again = await importLegacy(options())
    expect(again.claims).toBe(0)
    expect(await count('capacity_claims')).toBe(0)
  })

  test('a second run changes nothing', async () => {
    await importLegacy(options())
    const tables = [
      'issues',
      'issue_events',
      'decisions',
      'artifacts',
      'capacity_claims',
      'planning_edges',
      'import_events',
      'import_issues',
    ]
    const before = await Promise.all(tables.map(count))
    const again = await importLegacy(options())
    expect(again.issues.every((i) => i.result === 'unchanged')).toBe(true)
    expect(await Promise.all(tables.map(count))).toEqual(before)
  })

  test('what the old core recorded since is appended; an Issue the new core worked since is left alone and said so', async () => {
    await importLegacy(options())
    // the old core worked Issue 4 and Issue 2 in between
    eventId = 100
    await db.sql.unsafe(
      `INSERT INTO factory_legacy.issue_events (id, issue_id, kind, from_state, to_state, at, payload) VALUES (101, 4, 'note', 'queued', NULL, $1, '{"who":"owner","text":"more"}')`,
      [at(200)],
    )
    await db.sql.unsafe(
      `INSERT INTO factory_legacy.issue_events (id, issue_id, kind, from_state, to_state, at, payload) VALUES (102, 2, 'note', 'working', NULL, $1, '{"who":"owner","text":"more"}')`,
      [at(200)],
    )
    // the new core recorded an event on Issue 2 (a window worked it)
    await db.sql.unsafe(
      `INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state) VALUES ('event_new', 'issue_2', 'k-new', 'noted', '{"text":"new"}', 'owner', now(), 'applied', 5, 'working', 'working')`,
    )
    await db.sql.unsafe(`UPDATE factory.issues SET version = 5 WHERE id = 'issue_2'`)
    const report = await importLegacy(options())
    const by = Object.fromEntries(report.issues.map((i) => [i.legacyId, i.result]))
    expect(by[4]).toBe('appended')
    expect(by[2]).toBe('diverged')
    expect(by[1]).toBe('unchanged')
    const notes = (await db.sql.unsafe(
      "SELECT count(*)::int AS n FROM factory.issue_events WHERE issue_id = 'issue_4' AND kind = 'noted'",
    )) as { n: number }[]
    expect(notes[0]?.n).toBe(2)
  })

  test('a number the new core took is a conflict, not an overwrite', async () => {
    await db.sql.unsafe(
      "INSERT INTO factory.issues (id, repo, state, version) VALUES ('issue_4', 'other', 'queued', 1)",
    )
    const report = await importLegacy(options())
    expect(report.issues.find((i) => i.legacyId === 4)).toMatchObject({ result: 'conflict' })
    expect(report.issues.filter((i) => i.result === 'imported')).toHaveLength(4)
  })
})

describe('compareLegacy', () => {
  test('old against new: matching, the explained stop, and nothing unexplained', async () => {
    await importLegacy(options())
    const report = await compareLegacy(options())
    expect(report.compared).toBe(5)
    expect(report.unexplained).toEqual([])
    expect(report.undisposed).toBe(0)
    expect(report.explained.map((m) => [m.legacyId, m.field])).toEqual([[5, 'outcome']])
  })

  test('a changed state is unexplained until a rule explains it', async () => {
    await importLegacy(options())
    await db.sql.unsafe("UPDATE factory.issues SET state = 'queued', outcome = NULL WHERE id = 'issue_1'")
    const report = await compareLegacy(options())
    expect(report.unexplained.map((m) => [m.legacyId, m.field])).toContainEqual([1, 'state'])
  })

  test('an Issue the import never saw is missing', async () => {
    const report = await compareLegacy(options())
    expect(report.unexplained.every((m) => m.field === 'missing')).toBe(true)
    expect(report.unexplained).toHaveLength(5)
  })

  test('an Issue the new core has worked since is carried, not compared', async () => {
    await importLegacy(options())
    await db.sql.unsafe(
      "UPDATE factory.issues SET version = version + 1, state = 'queued', outcome = NULL WHERE id = 'issue_1'",
    )
    const report = await compareLegacy(options())
    expect(report.carried).toBe(1)
    expect(report.unexplained).toEqual([])
  })
})

test('the blobs of the forms are under the data directory', async () => {
  await importLegacy(options())
  const [revision] = (await db.sql.unsafe('SELECT blob FROM factory.artifact_revisions')) as { blob: string }[]
  expect(await Bun.file(join(dataDir, 'blobs', revision?.blob ?? 'missing')).exists()).toBe(true)
})
