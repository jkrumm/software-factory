import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresLoopStore } from '../../src/adapters/postgres/loop-store.ts'
import { loopReads } from '../../src/read/loops.ts'
import { claimRound } from '../../src/app/loops/claim.ts'
import type { CallPolicy } from '../../src/domains/loops/calls.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'

/** The loops' table on a real Postgres: the claim, the restart that lapses an open call, and the retake under its own key. */
let db: TestCluster
const issue = 'issue_1' as IssueId
const policy: CallPolicy = { maxRounds: 3, retryMs: 600_000, leaseMs: 35 * 60_000 }
const keyFor = (round: number) => key('steward', issue, 9, round)

beforeAll(async () => {
  db = await startTestCluster()
  await migrate(db.sql, await loadMigrations())
  await db.sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${issue}, 'app', 'queued', 1)`
})
afterAll(() => db.stop())

test('a claimed call is in flight; after a restart (lapseOpen) it is retaken under its own key, once', async () => {
  const loops = postgresLoopStore(db.sql)
  const now = new Date()
  const ask = (at: Date) =>
    claimRound({ loops }, { loop: 'steward', issue, subject: 'wait:9', now: at, policy, keyFor })

  expect(await ask(now)).toEqual({ kind: 'claimed', round: 1, key: keyFor(1) })
  // another pass inside the lease leaves it alone
  expect(await ask(new Date(now.getTime() + 1_000))).toEqual({ kind: 'in_flight' })

  // the server restarts: no call of the old process is running, so every open lease lapses now
  const later = new Date(now.getTime() + 5_000)
  expect(await loops.lapseOpen(later)).toBe(1)
  expect(await ask(later)).toEqual({ kind: 'claimed', round: 1, key: keyFor(1) })
  // taken once: the retaken call holds a new lease
  expect(await ask(new Date(later.getTime() + 1_000))).toEqual({ kind: 'in_flight' })
  expect((await loops.calls('steward', issue, 'wait:9')).map((row) => [row.round, row.outcome])).toEqual([[1, null]])

  // it ends; the next ask is not a retake but waits out the retry
  await loops.finishCall(keyFor(1), { outcome: 'failed', answer: null, detail: 'gone', at: later })
  expect((await ask(new Date(later.getTime() + 2_000))).kind).toBe('backoff')
  expect(await loops.lapseOpen(later)).toBe(0)
})

// ---- finding classes ------------------------------------------------------------------------------------------------------

test('recordFinding stores the class once; classIssues reads filed time, closure and outcome', async () => {
  const loops = postgresLoopStore(db.sql)
  const reads = loopReads(db.sql)
  const at = (day: number) => new Date(Date.UTC(2026, 9, day))
  for (const [n, state, outcome] of [
    [20, 'closed', 'dropped'],
    [21, 'queued', null],
  ] as const) {
    await db.sql`INSERT INTO factory.issues (id, repo, state, outcome, version) VALUES (${`issue_${n}`}, 'app', ${state}, ${outcome}, 2)`
    await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
      VALUES (${`ev_f_${n}`}, ${`issue_${n}`}, ${`k_f_${n}`}, 'filed', '{}'::jsonb, 'factory', ${at(1)}, 'applied', 1, 'settling')`
  }
  await db.sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, to_state)
    VALUES ('ev_c_20', 'issue_20', 'k_c_20', 'closed', '{}'::jsonb, 'factory', ${at(5)}, 'applied', 2, 'closed')`

  await loops.recordFinding({ issue: 'issue_20', loop: 'hygiene', repo: 'app', class: 'links', key: 'links:a.md' })
  await loops.recordFinding({ issue: 'issue_20', loop: 'hygiene', repo: 'app', class: 'other', key: 'other:x' })
  await loops.recordFinding({ issue: 'issue_21', loop: 'hygiene', repo: 'app', class: 'links', key: 'links:b.md' })
  await loops.recordFinding({ issue: 'issue_21', loop: 'friction', repo: 'software-factory', class: 'x', key: 'x' })

  expect(await reads.classIssues('hygiene', 'app')).toEqual({
    links: [
      { issue: 'issue_20', filedAt: at(1), closedAt: at(5), outcome: 'dropped' },
      { issue: 'issue_21', filedAt: at(1), closedAt: null, outcome: null },
    ],
  })
  expect(await reads.classIssues('friction', 'app')).toEqual({})
  expect((await reads.allClassIssues()).map((g) => [g.loop, g.repo, g.class, g.issues.length])).toEqual([
    ['hygiene', 'app', 'links', 2],
  ])
})

test('the backfill classes the Issues the loops filed from their signal text, with its line breaks or as intake stores it on one line', async () => {
  const cluster = await startTestCluster()
  try {
    const all = await loadMigrations()
    await migrate(
      cluster.sql,
      all.filter((m) => m.name < '0993'),
    )
    const texts: [number, string, string, string][] = [
      [1, 'agent', 'filed', 'Swept: app @ abc1234\nProbe: cochange (cochange:a.ts|b.ts)\nEvidence (2 item(s)):\nx'],
      [2, 'agent', 'amended', 'Swept: app @ abc1234\nJudgment: stale document docs/x.md\nFinding: t'],
      [3, 'agent', 'filed', 'Pattern: Owner touches (touch:noted)\nWindow: a to b'],
      [4, 'agent', 'filed', 'free text from an agent'],
      [5, 'owner', 'filed', 'Probe: links (links:a.md)'],
      [6, 'agent', 'filed', 'Swept: app @ abc1234\nProbe: check (check)\nEvidence (1 item(s)):\nx'],
      [
        7,
        'agent',
        'filed',
        'Swept: app @ abc1234 Probe: links (links:docs/a b.md) Evidence (1 item(s)), up to the first 1 lines: x',
      ],
      [8, 'agent', 'filed', 'Swept: app @ abc1234 Judgment: slop document docs/y.md Finding: t Evidence: e Fix: f'],
      [
        9,
        'agent',
        'filed',
        'Pattern: Stalled because the lead was blocked (stall:blocked) Window: a to b (7 days) Count: 26',
      ],
    ]
    for (const [n, trust, state, text] of texts) {
      await cluster.sql`INSERT INTO factory.issues (id, repo, state, version) VALUES (${`issue_${n}`}, 'app', 'queued', 1)`
      await cluster.sql`INSERT INTO factory.intake_signals (id, source, kind, origin, trust, repo, fingerprint, title, text, received_at, state, issue_id)
        VALUES (${`signal_${n}`}, 'agent:app', 'request', 'factory', ${trust}, 'app', ${`fp${n}`}, 't', ${text}, now(), ${state}, ${`issue_${n}`})`
    }
    expect(await migrate(cluster.sql, all)).toContain('0994_finding_classes_backfill.sql')
    const rows: { issue_id: string; loop: string; repo: string; class: string; key: string }[] =
      await cluster.sql`SELECT * FROM factory.loop_findings ORDER BY issue_id`
    expect(rows.map((r) => [r.issue_id, r.loop, r.repo, r.class, r.key])).toEqual([
      ['issue_1', 'hygiene', 'app', 'cochange', 'cochange:a.ts|b.ts'],
      ['issue_2', 'hygiene', 'app', 'judgment:stale', 'judgment:stale:docs/x.md'],
      ['issue_3', 'friction', 'app', 'touch', 'touch:noted'],
      ['issue_6', 'hygiene', 'app', 'check', 'check'],
      ['issue_7', 'hygiene', 'app', 'links', 'links:docs/a b.md'],
      ['issue_8', 'hygiene', 'app', 'judgment:slop', 'judgment:slop:docs/y.md'],
      ['issue_9', 'friction', 'app', 'stall', 'stall:blocked'],
    ])
  } finally {
    await cluster.stop()
  }
})
