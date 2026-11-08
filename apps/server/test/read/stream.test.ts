import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import {
  changesAfter,
  CursorGone,
  encodeFrame,
  follow,
  formatCursor,
  nowCursor,
  parseCursor,
  resolveCursor,
} from '../../src/read/stream.ts'
import { loadStreamSettings } from '../../src/read/stream-settings.ts'

let db: TestCluster

beforeAll(async () => {
  db = await startTestCluster()
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
})

afterAll(async () => {
  await db.stop()
})

beforeEach(async () => {
  await db.sql`TRUNCATE factory.changes RESTART IDENTITY`
})

const START = { txid: 0n, seq: 0n }

const insert = (sql: typeof db.sql, subject: string) =>
  sql`INSERT INTO factory.changes (kind, issue_id, subject) VALUES ('issue', 'issue_1', ${subject})`

describe('cursor', () => {
  test('parses and formats <txid>.<seq>', () => {
    expect(parseCursor('12.34')).toEqual({ txid: 12n, seq: 34n })
    expect(formatCursor({ txid: 12n, seq: 34n })).toBe('12.34')
    expect(parseCursor(formatCursor({ txid: 2n ** 64n - 1n, seq: 2n ** 63n - 1n }))).toEqual({
      txid: 2n ** 64n - 1n,
      seq: 2n ** 63n - 1n,
    })
  })

  test.each([
    '',
    'garbage',
    '1',
    '1.',
    '.1',
    '1.2.3',
    '-1.2',
    '1.-2',
    '1e3.2',
    ' 1.2',
    '99999999999999999999.1',
    '1.9223372036854775808',
  ])('refuses %p', (text) => {
    expect(parseCursor(text)).toBeNull()
  })
})

describe('frames', () => {
  test('a change carries its cursor as id and its kind as event, with no cursor in data', () => {
    const frame = encodeFrame({
      type: 'change',
      change: {
        cursor: '5.9',
        kind: 'decision',
        issue: 12,
        ref: 'issue_12',
        subject: 'asked',
        detail: { decision: 'decision_1' },
        at: '2026-11-07T10:00:00.000Z',
      },
    })
    expect(frame).toBe(
      'id: 5.9\nevent: decision\ndata: {"kind":"decision","issue":12,"ref":"issue_12","subject":"asked","detail":{"decision":"decision_1"},"at":"2026-11-07T10:00:00.000Z"}\n\n',
    )
  })

  test('hello names the version and the cursor, a keepalive is a comment', () => {
    expect(encodeFrame({ type: 'hello', cursor: '0.0' })).toBe(
      'id: 0.0\nevent: hello\ndata: {"version":"v1","cursor":"0.0"}\n\n',
    )
    expect(encodeFrame({ type: 'keepalive' })).toBe(': keepalive\n\n')
  })
})

describe('settings', () => {
  test('the poll is 1000 ms unless FACTORY_STREAM_POLL_MS says otherwise', () => {
    expect(loadStreamSettings({}).pollMs).toBe(1000)
    expect(loadStreamSettings({ FACTORY_STREAM_POLL_MS: '250' }).pollMs).toBe(250)
    expect(() => loadStreamSettings({ FACTORY_STREAM_POLL_MS: 'soon' })).toThrow('FACTORY_STREAM_POLL_MS')
  })
})

describe('changesAfter', () => {
  test('returns rows in order with the cursor of the last one', async () => {
    await insert(db.sql, 'a')
    await insert(db.sql, 'b')
    const { changes, next } = await changesAfter(db.sql, { cursor: START, limit: 10 })
    expect(changes.map((c) => c.subject)).toEqual(['a', 'b'])
    expect(changes[0]).toMatchObject({ kind: 'issue', issue: 1, ref: 'issue_1', detail: {} })
    expect(formatCursor(next)).toBe(changes[1]?.cursor as string)
    expect((await changesAfter(db.sql, { cursor: next, limit: 10 })).changes).toEqual([])
  })

  test('an Issue filter keeps that Issue only', async () => {
    await insert(db.sql, 'a')
    await db.sql`INSERT INTO factory.changes (kind, issue_id, subject) VALUES ('issue', 'issue_2', 'other')`
    const { changes } = await changesAfter(db.sql, { cursor: START, issue: 'issue_2', limit: 10 })
    expect(changes.map((c) => c.subject)).toEqual(['other'])
  })

  test('resume over 200 inserts in several transactions loses nothing and doubles nothing', async () => {
    const seen: string[] = []
    let cursor = START
    let written = 0
    // Batches of 7 and a reconnect after each, while the writer adds transactions of 1 to 9 rows between them.
    while (written < 200 || seen.length < written) {
      if (written < 200) {
        const rows = Math.min(1 + (written % 9), 200 - written)
        await db.sql.begin(async (tx) => {
          for (let i = 0; i < rows; i++) await insert(tx, `n${written + i}`)
        })
        written += rows
      }
      const { changes, next } = await changesAfter(db.sql, { cursor, limit: 7 })
      seen.push(...changes.map((c) => c.subject as string))
      cursor = next
    }
    expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => `n${i}`))
  })

  test('while a transaction is open nothing past its id is emitted; after it commits both appear in (txid, seq) order', async () => {
    let finishA!: () => void
    const hold = new Promise<void>((resolve) => {
      finishA = resolve
    })
    let started!: () => void
    const begun = new Promise<void>((resolve) => {
      started = resolve
    })
    // A takes its transaction id first, B writes and commits after, A writes last: A's row has the larger seq and the smaller txid.
    const a = db.sql.begin(async (tx) => {
      await tx`SELECT pg_current_xact_id()`
      started()
      await hold
      await insert(tx, 'a-late')
    })
    await begun
    await insert(db.sql, 'b-committed-first')

    expect((await changesAfter(db.sql, { cursor: START, limit: 10 })).changes).toEqual([])
    expect(await nowCursor(db.sql)).toEqual(START)

    finishA()
    await a
    const { changes } = await changesAfter(db.sql, { cursor: START, limit: 10 })
    expect(changes.map((c) => c.subject)).toEqual(['a-late', 'b-committed-first'])
  })

  test('a row from a rolled-back transaction never appears', async () => {
    await db.sql
      .begin(async (tx) => {
        await insert(tx, 'gone')
        throw new Error('rollback')
      })
      .catch(() => {})
    await insert(db.sql, 'kept')
    expect((await changesAfter(db.sql, { cursor: START, limit: 10 })).changes.map((c) => c.subject)).toEqual(['kept'])
  })
})

describe('resolveCursor', () => {
  test('no since starts at now: the newest row, so only later ones follow', async () => {
    await insert(db.sql, 'old')
    const cursor = await resolveCursor(db.sql, null)
    await insert(db.sql, 'new')
    expect((await changesAfter(db.sql, { cursor, limit: 10 })).changes.map((c) => c.subject)).toEqual(['new'])
  })

  test('a garbage cursor and one ahead of every stored row are cursor_gone', async () => {
    await insert(db.sql, 'a')
    expect(await resolveCursor(db.sql, 'garbage').catch((error: unknown) => error)).toBeInstanceOf(CursorGone)
    expect(await resolveCursor(db.sql, '1.999').catch((error: unknown) => error)).toBeInstanceOf(CursorGone)
    expect(await resolveCursor(db.sql, '99999999999.1').catch((error: unknown) => error)).toBeInstanceOf(CursorGone)
    expect(await resolveCursor(db.sql, '0.0')).toEqual(START)
  })
})

describe('follow', () => {
  test('hello first, then changes as they commit, and it stops on abort', async () => {
    const abort = new AbortController()
    const events = follow(db.sql, { cursor: START, pollMs: 20, signal: abort.signal, keepaliveMs: 60 })
    expect((await events.next()).value).toMatchObject({ type: 'hello', cursor: '0.0' })
    await insert(db.sql, 'one')
    const types: string[] = []
    for await (const event of events) {
      types.push(event.type)
      if (event.type === 'change') expect(event.change.subject).toBe('one')
      if (types.includes('keepalive')) abort.abort()
    }
    expect(types[0]).toBe('change')
    expect(types).toContain('keepalive')
  })
})

describe('triggers', () => {
  test('every source table writes a change in the transaction that moved it', async () => {
    const { sql } = db
    await sql`INSERT INTO factory.issues (id, repo, state, version) VALUES ('issue_1', 'argo', 'settling', 1)`
    await sql`
      INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
      VALUES ('event_1', 'issue_1', 'k1', 'filed', '{}', 'factory', now(), 'applied', 1, 'settling')`
    await sql`
      INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at)
      VALUES ('lead-1-1:turn_started:1', 'lead-1-1', 'issue_1', 1, 'turn_started', now(), now())`
    await sql`
      INSERT INTO factory.decisions (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at)
      VALUES ('decision_1', 'dk', 'issue_1', 'argo', 1, 'which?', 'a', 'x', '[]', '{}', now())`
    await sql`UPDATE factory.decisions SET answer = 'a', settled_by = 'owner', answered_at = now() WHERE id = 'decision_1'`
    await sql`
      INSERT INTO factory.artifacts (id, key, issue_id, kind, title, format, author, created_at)
      VALUES ('artifact_1', 'ak', 'issue_1', 'spec', 't', 'markdown', 'lead', now())`
    await sql`
      INSERT INTO factory.artifact_revisions (artifact_id, n, key, blob, sha256, bytes, created_at)
      VALUES ('artifact_1', 1, 'rk', 'b', 's', 1, now())`
    await sql`
      INSERT INTO factory.annotations (id, key, artifact_id, revision, quote, comment, author, at)
      VALUES ('annotation_1', 'nk', 'artifact_1', 1, 'q', 'c', 'owner', now())`
    await sql`
      INSERT INTO factory.verdicts (artifact_id, revision, key, verdict, at) VALUES ('artifact_1', 1, 'vk', 'changes', now())`
    await sql`
      INSERT INTO factory.errands (id, key, issue_id, attempt, summary, raised_at, reached_owner_at)
      VALUES ('errand_1', 'ek', 'issue_1', 1, 's', now(), now())`
    await sql`UPDATE factory.errands SET done_at = now() WHERE id = 'errand_1'`
    await sql`
      INSERT INTO factory.intake_signals (id, source, kind, origin, trust, fingerprint, title, text, received_at, state)
      VALUES ('signal_1', 'feedback:app', 'feedback', 'feedback', 'outside', 'f', 't', 'x', now(), 'held')`
    await sql`UPDATE factory.intake_signals SET state = 'promoted', issue_id = 'issue_1' WHERE id = 'signal_1'`
    // an update that changes neither state nor a done column writes nothing
    await sql`UPDATE factory.decisions SET worth_asking = true WHERE id = 'decision_1'`

    const { changes } = await changesAfter(sql, { cursor: START, limit: 50 })
    expect(changes.map((c) => `${c.kind}:${c.subject}`)).toEqual([
      'issue:filed',
      'session:turn_started',
      'decision:asked',
      'decision:answered',
      'artifact:created',
      'artifact:revised',
      'artifact:annotated',
      'artifact:verdict',
      'errand:raised',
      'errand:done',
      'signal:held',
      'signal:promoted',
    ])
    expect(changes[0]).toMatchObject({ issue: 1, ref: 'issue_1', detail: { to: 'settling', result: 'applied' } })
    expect(changes[1]?.detail).toEqual({ session: 'lead-1-1', attempt: 1 })
    expect(changes[7]).toMatchObject({ issue: 1, detail: { verdict: 'changes', artifact: 'artifact_1' } })
    expect(changes[10]?.issue).toBeNull()
    expect(changes[11]?.issue).toBe(1)
  })
})
