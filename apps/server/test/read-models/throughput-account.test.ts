import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ThroughputModel } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import type { SQL } from 'bun'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { readThroughput } from '../../src/read/throughput.ts'

/**
 * Where a lead's wall time and a project's slot minutes go, over seeded rows. The split of each closed Issue is checked
 * against hand-computed values, and against a restatement in another shape: the wall walked minute by minute, every
 * minute put in the first place that covers it. Every seeded instant is a whole minute, so the two agree to the second.
 */
let db: TestCluster
let sql: SQL
const NOW = new Date('2026-11-07T12:00:00Z')
const HOURS = 24
const FROM = new Date(NOW.getTime() - HOURS * 3_600_000)
const t = (hhmm: string, day = '11-07'): Date => new Date(`2026-${day}T${hhmm}:00Z`)
const MIN = 60_000

beforeAll(async () => {
  db = await startTestCluster()
  sql = db.sql
  await migrate(sql, await loadMigrations())
  await seed()
})
afterAll(() => db.stop())

let eventNo = 0
/** An Issue with its applied events: `[at, state, wait reason]`, the last of them `closed` for a closed one. */
async function issue(n: number, repo: string, events: [Date, string, string?][]) {
  const id = `issue_${n}`
  const last = events.at(-1)
  await sql`INSERT INTO factory.issues (id, repo, state, wait_reason, outcome, version)
    VALUES (${id}, ${repo}, ${last?.[1] ?? 'queued'}, ${last?.[1] === 'waiting' ? (last[2] ?? null) : null},
            ${last?.[1] === 'closed' ? 'done' : null}, ${events.length})`
  let version = 0
  for (const [at, state, reason] of events) {
    version++
    eventNo++
    await sql`INSERT INTO factory.issue_events (id, issue_id, key, kind, payload, actor, at, result, version, from_state, to_state, wait, outcome)
      VALUES (${`ev_${eventNo}`}, ${id}, ${`key_${eventNo}`}, 'seeded', '{}'::jsonb, 'factory', ${at}, 'applied', ${version},
              ${version === 1 ? null : 'working'}, ${state},
              ${reason ? JSON.stringify({ reason, since: 1, told: 1 }) : null}::text::jsonb, ${state === 'closed' ? 'done' : null})`
  }
}

async function attempt(n: number, no: number, startedAt: Date | null, worktree: string | null) {
  await sql`INSERT INTO factory.lead_attempts (issue_id, attempt, branch, worktree_path, first_try_at, started_at)
    VALUES (${`issue_${n}`}, ${no}, ${`factory/${n}-${no}`}, ${worktree}, ${startedAt ?? t('00:00')}, ${startedAt})`
}

let hookNo = 0
async function hook(n: number, no: number, kind: string, at: Date, payload: object = {}) {
  hookNo++
  await sql`INSERT INTO factory.lead_hook_events (key, session, issue_id, attempt, kind, at, received_at, payload)
    VALUES (${`hk_${hookNo}`}, ${`lead-${n}-${no}`}, ${`issue_${n}`}, ${no}, ${kind}, ${at}, ${at}, ${JSON.stringify(payload)}::text::jsonb)`
}

/** A step that ended at `end` after running `run` minutes, having waited `wait` minutes for its slot. */
async function step(
  end: Date,
  name: string,
  repo: string,
  cwd: string | null,
  run: number,
  wait: number,
  exit: number,
  peak: number,
) {
  await sql`INSERT INTO factory.step_costs (at, name, repo, peak_rss_mib, cpu_seconds, duration_ms, wait_ms, exit_code, cwd)
    VALUES (${end}, ${name}, ${repo}, ${peak}, 1, ${run * MIN}, ${wait * MIN}, ${exit}, ${cwd})`
}

async function ciRun(
  id: number,
  repo: string,
  branch: string,
  queued: Date,
  started: Date,
  finished: Date,
  conclusion: string,
) {
  await sql`INSERT INTO factory.ci_runs (repo, run_id, workflow, event, head_branch, head_sha, queued_at, started_at, finished_at, conclusion)
    VALUES (${repo}, ${id}, 'CI', 'pull_request', ${branch}, 'abc', ${queued}, ${started}, ${finished}, ${conclusion})`
}

async function seed() {
  // Issue 1 (app): a lead from 08:00 to the close at 09:00 that waited on the owner, a slot, a step, the merge lock and CI
  await issue(1, 'app', [
    [t('07:50'), 'settling'],
    [t('07:55'), 'queued'],
    [t('08:00'), 'working'],
    [t('08:20'), 'waiting', 'decision'],
    [t('08:30'), 'working'],
    [t('09:00'), 'closed'],
  ])
  await attempt(1, 1, t('08:00'), '/w/factory-1-1')
  await hook(1, 1, 'session_started', t('08:00'), { source: 'startup' })
  await hook(1, 1, 'turn_started', t('08:00'))
  await hook(1, 1, 'turn_ended', t('08:20'))
  await hook(1, 1, 'turn_started', t('08:30'))
  // a compaction in the middle of a turn does not end it
  await hook(1, 1, 'session_started', t('08:34'), { source: 'compact' })
  await hook(1, 1, 'turn_ended', t('08:40'))
  await hook(1, 1, 'turn_started', t('08:50'))
  await hook(1, 1, 'turn_ended', t('08:55'))
  // 08:07 to 08:10 waited for a slot, 08:10 to 08:15 ran (inside the turn that began at 08:00)
  await step(t('08:15'), 'app check-fast', '/src/app', '/w/factory-1-1/sub', 5, 3, 0, 900)
  await sql`INSERT INTO factory.merge_windows (project, cwd, requested_at, acquired_at, released_at, exit_code)
    VALUES ('app', '/w/factory-1-1', ${t('08:35')}, ${t('08:38')}, ${t('08:50')}, 0)`
  await ciRun(101, 'app', 'factory/1-1', t('08:40'), t('08:42'), t('08:52'), 'success')

  // Issue 2 (lib): no hook, a step known by its name only (an old row has no directory)
  await issue(2, 'lib', [
    [t('09:50'), 'queued'],
    [t('10:00'), 'working'],
    [t('10:30'), 'closed'],
  ])
  await attempt(2, 1, t('10:00'), '/w/factory-2-1')
  await step(t('10:10'), 'factory-2-1 check-fast', '/src/lib', null, 4, 1, 0, 500)

  // Issue 3 (app) closed before the window; Issue 4 (app) closed in it, its lead never started
  await issue(3, 'app', [
    [t('07:00', '11-05'), 'working'],
    [t('08:00', '11-05'), 'closed'],
  ])
  await attempt(3, 1, t('07:00', '11-05'), '/w/factory-3-1')
  await issue(4, 'app', [
    [t('08:00'), 'queued'],
    [t('11:00'), 'closed'],
  ])
  await attempt(4, 1, null, '/w/factory-4-1')

  // Issue 5 (app) closed twice: the second wall starts with the attempt after the first close
  await issue(5, 'app', [
    [t('12:30', '11-06'), 'queued'],
    [t('13:00', '11-06'), 'working'],
    [t('14:00', '11-06'), 'closed'],
    [t('09:20'), 'working'],
    [t('10:00'), 'closed'],
  ])
  await attempt(5, 1, t('13:00', '11-06'), '/w/factory-5-1')
  await attempt(5, 2, t('09:30'), '/w/factory-5-2')

  // the owner's own steps and runs: no worktree
  await step(t('11:00'), 'app check', '/src/app', null, 10, 0, 1, 2000)
  await ciRun(102, 'app', 'master', t('07:00'), t('07:01'), t('07:11'), 'failure')
  await ciRun(103, 'app', 'master', t('07:30'), t('07:31'), t('07:40'), 'cancelled')
  await ciRun(104, 'app', 'master', t('06:00', '11-05'), t('06:01', '11-05'), t('06:10', '11-05'), 'success')
}

type Split = ThroughputModel['lead']['issues'][number]['split']
const read = async () => ThroughputModel.parse(await readThroughput(sql, { now: NOW, hours: HOURS }))
const sum = (s: Split) =>
  s.ownerSeconds + s.stepSeconds + s.slotWaitSeconds + s.mergeLockSeconds + s.ciSeconds + s.turnSeconds + s.idleSeconds

describe('the lead time split', () => {
  test('takes the Issues closed in the window with a lead that started, one row per close', async () => {
    const model = await read()
    expect(model.lead.issues.map((i) => [i.issue, i.closedAt, i.wallSeconds])).toEqual([
      ['issue_1', '2026-11-07T09:00:00.000Z', 3600],
      ['issue_5', '2026-11-06T14:00:00.000Z', 3600],
      ['issue_2', '2026-11-07T10:30:00.000Z', 1800],
      ['issue_5', '2026-11-07T10:00:00.000Z', 1800],
    ])
    expect(model.lead.closed).toBe(4)
    expect(model.lead.wallSeconds).toBe(10800)
  })

  test('puts every minute of an Issue in one place, the earlier place winning', async () => {
    const [one] = (await read()).lead.issues
    expect(one?.split).toEqual({
      ownerSeconds: 600, // 08:20 to 08:30 on a Decision
      stepSeconds: 300, // 08:10 to 08:15
      slotWaitSeconds: 180, // 08:07 to 08:10
      mergeLockSeconds: 180, // 08:35 to 08:38, inside a turn
      ciSeconds: 720, // 08:40 to 08:52, past the lock's hold and into the last turn
      turnSeconds: 1320, // 08:00-08:20 less 8 min, 08:30-08:40 less 3 min, 08:52-08:55
      idleSeconds: 300, // 08:55 to 09:00
    })
  })

  test('takes a step by its name when its row has no directory, and leaves a lead with no turn idle', async () => {
    const two = (await read()).lead.issues.find((i) => i.issue === 'issue_2')
    expect(two?.split).toEqual({
      ownerSeconds: 0,
      stepSeconds: 240,
      slotWaitSeconds: 60,
      mergeLockSeconds: 0,
      ciSeconds: 0,
      turnSeconds: 0,
      idleSeconds: 1500,
    })
  })

  test('the split of every Issue sums to its wall within 2%, and so does the total', async () => {
    const model = await read()
    for (const i of model.lead.issues)
      expect(Math.abs(sum(i.split) - i.wallSeconds)).toBeLessThanOrEqual(i.wallSeconds * 0.02)
    expect(Math.abs(sum(model.lead.split) - model.lead.wallSeconds)).toBeLessThanOrEqual(model.lead.wallSeconds * 0.02)
  })

  test('agrees with the wall walked minute by minute in plain SQL', async () => {
    const model = await read()
    const rows: { issue_id: string; closed_at: Date; place: string; minutes: string }[] = await sql`
      WITH closings AS (
        SELECT issue_id, at AS closed_at, lag(at) OVER (PARTITION BY issue_id ORDER BY version) AS prev
        FROM factory.issue_events WHERE result = 'applied' AND to_state = 'closed'),
      wall AS (
        SELECT c.issue_id, c.closed_at, min(a.started_at) AS s
        FROM closings c JOIN factory.lead_attempts a ON a.issue_id = c.issue_id
        WHERE a.started_at IS NOT NULL AND a.started_at < c.closed_at AND (c.prev IS NULL OR a.started_at > c.prev)
          AND c.closed_at >= ${FROM} AND c.closed_at < ${NOW}
        GROUP BY c.issue_id, c.closed_at),
      minutes AS (
        SELECT w.issue_id, w.closed_at, m
        FROM wall w, generate_series(w.s, w.closed_at - interval '1 minute', interval '1 minute') AS m)
      SELECT issue_id, closed_at, place, count(*) AS minutes FROM (
        SELECT issue_id, closed_at, m,
          CASE
            WHEN EXISTS (SELECT 1 FROM (
                SELECT at AS s, lead(at) OVER (ORDER BY version) AS e, to_state, wait->>'reason' AS reason
                FROM factory.issue_events x WHERE x.issue_id = minutes.issue_id AND x.result = 'applied') st
              WHERE st.to_state = 'waiting' AND st.reason IN ('decision', 'review', 'errand', 'external')
                AND st.s <= m AND m < st.e) THEN 'owner'
            WHEN EXISTS (SELECT 1 FROM factory.step_costs s
              JOIN factory.lead_attempts a ON a.issue_id = minutes.issue_id
              WHERE (s.cwd LIKE a.worktree_path || '/%' OR s.cwd = a.worktree_path OR s.name LIKE 'factory-' || substring(a.issue_id FROM 7) || '-%')
                AND s.at - s.duration_ms * interval '1 millisecond' <= m AND m < s.at) THEN 'step'
            WHEN EXISTS (SELECT 1 FROM factory.step_costs s
              JOIN factory.lead_attempts a ON a.issue_id = minutes.issue_id
              WHERE (s.cwd LIKE a.worktree_path || '/%' OR s.cwd = a.worktree_path OR s.name LIKE 'factory-' || substring(a.issue_id FROM 7) || '-%')
                AND s.at - (s.duration_ms + s.wait_ms) * interval '1 millisecond' <= m
                AND m < s.at - s.duration_ms * interval '1 millisecond') THEN 'slot'
            WHEN EXISTS (SELECT 1 FROM factory.merge_windows k
              JOIN factory.lead_attempts a ON a.issue_id = minutes.issue_id
              WHERE (k.cwd LIKE a.worktree_path || '/%' OR k.cwd = a.worktree_path)
                AND k.requested_at <= m AND m < coalesce(k.acquired_at, k.released_at)) THEN 'lock'
            WHEN EXISTS (SELECT 1 FROM factory.ci_runs r
              JOIN factory.lead_attempts a ON a.issue_id = minutes.issue_id AND a.branch = r.head_branch
              WHERE r.queued_at <= m AND m < r.finished_at) THEN 'ci'
            WHEN EXISTS (SELECT 1 FROM (
                SELECT kind, at AS s, lead(at) OVER (PARTITION BY session ORDER BY at, seq) AS e
                FROM factory.lead_hook_events h
                WHERE h.issue_id = minutes.issue_id AND (h.kind IN ('turn_started', 'turn_ended')
                  OR (h.kind = 'session_started' AND h.payload->>'source' IS DISTINCT FROM 'compact'))) tr
              WHERE tr.kind = 'turn_started' AND tr.s <= m AND m < tr.e) THEN 'turn'
            ELSE 'idle'
          END AS place
        FROM minutes) placed
      GROUP BY issue_id, closed_at, place`
    expect(rows.length).toBeGreaterThan(0)
    const seconds = (issue: string, closedAt: Date, place: string) =>
      Number(
        rows.find((r) => r.issue_id === issue && r.closed_at.getTime() === closedAt.getTime() && r.place === place)
          ?.minutes ?? 0,
      ) * 60
    for (const i of model.lead.issues) {
      const closed = new Date(i.closedAt)
      expect(i.split).toEqual({
        ownerSeconds: seconds(i.issue, closed, 'owner'),
        stepSeconds: seconds(i.issue, closed, 'step'),
        slotWaitSeconds: seconds(i.issue, closed, 'slot'),
        mergeLockSeconds: seconds(i.issue, closed, 'lock'),
        ciSeconds: seconds(i.issue, closed, 'ci'),
        turnSeconds: seconds(i.issue, closed, 'turn'),
        idleSeconds: seconds(i.issue, closed, 'idle'),
      })
    }
  })
})

describe('the project scorecard', () => {
  const find = async (repo: string) => (await read()).project.find((p) => p.repo === repo)

  test('a project with steps, a CI run, a merge window and a close carries them all', async () => {
    const app = await find('app')
    expect(app).toEqual({
      repo: 'app',
      closedIssues: 3, // issues 1, 4 and 5; the second close of issue 5 is the same Issue, the first is in the window too
      slot: {
        steps: 2,
        minutes: 15,
        minutesPerClosedIssue: 5,
        waitMinutes: 3,
        waitP50Ms: 90_000,
        waitP90Ms: 162_000,
        peakMib: 2000,
        failedSteps: 1,
        failedMinutes: 10,
      },
      check: {
        tiers: [
          { tier: 'full', runs: 1, p50Ms: 600_000, p90Ms: 600_000 },
          { tier: 'fast', runs: 1, p50Ms: 300_000, p90Ms: 300_000 },
        ],
      },
      ci: { runs: 2, minutes: 20, queueMinutes: 3, p50Minutes: 10, p90Minutes: 10, failedRuns: 1, failedMinutes: 10 },
      localToCi: { localMinutes: 15, ciMinutes: 20, localShare: 0.4286 },
      mergeLock: { windows: 1, waitMinutes: 3, holdMinutes: 12 },
      leadTime: {
        closed: 3,
        wallSeconds: 9000,
        split: {
          ownerSeconds: 600,
          stepSeconds: 300,
          slotWaitSeconds: 180,
          mergeLockSeconds: 180,
          ciSeconds: 720,
          turnSeconds: 1320,
          idleSeconds: 5700,
        },
      },
    })
  })

  test('a project with only a step and a lead has no CI and no window, and its figures are null, not 0', async () => {
    const lib = await find('lib')
    expect(lib?.ci).toEqual({
      runs: 0,
      minutes: 0,
      queueMinutes: 0,
      p50Minutes: null,
      p90Minutes: null,
      failedRuns: 0,
      failedMinutes: 0,
    })
    expect(lib?.mergeLock).toEqual({ windows: 0, waitMinutes: 0, holdMinutes: 0 })
    expect(lib?.localToCi).toEqual({ localMinutes: 4, ciMinutes: 0, localShare: 1 })
    expect(lib?.slot.minutesPerClosedIssue).toBe(4)
    expect(lib?.check.tiers).toEqual([{ tier: 'fast', runs: 1, p50Ms: 240_000, p90Ms: 240_000 }])
  })

  test('the projects are listed by slot minutes, then name', async () => {
    expect((await read()).project.map((p) => p.repo)).toEqual(['app', 'lib'])
  })
})
