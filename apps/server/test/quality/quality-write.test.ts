import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import { postgresQualityStore } from '../../src/adapters/quality/store.ts'
import { fileIssue, recordIssueEvent } from '../../src/app/issues.ts'
import { runOutbox } from '../../src/app/outbox.ts'
import { showQuality } from '../../src/app/quality-read.ts'
import { reopenIssue } from '../../src/app/quality-reopen.ts'
import { type QualityUnit, type ShipDeps, shipIssue } from '../../src/app/quality-ship.ts'
import { checkWatches, startWatchPort, type WatchDeps } from '../../src/app/quality-watch.ts'
import type { AcceptanceEvidence, CommitRead, ReviewRead } from '../../src/domains/quality/evidence.ts'
import type {
  AttemptCheckout,
  Ci,
  Commits,
  LeadCheckout,
  Projects,
  Proof,
  Review,
} from '../../src/domains/quality/ports.ts'
import type { Check, ProjectChecks } from '../../src/domains/quality/watch.ts'
import type { AnyIssueEvent, EventKind, IssueEvent } from '../../src/domains/work/events.ts'
import type { EffectPorts } from '../../src/domains/work/ports.ts'
import { fixedClock } from '../../src/kernel/clock.ts'
import type { Actor } from '../../src/kernel/events.ts'
import { type IssueId, issueId as issueIdOf, sequentialIds } from '../../src/kernel/ids.ts'
import { key } from '../../src/kernel/keys.ts'
import { err, ok, portError, type Result } from '../../src/kernel/result.ts'

let db: TestCluster
beforeAll(async () => {
  db = await startTestCluster()
})
afterAll(async () => {
  await db.stop()
})

const clock = fixedClock('2026-03-01T12:00:00Z')
let ids = sequentialIds()
let uow: QualityUnit
const SHA = 'a'.repeat(40)

/** The fakes of the ports, each recording whether it was called inside a transaction. */
let inside: string[]
let commitReads: number
let commitAnswer: Result<CommitRead>
let reviewAnswer: Result<ReviewRead>
let checkoutAnswer: Result<AttemptCheckout | null>
let projectsSeen: string[]
let commitRepos: string[]
let proofAnswer: () => Result<Check[]>
let proofRuns: number
let duringProof: () => Promise<void>
let project: ProjectChecks

const landed = (extra: Partial<CommitRead> = {}): CommitRead => ({
  landedAt: 'f'.repeat(40),
  commits: [SHA],
  paths: ['src/a.ts'],
  mergedAt: new Date('2026-03-01T11:59:00Z'),
  reviewRanges: [{ base: 'b'.repeat(40), head: SHA }],
  ...extra,
})

const watch = (): Pick<Projects, 'checksOf'> => ({
  checksOf: async (repo) => {
    projectsSeen.push(repo)
    if (uow.inTransaction()) inside.push('projects')
    return ok(project)
  },
})

const commits: Commits = {
  read: async (input) => {
    commitReads++
    commitRepos.push(input.repo)
    if (uow.inTransaction()) inside.push('commits')
    return commitAnswer
  },
}
const review: Review = {
  read: async () => {
    if (uow.inTransaction()) inside.push('review')
    return reviewAnswer
  },
}
const checkout: LeadCheckout = {
  of: async () => {
    if (uow.inTransaction()) inside.push('checkout')
    return checkoutAnswer
  },
}
const proof: Proof = {
  run: async () => {
    proofRuns++
    if (uow.inTransaction()) inside.push('proof')
    await duringProof()
    return proofAnswer()
  },
}

const ci: Ci = {
  ofShip: async () => {
    if (uow.inTransaction()) inside.push('ci')
    return err(portError('refused', 'no token'))
  },
  ofCommit: async () => err(portError('refused', 'no token')),
}
const deps = (): ShipDeps => ({ uow, clock, ids, commits, review, ci, projects: watch(), checkout })
const watchDeps = (extra: Partial<WatchDeps> = {}): WatchDeps => ({
  uow,
  clock,
  ids,
  projects: watch(),
  checkout,
  proof,
  timing: { retryMs: 60_000, recheckMs: 300_000 },
  settledAt: new Date(0),
  signal: new AbortController().signal,
  ...extra,
})

beforeEach(async () => {
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
  clock.set(new Date('2026-03-01T12:00:00Z'))
  ids = sequentialIds()
  uow = postgresUnitOfWork(db.sql, (tx) => ({ work: postgresWorkStore(tx), quality: postgresQualityStore(tx) }))
  inside = []
  commitReads = 0
  commitAnswer = ok(landed())
  reviewAnswer = ok({ tier: 'standard', covered: true, uncovered: [] })
  checkoutAnswer = ok(null)
  projectsSeen = []
  commitRepos = []
  proofAnswer = () => ok([{ name: 'make verify', ok: true, detail: 'exit 0' }])
  proofRuns = 0
  duringProof = async () => {}
  project = { windowMs: 30 * 60_000, deployMode: 'none', makeVerify: true, ci: true, probes: [] }
})

const value = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

const ev = <K extends EventKind>(kind: K, payload: IssueEvent<K>['payload'], actor: Actor) =>
  ({ kind, payload, actor }) as AnyIssueEvent

const record = async (issueId: IssueId, name: string, event: AnyIssueEvent) =>
  value(await recordIssueEvent({ uow, clock, ids }, { issueId, key: key(name, issueId), event }))

/** An Issue whose attempt 1 has a lead working. */
async function working(extra: { checkpoint?: 'spec' } = {}): Promise<IssueId> {
  const filed = ev(
    'filed',
    { repo: '/repo/example', title: 'the probe fails', kind: 'bug', origin: 'you', ...extra },
    'factory',
  )
  if (filed.kind !== 'filed') throw new Error('unreachable')
  const { issue } = value(await fileIssue({ uow, clock, ids }, { key: key('filed', ids.next('signal')), event: filed }))
  await record(issue.id, 'settled', ev('settled', {}, 'factory'))
  await record(issue.id, 'admitted', ev('admitted', {}, 'factory'))
  await record(issue.id, 'lead_started', ev('lead_started', { attempt: 1, terminal: 'lead-1' }, 'factory'))
  return issue.id
}

const ship = (
  issueId: IssueId,
  call = 'call-1',
  attempt = 1,
  named = [SHA],
  acceptance: AcceptanceEvidence = { statements: [] },
) => shipIssue(deps(), { issueId, attempt, call, commits: named, acceptance })

const stateOf = async (issueId: IssueId) => {
  const [row] = await db.sql`SELECT state, wait_reason, outcome, version FROM factory.issues WHERE id = ${issueId}`
  return row as { state: string; wait_reason: string | null; outcome: string | null; version: number }
}

const outbox = (issueId: IssueId) =>
  db.sql`SELECT kind, done_at IS NOT NULL AS done FROM factory.issue_effects WHERE issue_id = ${issueId} ORDER BY version, position`

/** Runs the outbox with the watch's real port and nothing else to do. */
async function runEffects(): Promise<void> {
  const nothing = async () => ok(undefined)
  const ports: EffectPorts = {
    start_lead: nothing,
    note_lead: nothing,
    finalize: nothing,
    start_watch: startWatchPort({ uow, clock, projects: watch(), checkout }),
  }
  // One effect per Issue per pass, in order: run until nothing is left.
  for (let pass = 0; pass < 10; pass++) {
    if (value(await runOutbox({ uow, clock, ports })).ran === 0) return
  }
  throw new Error('the outbox did not drain')
}

describe('the ship gate', () => {
  test('a flagged Issue is refused with no Spec, never asks git, and ships once a Spec is submitted', async () => {
    const id = await working({ checkpoint: 'spec' })
    const refused = value(await ship(id))
    expect(refused.result).toBe('refused')
    expect(refused.detail).toContain('checkpoint `spec`')
    expect(refused.detail).toContain('factory artifact submit --kind spec')
    expect(commitReads).toBe(0)
    expect((await stateOf(id)).state).toBe('working')

    // a Concept is not a Spec: the checkpoint wants the one-page Spec
    await db.sql`
      INSERT INTO factory.artifacts (id, key, issue_id, kind, title, format, author, created_at)
      VALUES ('artifact_c', 'k-c', ${id}, 'concept', 'a concept', 'markdown', 'lead', ${clock.now()})`
    expect(value(await ship(id, 'call-2')).result).toBe('refused')

    await db.sql`
      INSERT INTO factory.artifacts (id, key, issue_id, kind, title, format, author, created_at)
      VALUES ('artifact_s', 'k-s', ${id}, 'spec', 'the Spec', 'markdown', 'lead', ${clock.now()})`
    const accepted = value(await ship(id, 'call-3'))
    expect(accepted.result).toBe('applied')
    expect(commitReads).toBe(1)
    expect((await stateOf(id)).state).toBe('watching')
  })

  test('a refusal for the missing Spec is a refused ship on the record, counted as a refusal', async () => {
    const id = await working({ checkpoint: 'spec' })
    await ship(id)
    const [row] = await db.sql`SELECT result, detail FROM factory.quality_ships WHERE issue_id = ${id}`
    expect(row).toMatchObject({ result: 'refused' })
    expect(String(row.detail)).toContain('no Spec was submitted')
  })

  test('an Issue without the checkpoint ships with no Spec', async () => {
    const id = await working()
    expect(value(await ship(id)).result).toBe('applied')
  })

  test('a project that ships by push records no CI evidence and never asks GitHub', async () => {
    project = { ...project, ci: false }
    const issueId = await working()
    const shipped = value(await ship(issueId))
    expect(shipped.result).toBe('applied')
    expect(shipped.evidence.map((e) => e.kind)).toEqual(['commits', 'review', 'acceptance'])
    expect(inside).not.toContain('ci')
  })

  test('merged commits are evidence: the ship records them, its review and the Issue watching', async () => {
    const issueId = await working()
    const shipped = value(await ship(issueId))
    expect(shipped).toMatchObject({ result: 'applied', detail: null, issue: { state: 'watching', watch: 1 } })
    expect(shipped.evidence.map((e) => e.kind)).toEqual(['commits', 'review', 'acceptance', 'ci'])
    expect(shipped.evidence[0]).toMatchObject({ payload: { commits: [SHA], landedAt: 'f'.repeat(40), deploys: true } })
    expect(shipped.evidence[1]).toMatchObject({ payload: { status: 'covered', tier: 'standard' } })
    // a CI the port could not read is recorded as unknown, with why, and the ship stands
    expect(shipped.evidence[3]).toMatchObject({
      kind: 'ci',
      payload: { status: 'unknown', pr: null, reason: 'CI could not be read: no token' },
    })
    expect((await stateOf(issueId)).state).toBe('watching')
    expect((await outbox(issueId)).map((e: { kind: string }) => e.kind)).toContain('start_watch')
    const view = value(await showQuality({ uow }, issueId))
    expect(view.ships.map((s) => [s.result, s.attempt, s.evidence.length])).toEqual([['accepted', 1, 4]])
  })

  test('what the ship states against the acceptance is evidence; stating nothing is recorded as empty', async () => {
    const stated = await working()
    const one = value(
      await ship(stated, 'call-1', 1, [SHA], {
        statements: [
          { status: 'met', text: 'the page shows it' },
          { status: 'not_met', text: 'no time' },
        ],
      }),
    )
    expect(one.evidence[2]).toMatchObject({
      kind: 'acceptance',
      payload: {
        statements: [
          { status: 'met', text: 'the page shows it' },
          { status: 'not_met', text: 'no time' },
        ],
      },
    })
    const replay = value(await ship(stated, 'call-1'))
    expect(replay.result).toBe('replayed')
    expect(replay.evidence[2]).toEqual(one.evidence[2])
    const silent = value(await ship(await working(), 'call-2'))
    expect(silent.evidence[2]).toMatchObject({ kind: 'acceptance', payload: { statements: [] } })
  })

  test('a ship that names no commit is refused with its error named, and the refusal is stored', async () => {
    const issueId = await working()
    const refused = value(await ship(issueId, 'call-1', 1, []))
    expect(refused).toMatchObject({ result: 'refused', detail: 'ship refused: ship names no merged commit' })
    expect(commitReads).toBe(0)
    expect((await stateOf(issueId)).state).toBe('working')
    const view = value(await showQuality({ uow }, issueId))
    expect(view.ships).toMatchObject([
      { result: 'refused', detail: 'ship refused: ship names no merged commit', evidence: [] },
    ])
    expect(await db.sql`SELECT 1 FROM factory.issue_events WHERE kind = 'shipped'`).toHaveLength(0)
  })

  test('commits git refuses are refused with git’s reason, and the same call may try again', async () => {
    const issueId = await working()
    commitAnswer = err(portError('refused', `commit ${SHA.slice(0, 12)} is not on origin/master: merge it first`))
    const refused = value(await ship(issueId))
    expect(refused.detail).toBe(`ship refused: commit ${SHA.slice(0, 12)} is not on origin/master: merge it first`)
    commitAnswer = ok(landed())
    const accepted = value(await ship(issueId))
    expect(accepted.result).toBe('applied')
    const view = value(await showQuality({ uow }, issueId))
    expect(view.ships.map((s) => s.result)).toEqual(['refused', 'accepted'])
  })

  test('a git that cannot answer refuses the ship, saying so', async () => {
    const issueId = await working()
    commitAnswer = err(portError('timeout', 'git fetch did not finish in time'))
    expect(value(await ship(issueId)).detail).toBe(
      'ship refused: the commits could not be read: git fetch did not finish in time',
    )
    checkoutAnswer = err(portError('gone', 'no such worktree'))
    expect(value(await ship(issueId, 'call-2')).detail).toBe(
      "ship refused: the lead's checkout could not be read: no such worktree",
    )
  })

  test('a ship without a review is accepted, and the absence is recorded with its reason (NL23)', async () => {
    const issueId = await working()
    reviewAnswer = err(portError('refused', 'agw review covered exited 1'))
    const shipped = value(await ship(issueId))
    expect(shipped.result).toBe('applied')
    expect(shipped.evidence[1]).toMatchObject({
      kind: 'review',
      payload: { status: 'unknown', tier: null, reason: 'review could not be read: agw review covered exited 1' },
    })
    expect((await stateOf(issueId)).state).toBe('watching')
  })

  test('a review that does not cover the range is evidence of its own absence, not a refusal', async () => {
    const issueId = await working()
    reviewAnswer = ok({
      tier: 'deep',
      covered: false,
      uncovered: [{ sha: SHA, subject: 'feat: a', required: 'deep', reason: 'an important finding is open' }],
    })
    const shipped = value(await ship(issueId))
    expect(shipped.evidence[1]).toMatchObject({ payload: { status: 'uncovered', tier: 'deep' } })
    expect((await stateOf(issueId)).state).toBe('watching')
  })

  test('the same call again is a replay: git is not asked and nothing doubles', async () => {
    const issueId = await working()
    value(await ship(issueId))
    const reads = commitReads
    const again = value(await ship(issueId))
    expect(again).toMatchObject({ result: 'replayed', issue: { state: 'watching', version: 5 } })
    expect(again.evidence.map((e) => e.kind)).toEqual(['commits', 'review', 'acceptance', 'ci'])
    expect(commitReads).toBe(reads)
    const [counts] = await db.sql`
      SELECT (SELECT count(*) FROM factory.quality_ships)::int AS ships, (SELECT count(*) FROM factory.quality_evidence)::int AS evidence,
             (SELECT count(*) FROM factory.issue_effects WHERE kind = 'start_watch')::int AS watches`
    expect(counts).toEqual({ ships: 1, evidence: 4, watches: 1 })
  })

  test('the Issue refusing the ship is the verb’s error: another attempt, or a closed Issue', async () => {
    const issueId = await working()
    const wrong = value(await ship(issueId, 'call-1', 2))
    expect(wrong.result).toBe('refused')
    expect(wrong.detail).toContain('attempt 2')
    await record(issueId, 'cancelled', ev('cancelled', { reason: 'no longer wanted' }, 'owner'))
    const closed = value(await ship(issueId, 'call-2'))
    expect(closed).toMatchObject({ result: 'refused', detail: 'it is closed: reopen it first' })
    const view = value(await showQuality({ uow }, issueId))
    expect(view.ships.map((s) => s.result)).toEqual(['refused', 'refused'])
    expect(view.ships.every((s) => s.evidence.length === 0)).toBe(true)
  })

  test('an unknown Issue is an error, not a refusal', async () => {
    const result = await ship(issueIdOf(99))
    expect(result).toEqual({ ok: false, error: { kind: 'unknown_issue', issueId: issueIdOf(99) } })
  })

  test('the lead’s checkout says where the work is: the directory, not the Issue’s repo name; the cut and branch go to git', async () => {
    const issueId = await working()
    checkoutAnswer = ok({ repo: '/roots/example', branch: 'factory/issue_1-1', cut: 'c'.repeat(40) })
    const seen: unknown[] = []
    const spy: Commits = {
      read: async (input) => {
        seen.push(input)
        return commitAnswer
      },
    }
    value(
      await shipIssue(
        { ...deps(), commits: spy },
        { issueId, attempt: 1, call: 'call-1', commits: [SHA], acceptance: { statements: [] } },
      ),
    )
    expect(seen).toEqual([
      { repo: '/roots/example', branch: 'factory/issue_1-1', cut: 'c'.repeat(40), reported: [SHA] },
    ])
    // The watch runs in that directory too.
    await runEffects()
    clock.advance(30 * 60_000)
    const proofSeen: string[] = []
    const spyProof: Proof = {
      run: async (input) => {
        proofSeen.push(input.repo)
        return ok([])
      },
    }
    value(await checkWatches(watchDeps({ proof: spyProof })))
    expect(proofSeen).toEqual(['/roots/example'])
    expect(new Set(projectsSeen)).toEqual(new Set(['/roots/example']))
  })

  test('git, agw and the lead’s checkout are never called inside a transaction', async () => {
    const issueId = await working()
    value(await ship(issueId))
    expect(inside).toEqual([])
  })
})

describe('the watch', () => {
  /** A shipped Issue with its watch opened by the outbox. */
  async function watching(): Promise<IssueId> {
    const issueId = await working()
    value(await ship(issueId))
    await runEffects()
    return issueId
  }

  const watchRow = async () => {
    const [row] = await db.sql`SELECT key, window_ms::int AS window_ms, answer FROM factory.quality_watches`
    return row as { key: string; window_ms: number; answer: string | null } | undefined
  }

  test('the start_watch effect opens the watch with the project’s window, once', async () => {
    const issueId = await watching()
    expect(await watchRow()).toEqual({ key: `start_watch:${issueId}:1`, window_ms: 30 * 60_000, answer: null })
    await db.sql`UPDATE factory.issue_effects SET done_at = NULL WHERE kind = 'start_watch'`
    project = { ...project, windowMs: 1 }
    await runEffects()
    expect(await db.sql`SELECT 1 FROM factory.quality_watches`).toHaveLength(1)
    expect((await watchRow())?.window_ms).toBe(30 * 60_000)
    expect(inside).toEqual([])
  })

  test('nothing runs before the window is over; then verify passes and the Issue closes done', async () => {
    const issueId = await watching()
    expect(value(await checkWatches(watchDeps()))).toEqual({ checked: 0, passed: 0, regressed: 0 })
    clock.advance(29 * 60_000)
    expect(value(await checkWatches(watchDeps())).checked).toBe(0)
    expect(proofRuns).toBe(0)
    clock.advance(60_000)
    expect(value(await checkWatches(watchDeps()))).toEqual({ checked: 1, passed: 1, regressed: 0 })
    expect(await stateOf(issueId)).toMatchObject({ state: 'closed', outcome: 'done' })
    expect((await watchRow())?.answer).toBe('passed')
    const view = value(await showQuality({ uow }, issueId))
    expect(view.watches[0]?.checks).toMatchObject([{ n: 1, outcome: 'green' }])
    expect(view.ships[0]?.evidence.map((e) => e.kind)).toEqual(['commits', 'review', 'acceptance', 'ci'])
    expect(inside).toEqual([])
  })

  test('a pass over a watch that is answered runs nothing: a replayed tick does nothing twice', async () => {
    await watching()
    clock.advance(30 * 60_000)
    value(await checkWatches(watchDeps()))
    value(await checkWatches(watchDeps()))
    expect(proofRuns).toBe(1)
    expect(await db.sql`SELECT 1 FROM factory.issue_events WHERE kind = 'watch_passed'`).toHaveLength(1)
  })

  test('two passes at once run verify once: the watch is claimed', async () => {
    await watching()
    clock.advance(30 * 60_000)
    duringProof = () => Bun.sleep(50)
    const [one, two] = await Promise.all([checkWatches(watchDeps()), checkWatches(watchDeps())])
    expect(value(one).checked + value(two).checked).toBe(1)
    expect(proofRuns).toBe(1)
  })

  test('no check before the server has settled: a restart is a deploy', async () => {
    await watching()
    clock.advance(30 * 60_000)
    const settledAt = new Date(clock.now().getTime() + 120_000)
    expect(value(await checkWatches(watchDeps({ settledAt }))).checked).toBe(0)
    expect(proofRuns).toBe(0)
    clock.advance(120_000)
    expect(value(await checkWatches(watchDeps({ settledAt }))).checked).toBe(1)
  })

  test('a red check is retried 1, 2 and 4 minutes later; the red after the last retry regresses to the lead', async () => {
    const issueId = await watching()
    proofAnswer = () => ok([{ name: 'make verify', ok: false, detail: 'exit 1: boom' }])
    clock.advance(30 * 60_000)
    const times: number[] = []
    for (let minutes = 0; minutes <= 8; minutes++) {
      const pass = value(await checkWatches(watchDeps()))
      if (pass.checked > 0) times.push(minutes)
      if (pass.regressed > 0) break
      clock.advance(60_000)
    }
    expect(times).toEqual([0, 1, 3, 7])
    expect(await stateOf(issueId)).toMatchObject({ state: 'working', outcome: null })
    const [regressed] = await db.sql`SELECT payload FROM factory.issue_events WHERE kind = 'regressed'`
    expect(regressed?.payload).toEqual({ watch: 1, detail: 'make verify failed: exit 1: boom' })
    expect((await watchRow())?.answer).toBe('regressed')
    const view = value(await showQuality({ uow }, issueId))
    expect(view.watches[0]?.checks.map((c) => c.outcome)).toEqual(['red', 'red', 'red', 'red'])
  })

  test('a red that clears on a retry passes: a flaky probe never reaches the lead', async () => {
    const issueId = await watching()
    let first = true
    proofAnswer = () => {
      const ok1 = !first
      first = false
      return ok([{ name: 'probe', ok: ok1, detail: ok1 ? 'HTTP 200' : 'HTTP 503' }])
    }
    clock.advance(30 * 60_000)
    expect(value(await checkWatches(watchDeps())).passed).toBe(0)
    clock.advance(60_000)
    expect(value(await checkWatches(watchDeps())).passed).toBe(1)
    expect(await stateOf(issueId)).toMatchObject({ state: 'closed', outcome: 'done' })
    expect(await db.sql`SELECT 1 FROM factory.issue_events WHERE kind = 'regressed'`).toHaveLength(0)
  })

  describe('a make target that was red before the ship', () => {
    const verifyRed = (n: number): Check => ({
      name: 'make verify',
      ok: false,
      detail: `exit 2: drift-check: ${n} pending macOS updates`,
    })

    /** Another Issue of the repo whose watch ran verify a few minutes before this Issue ships. */
    async function earlierWatch(checks: Check[]): Promise<void> {
      const other = await working()
      value(await ship(other, 'call-other'))
      await runEffects()
      clock.advance(5 * 60_000)
      await db.sql`
        INSERT INTO factory.quality_checks (watch_key, n, at, outcome, checks)
        VALUES (${`start_watch:${other}:1`}, 1, ${clock.now()}, ${checks.every((c) => c.ok) ? 'green' : 'red'},
                ${checks})`
      await db.sql`UPDATE factory.quality_watches SET answer = 'ended', answered_at = ${clock.now()} WHERE issue_id = ${other}`
      clock.advance(5 * 60_000)
    }

    async function regressesWith(now: Check[]): Promise<{ regressed: number; state: string }> {
      const issueId = await working()
      value(await ship(issueId))
      await runEffects()
      proofAnswer = () => ok(now)
      clock.advance(30 * 60_000)
      let regressed = 0
      for (let minutes = 0; minutes <= 8; minutes++) {
        regressed += value(await checkWatches(watchDeps())).regressed
        clock.advance(60_000)
      }
      return { regressed, state: (await stateOf(issueId)).state }
    }

    test('failing the same way is not the Issue’s regression: the watch passes and records the check as inherited', async () => {
      await earlierWatch([verifyRed(3)])
      const result = await regressesWith([verifyRed(7)])
      expect(result).toEqual({ regressed: 0, state: 'closed' })
      const [row] = await db.sql`
        SELECT c.checks, c.outcome FROM factory.quality_checks c
        JOIN factory.quality_watches w ON w.key = c.watch_key WHERE w.answer = 'passed'`
      expect(row?.outcome).toBe('green')
      expect(row?.checks).toMatchObject([{ name: 'make verify', ok: false, inherited: true }])
    })

    test('failing differently than before is still the Issue’s regression', async () => {
      await earlierWatch([verifyRed(3)])
      const result = await regressesWith([{ name: 'make verify', ok: false, detail: 'exit 1: a test broke' }])
      expect(result).toEqual({ regressed: 1, state: 'working' })
    })

    test('a green run before the ship leaves the red to the Issue', async () => {
      await earlierWatch([{ name: 'make verify', ok: true, detail: 'exit 0' }])
      const result = await regressesWith([verifyRed(7)])
      expect(result).toEqual({ regressed: 1, state: 'working' })
    })

    test('with no run before the ship the red is the Issue’s', async () => {
      expect(await regressesWith([verifyRed(7)])).toEqual({ regressed: 1, state: 'working' })
    })
  })

  test('twice back to the lead, the third regression is a stall', async () => {
    const issueId = await working()
    proofAnswer = () => ok([{ name: 'make verify', ok: false, detail: 'exit 1' }])
    const states: string[] = []
    for (let round = 1; round <= 3; round++) {
      value(await ship(issueId, `call-${round}`, 1, [SHA]))
      await runEffects()
      clock.advance(30 * 60_000)
      for (let i = 0; i < 12; i++) {
        if (value(await checkWatches(watchDeps())).regressed > 0) break
        clock.advance(60_000)
      }
      const now = await stateOf(issueId)
      states.push(`${now.state}${now.wait_reason ? `:${now.wait_reason}` : ''}`)
    }
    expect(states).toEqual(['working', 'working', 'waiting:regressed'])
  })

  test('a blocked checkout is neither a pass nor a regression: verify looks again later', async () => {
    const issueId = await watching()
    let blocked = true
    proofAnswer = () =>
      ok(
        blocked
          ? [{ name: 'checkout', ok: false, blocked: true, detail: 'the checkout is on another branch' }]
          : [{ name: 'make verify', ok: true, detail: 'exit 0' }],
      )
    clock.advance(30 * 60_000)
    expect(value(await checkWatches(watchDeps())).checked).toBe(1)
    clock.advance(60_000)
    expect(value(await checkWatches(watchDeps())).checked).toBe(0)
    blocked = false
    clock.advance(5 * 60_000)
    expect(value(await checkWatches(watchDeps())).passed).toBe(1)
    expect(await stateOf(issueId)).toMatchObject({ state: 'closed', outcome: 'done' })
    const view = value(await showQuality({ uow }, issueId))
    expect(view.watches[0]?.checks.map((c) => c.outcome)).toEqual(['blocked', 'green'])
  })

  test('an Issue cancelled while verify runs: the watch ends, nothing is recorded on the Issue', async () => {
    const issueId = await watching()
    clock.advance(30 * 60_000)
    duringProof = async () => {
      await record(issueId, 'cancelled', ev('cancelled', { reason: 'stop' }, 'owner'))
    }
    value(await checkWatches(watchDeps()))
    expect((await watchRow())?.answer).toBe('ended')
    expect(await stateOf(issueId)).toMatchObject({ state: 'closed', outcome: 'cancelled' })
    expect(await db.sql`SELECT 1 FROM factory.issue_events WHERE kind IN ('watch_passed', 'regressed')`).toHaveLength(0)
  })

  test('the version check reads what the ship found: landed commit and whether it deploys', async () => {
    const seen: unknown[] = []
    const spy: Proof = {
      run: async (input) => {
        seen.push(input.version)
        return ok([])
      },
    }
    project = { ...project, deployMode: 'make' }
    const issueId = await watching()
    clock.advance(30 * 60_000)
    value(await checkWatches(watchDeps({ proof: spy })))
    expect(seen).toEqual([{ landedAt: 'f'.repeat(40) }])
    expect((await stateOf(issueId)).state).toBe('closed')
  })

  test('a docs-only ship skips the version check; a ship that found no landed commit reds it', async () => {
    const seen: unknown[] = []
    const spy: Proof = {
      run: async (input) => {
        seen.push(input.version)
        return ok([])
      },
    }
    project = { ...project, deployMode: 'make' }
    const docs = await working()
    commitAnswer = ok(landed({ paths: ['docs/a.md'] }))
    value(await ship(docs))
    await runEffects()
    clock.advance(30 * 60_000)
    value(await checkWatches(watchDeps({ proof: spy })))
    expect(seen).toEqual([undefined])

    seen.length = 0
    const unlanded = await working()
    commitAnswer = ok(landed({ landedAt: null }))
    value(await ship(unlanded))
    await runEffects()
    clock.advance(30 * 60_000)
    value(await checkWatches(watchDeps({ proof: spy })))
    expect(seen).toEqual([
      { problem: 'the ship recorded no landed commit on origin to check the deployed version against' },
    ])
  })

  test('a stopping server records nothing: the next one checks again', async () => {
    const issueId = await watching()
    clock.advance(30 * 60_000)
    const stopping = new AbortController()
    duringProof = async () => stopping.abort()
    proofAnswer = () => err(portError('gone', 'the server is stopping'))
    value(await checkWatches(watchDeps({ signal: stopping.signal })))
    expect((await watchRow())?.answer).toBeNull()
    expect((await stateOf(issueId)).state).toBe('watching')
    duringProof = async () => {}
    proofAnswer = () => ok([{ name: 'make verify', ok: true, detail: 'exit 0' }])
    expect(value(await checkWatches(watchDeps())).passed).toBe(1)
  })
})

describe('reopen', () => {
  const closedIssue = async (): Promise<IssueId> => {
    const issueId = await working()
    value(await ship(issueId))
    await runEffects()
    clock.advance(30 * 60_000)
    value(await checkWatches(watchDeps()))
    return issueId
  }

  test('the owner reopens a closed Issue within 30 days: queued, and the same call is a replay', async () => {
    const issueId = await closedIssue()
    clock.advance(29 * 24 * 60 * 60_000)
    const first = value(await reopenIssue({ uow, clock, ids }, { issueId, call: 'r1', reason: 'it broke again' }))
    expect(first).toMatchObject({ result: 'applied', issue: { state: 'queued', outcome: null } })
    expect(
      value(await reopenIssue({ uow, clock, ids }, { issueId, call: 'r1', reason: 'it broke again' })).result,
    ).toBe('replayed')
  })

  test('past 30 days a reopen is refused: file a new Issue', async () => {
    const issueId = await closedIssue()
    clock.advance(31 * 24 * 60 * 60_000)
    const got = value(await reopenIssue({ uow, clock, ids }, { issueId, call: 'r1', reason: 'late' }))
    expect(got).toMatchObject({ result: 'refused', issue: { state: 'closed' } })
    expect(got.event.detail).toBe('closed more than 30 days ago: file a new Issue')
  })

  test('an Issue that is not closed cannot be reopened', async () => {
    const issueId = await working()
    const got = value(await reopenIssue({ uow, clock, ids }, { issueId, call: 'r1', reason: 'x' }))
    expect(got).toMatchObject({ result: 'refused', event: { detail: 'it is not closed' } })
  })
})
