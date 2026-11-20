import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresLoopStore } from '../../src/adapters/postgres/loop-store.ts'
import { settleClosed } from '../../src/app/loops/ledger.ts'
import { judgeClosed, lastTime, movedDown, newestByKey, type ClosedFinding } from '../../src/domains/improve/ledger.ts'
import { planSelfwatch } from '../../src/domains/improve/selfwatch.ts'
import { readGate } from '../../src/app/loops/gate.ts'
import { loopReads } from '../../src/read/loops.ts'
import { ok } from '../../src/kernel/result.ts'

const at = (day: number) => new Date(Date.UTC(2026, 10, day))
const closed = (over: Partial<ClosedFinding> = {}): ClosedFinding => ({
  issue: 'issue_1',
  loop: 'friction',
  repo: 'software-factory',
  key: 'stall:wall',
  figure: 12,
  verdict: null,
  outcome: 'done',
  filedAt: at(1),
  closedAt: at(3),
  ...over,
})

test('a count is exact: any fall moved; a measured figure keeps its band', () => {
  expect(movedDown(12, 11)).toBe('moved')
  expect(movedDown(12, 12)).toBe('flat')
  expect(movedDown(12, 13)).toBe('worse')
  expect(movedDown(0, 0)).toBe('flat')
  expect(movedDown(100, 95, 0.1)).toBe('flat')
  expect(movedDown(100, 80, 0.1)).toBe('moved')
  // the band's edge is a move, as the throughput ledger always read it
  expect(movedDown(100, 90, 0.1)).toBe('moved')
  expect(movedDown(100, 110, 0.1)).toBe('worse')
})

test('judgeClosed: noise and a finding with no figure are unmeasured, a source that cannot be read waits, a verdict is kept', () => {
  const rows = [
    closed({ issue: 'issue_1' }),
    closed({ issue: 'issue_2', outcome: 'dropped' }),
    closed({ issue: 'issue_3', figure: null }),
    closed({ issue: 'issue_4' }),
    closed({ issue: 'issue_5', verdict: 'worse' }),
    closed({ issue: 'issue_6', key: 'none' }),
  ]
  expect(judgeClosed(rows, (row) => (row.issue === 'issue_4' ? undefined : row.key === 'none' ? null : 7))).toEqual([
    { issue: 'issue_1', key: 'stall:wall', verdict: 'moved', measured: 7 },
    { issue: 'issue_2', key: 'stall:wall', verdict: 'unmeasured', measured: null },
    { issue: 'issue_3', key: 'stall:wall', verdict: 'unmeasured', measured: null },
    { issue: 'issue_6', key: 'none', verdict: 'unmeasured', measured: null },
  ])
})

test('lastTime names the Issue, the figure then and now, how it closed and what it did', () => {
  expect(lastTime(undefined, 3)).toBeNull()
  expect(lastTime(closed({ verdict: 'moved' }), 11)).toBe('Last time: Issue issue_1 at figure 12, now 11 (moved).')
  expect(lastTime(closed({ figure: null, outcome: 'dropped' }), null)).toBe(
    'Last time: Issue issue_1 at no figure, now no figure, closed dropped.',
  )
  const newest = newestByKey([closed(), closed({ issue: 'issue_2', filedAt: at(2) })])
  expect(newest.get('stall:wall')?.issue).toBe('issue_2')
})

let db: TestCluster
beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
})
afterAll(() => db.stop())

const issue = async (n: number, state: 'closed' | 'queued', outcome: string | null = null) => {
  await db.sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES (${`issue_${n}`}, 'app', ${state}, ${outcome}, 2)`
  await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
    VALUES (${`ev_f_${n}`}, ${`issue_${n}`}, ${`k_f_${n}`}, 'filed', '{}'::jsonb, 'factory', ${at(1)}, 'applied', 1, 'settling')`
  if (state === 'closed')
    await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
      VALUES (${`ev_c_${n}`}, ${`issue_${n}`}, ${`k_c_${n}`}, 'closed', '{}'::jsonb, 'factory', ${at(3)}, 'applied', 2, 'closed')`
}

test('the ledger on Postgres: a figure is stored once, a closed Issue is judged once against the figure read now, and the next filing says so', async () => {
  const loops = postgresLoopStore(db.sql)
  const uow = {
    run: async (work: (s: never) => Promise<unknown>) => work({ loops, loopReads: loopReads(db.sql) } as never),
    inTransaction: () => false,
  }
  await issue(10, 'closed', 'done')
  await issue(11, 'queued')
  await issue(12, 'closed', 'dropped')
  const record = (n: number, key: string, figure: number | null) =>
    loops.recordFinding({
      issue: `issue_${n}`,
      loop: 'friction',
      repo: 'software-factory',
      class: 'stall',
      key,
      signal: null,
      filedAt: at(1),
      figure,
    })
  await record(10, 'stall:wall', 12)
  await record(10, 'stall:wall', 99)
  await record(11, 'stall:blocked', 5)
  await record(12, 'stall:noise', 4)

  const settled = await settleClosed(
    { uow: uow as never },
    { loop: 'friction', now: at(5), read: (row) => (row.key === 'stall:wall' ? 11 : 0) },
  )
  expect(settled.ok).toBe(true)
  expect(settled.ok && settled.value.lastTime('stall:wall', 11)).toBe(
    'Last time: Issue issue_10 at figure 12, now 11 (moved).',
  )
  expect(settled.ok && settled.value.lastTime('stall:blocked', 5)).toBeNull()
  const rows =
    await db.sql`SELECT issue_id, figure::float8, measured::float8, verdict FROM factory.loop_findings WHERE loop = 'friction' ORDER BY issue_id`
  expect(
    rows.map((r: { issue_id: string; figure: number; measured: number | null; verdict: string | null }) => [
      r.issue_id,
      r.figure,
      r.measured,
      r.verdict,
    ]),
  ).toEqual([
    ['issue_10', 12, 11, 'moved'],
    ['issue_11', 5, null, null],
    ['issue_12', 4, null, 'unmeasured'],
  ])
  // judged once: a later read of another figure leaves the verdict
  const again = await settleClosed({ uow: uow as never }, { loop: 'friction', now: at(6), read: () => 40 })
  expect(again.ok && again.value.lastTime('stall:wall', 40)).toBe(
    'Last time: Issue issue_10 at figure 12, now 40 (moved).',
  )
  expect(
    (await db.sql`SELECT measured::float8 FROM factory.loop_findings WHERE issue_id = 'issue_10'`)[0]?.measured,
  ).toBe(11)
  void ok
})

test('one Issue may carry several findings: a row and a verdict per key, the class read once per Issue, the newest Issue per key', async () => {
  const loops = postgresLoopStore(db.sql)
  const reads = loopReads(db.sql)
  const uow = {
    run: async (work: (s: never) => Promise<unknown>) => work({ loops, loopReads: reads } as never),
    inTransaction: () => false,
  }
  await issue(60, 'closed', 'done')
  const record = (key: string, figure: number) =>
    loops.recordFinding({
      issue: 'issue_60',
      loop: 'hygiene',
      repo: 'batch-app',
      class: key.split(':')[0] ?? key,
      key,
      signal: null,
      filedAt: at(1),
      figure,
    })
  await record('links:a.md', 3)
  await record('links:b.md', 2)
  await record('deadcode', 8)
  // a repeat of a key on the same Issue is a no-op
  await record('links:a.md', 99)
  expect((await db.sql`SELECT count(*)::int AS n FROM factory.loop_findings WHERE issue_id = 'issue_60'`)[0]?.n).toBe(3)

  // the Issue is one Issue of the links class, not two
  const classes = await reads.classIssues('hygiene')
  expect(Object.keys(classes).sort()).toEqual(['deadcode', 'links'])
  expect(classes.links?.map((i) => i.issue)).toEqual(['issue_60'])

  // each key is judged by itself, against its own figure
  const settled = await settleClosed(
    { uow: uow as never },
    { loop: 'hygiene', repo: 'batch-app', now: at(5), read: (row) => (row.key === 'links:a.md' ? 0 : row.figure) },
  )
  expect(settled.ok).toBe(true)
  const rows = await db.sql`SELECT key, verdict FROM factory.loop_findings WHERE issue_id = 'issue_60' ORDER BY key`
  expect(rows.map((r: { key: string; verdict: string | null }) => [r.key, r.verdict])).toEqual([
    ['deadcode', 'flat'],
    ['links:a.md', 'moved'],
    ['links:b.md', 'flat'],
  ])

  // the lifecycle reads the newest Issue of each key: all three keys point at the one Issue
  const issues = await reads.findingIssues('batch-app')
  expect(issues.map((i) => [i.key, i.issue, i.state])).toEqual([
    ['deadcode', 'issue_60', 'closed'],
    ['links:a.md', 'issue_60', 'closed'],
    ['links:b.md', 'issue_60', 'closed'],
  ])
})

test('the self-watch memory is the newest row of a subject; a refile of the same Issue updates it, a new Issue supersedes it, a repeat of a closed one teaches the old row', async () => {
  const loops = postgresLoopStore(db.sql)
  const row = (over: Record<string, unknown> = {}) => ({
    issueId: 'issue_20' as string | null,
    repo: 'software-factory',
    figure: 7 as number | null,
    subjectKey: 'process_storm:host',
    kind: 'process_storm' as const,
    firstSeenAt: at(1),
    lastSeenAt: at(1),
    evidenceHash: 'h1',
    lastFiledAt: at(1),
    signalId: 'signal_1' as string | null,
    clearedAt: null,
    ...over,
  })
  await loops.applySelfwatch({ filed: [row()], touched: [], cleared: [], at: at(1) })
  await loops.applySelfwatch({ filed: [], touched: ['process_storm:host'], cleared: [], at: at(2) })
  expect((await loops.selfwatchRows()).map((r) => [r.issueId, r.lastSeenAt, r.clearedAt, r.figure])).toEqual([
    ['issue_20', at(2), null, 7],
  ])
  // changed evidence amends the same Issue: its row keeps the figure it was filed against
  await loops.applySelfwatch({
    filed: [row({ evidenceHash: 'h2', lastFiledAt: at(3), lastSeenAt: at(3), figure: 9, firstSeenAt: at(1) })],
    touched: [],
    cleared: [],
    at: at(3),
  })
  let [only] = await loops.selfwatchRows()
  expect([only?.evidenceHash, only?.lastFiledAt, only?.figure]).toEqual(['h2', at(3), 7])
  await loops.applySelfwatch({ filed: [], touched: [], cleared: ['process_storm:host'], at: at(4) })
  expect((await loops.selfwatchRows())[0]?.clearedAt).toEqual(at(4))
  // a repeat of an Issue closed lately: no Issue carries it, the row learns the evidence and is live again
  await loops.applySelfwatch({
    filed: [row({ issueId: null, evidenceHash: 'h3', lastFiledAt: at(5), firstSeenAt: at(5), lastSeenAt: at(5) })],
    touched: [],
    cleared: [],
    at: at(5),
  })
  ;[only] = await loops.selfwatchRows()
  expect([only?.issueId, only?.evidenceHash, only?.clearedAt]).toEqual(['issue_20', 'h3', null])
  // a new Issue for the subject: it is the memory now, and the old one is cleared
  await loops.applySelfwatch({
    filed: [
      row({ issueId: 'issue_21', evidenceHash: 'h4', lastFiledAt: at(6), firstSeenAt: at(6), lastSeenAt: at(6) }),
    ],
    touched: [],
    cleared: [],
    at: at(6),
  })
  expect((await loops.selfwatchRows()).map((r) => [r.issueId, r.evidenceHash])).toEqual([['issue_21', 'h4']])
  expect(
    (await db.sql`SELECT cleared_at FROM factory.loop_findings WHERE issue_id = 'issue_20'`)[0]?.cleared_at,
  ).toEqual(at(6))
})

test('a row of a kind no longer filed is read as it stands, and cleared when its subject is absent, never a failed parse', async () => {
  const loops = postgresLoopStore(db.sql)
  await issue(40, 'queued')
  await loops.applySelfwatch({
    filed: [
      {
        issueId: 'issue_40',
        repo: 'software-factory',
        figure: 2500,
        subjectKey: 'routes_slow:routes',
        kind: 'routes_slow',
        firstSeenAt: at(1),
        lastSeenAt: at(1),
        evidenceHash: 'h1',
        lastFiledAt: at(1),
        signalId: null,
        clearedAt: null,
      },
    ],
    touched: [],
    cleared: [],
    at: at(1),
  })
  const rows = await loops.selfwatchRows()
  expect(rows.find((r) => r.subjectKey === 'routes_slow:routes')).toMatchObject({
    kind: 'routes_slow',
    issueId: 'issue_40',
    clearedAt: null,
  })
  expect(planSelfwatch([], rows, at(2)).clear).toContain('routes_slow:routes')
})

test('the migration copies the two old ledgers into loop_findings: the status becomes verdict and ship, the Issue the signal reached keeps the memory', async () => {
  const cluster = await startTestCluster()
  try {
    const all = await loadMigrations()
    await migrate(
      cluster.sql,
      all.filter((m) => m.name < '1061'),
    )
    for (const n of [1, 2, 3, 4, 5])
      await cluster.sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${`issue_${n}`}, 'app', 'queued', 1)`
    await cluster.sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, issue_id)
      VALUES ('signal_1', 'agent:app', 'request', 'factory', 'agent', 'app', 'fp1', 't', 'x', now(), 'filed', 'issue_1')`
    await cluster.sql`INSERT INTO factory.selfwatch_findings (subject_key, kind, first_seen_at, last_seen_at, evidence_hash, last_filed_at, signal_id, cleared_at)
      VALUES ('lead_idle:wf', 'lead_idle', ${at(1)}, ${at(2)}, 'h', ${at(2)}, 'signal_1', ${at(3)}), ('lead_idle:none', 'lead_idle', ${at(1)}, ${at(2)}, 'h', ${at(2)}, NULL, NULL)`
    const finding = (
      id: string,
      status: string,
      issue: string | null,
      over: { shipped?: Date; after?: number; reopens?: string } = {},
    ) =>
      cluster.sql`INSERT INTO factory.throughput_findings (id, project, kpi, subject, before, target, direction, unit, cost_minutes, query, issue_id, filed_at, shipped_at, after, after_at, status, reopens)
        VALUES (${id}, 'app', 'step_peak_mib', 'full', 4096, 2048, 'down', 'MiB', 90, 'q', ${issue}, ${at(1)}, ${over.shipped ?? null}, ${over.after ?? null}, ${over.after === undefined ? null : at(9)}, ${status}, ${over.reopens ?? null})`
    await finding('f1', 'flat', 'issue_2', { shipped: at(2), after: 4000 })
    await finding('f2', 'open', 'issue_3', { reopens: 'f1' })
    await finding('f3', 'dropped', 'issue_4')
    await finding('f4', 'shipped', 'issue_5', { shipped: at(4) })
    await finding('f5', 'open', null)
    await migrate(cluster.sql, all)
    const rows: Record<string, unknown>[] =
      await cluster.sql`SELECT issue_id, loop, repo, class, key, figure::float8, verdict, shipped_at, measured::float8, reopens, cleared_at, evidence_hash
      FROM factory.loop_findings ORDER BY issue_id`
    expect(
      rows.map((r) => [r.issue_id, r.loop, r.class, r.key, r.figure, r.verdict, r.shipped_at, r.measured, r.reopens]),
    ).toEqual([
      ['issue_1', 'selfwatch', 'lead_idle', 'lead_idle:wf', null, null, null, null, null],
      ['issue_2', 'throughput', 'step_peak_mib', 'step_peak_mib:full', 4096, 'flat', at(2), 4000, null],
      ['issue_3', 'throughput', 'step_peak_mib', 'step_peak_mib:full', 4096, null, null, null, 'issue_2'],
      ['issue_4', 'throughput', 'step_peak_mib', 'step_peak_mib:full', 4096, 'unmeasured', null, null, null],
      ['issue_5', 'throughput', 'step_peak_mib', 'step_peak_mib:full', 4096, null, at(4), null, null],
    ])
    expect(rows[0]).toMatchObject({ repo: 'app', cleared_at: at(3), evidence_hash: 'h' })
  } finally {
    await cluster.stop()
  }
})

test('the self-watch loop is on the class gate: a kind whose Issues were mostly dropped files nothing, another kind still does', async () => {
  const loops = postgresLoopStore(db.sql)
  const uow = {
    run: async (work: (s: never) => Promise<unknown>) => work({ loops, loopReads: loopReads(db.sql) } as never),
    inTransaction: () => false,
  }
  for (const n of [30, 31, 32]) {
    await issue(n, 'closed', 'dropped')
    await loops.recordFinding({
      issue: `issue_${n}`,
      loop: 'selfwatch',
      repo: 'software-factory',
      class: 'lead_idle',
      key: `lead_idle:issue_${n}`,
      signal: null,
      filedAt: at(1),
      figure: null,
    })
  }
  const gate = await readGate({ uow: uow as never }, { loop: 'selfwatch', now: at(5) })
  expect(gate.ok && gate.value.allows('lead_idle:issue_99')).toBe(false)
  expect(gate.ok && gate.value.allows('migration_clash:wf')).toBe(true)
})
