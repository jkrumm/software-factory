import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Issue } from '@software-factory/contract'
import { BUDGET_HOURS, SILENT_AFTER_MS } from '../src/health.ts'
import { createIssue } from '../src/issues/create.ts'
import { enqueue } from '../src/issues/inbox.ts'
import { type Proof } from '../src/issues/hold.ts'
import { OffTick } from '../src/issues/offtick.ts'
import { getIssue } from '../src/issues/read.ts'
import type { StewardDeps } from '../src/issues/steward.ts'
import { fireTimers } from '../src/issues/timers.ts'
import { issuePass } from '../src/issues/worker.ts'
import { foldReason } from '../src/notify/outbox.ts'
import { DEFAULT_REVIEW_LIMITS } from '../src/review/limits.ts'
import { buildStatus } from '../src/status.ts'
import { TEST_REPO, TEST_ROOT } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { world } from './support/world.ts'

const MIN = 60_000
const HOUR = 60 * MIN

let db: TestDb
let clock: FakeClock
let w: ReturnType<typeof world>
let n = 0

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(async () => {
  await db.reset()
  clock = new FakeClock()
  w = world(db.sql, clock)
  n = 0
})

const now = () => clock.now()
const advance = (ms: number) => clock.advance(ms)

const NOTHING_REQUIRED = {
  commits: ['a'.repeat(40)],
  paths: ['docs/x.md'],
  required: [],
  mergedAt: null,
  holdMs: 30 * MIN,
  problem: null,
}

const send = (issueId: number, kind: string, payload?: Record<string, unknown>) =>
  enqueue(db.sql, {
    issueId,
    key: `${issueId}:${kind}:${++n}`,
    kind,
    at: clock.now(),
    payload:
      kind === 'close' || kind === 'ship'
        ? { derived: NOTHING_REQUIRED, commits: NOTHING_REQUIRED.commits, ...payload }
        : payload,
  })

const steward = (extra: Partial<StewardDeps> = {}): StewardDeps => ({ limits: DEFAULT_REVIEW_LIMITS, ...extra })
const pass = (deps: StewardDeps = steward()) => issuePass(db.sql, { now, ports: {}, steward: deps })

/** One report, handled. */
async function report(id: number, kind: string, payload: Record<string, unknown> = {}) {
  await send(id, kind, { attempt: 1, ...payload })
  expect(await pass()).toEqual([])
}

async function working(options: { size?: string } = {}): Promise<number> {
  const made = await createIssue(
    db.sql,
    { source: 'request', sourceKey: `k${++n}`, repo: TEST_REPO, title: 'a title', facts: {} },
    { repoRoots: [TEST_ROOT], now: clock.now() },
  )
  const id = made.issue.id
  if (options.size) await db.sql`UPDATE factory.issues SET size = ${options.size} WHERE id = ${id}`
  await send(id, 'admitted')
  expect(await pass()).toEqual([])
  return id
}

/** A live lead for the Issue's attempt: a started spawn and a session on a terminal of this core, with a first event. */
const lead = async (id: number, attempt = 1, startedMinutesAgo = 0) => {
  const key = `lead-${id}-${attempt}`
  await w.spawned(key, { role: 'lead', startedMinutesAgo })
  await db.sql`UPDATE factory.sessions SET pane = ${`t${id}${attempt}`} WHERE id = ${key}`
  await db.sql`UPDATE factory.spawns SET session = ${`t${id}${attempt}`} WHERE key = ${key}`
}

const state = async (id: number): Promise<Issue> => {
  const issue = await getIssue(db.sql, id)
  if (!issue) throw new Error(`no issue ${id}`)
  return issue
}
const acts = (id?: number) =>
  db.sql`SELECT key, kind, result, payload FROM factory.issue_inbox WHERE key LIKE 'steward:%' AND (${id ?? null}::integer IS NULL OR issue_id = ${id ?? null}) ORDER BY id`
const trail = async (id: number): Promise<string[]> => {
  const rows: { kind: string; from_state: string | null; to_state: string | null }[] =
    await db.sql`SELECT kind, from_state, to_state FROM factory.issue_events WHERE issue_id = ${id} ORDER BY id`
  return rows.map((r) => (r.to_state ? `${r.kind} ${r.from_state ?? '-'}→${r.to_state}` : r.kind))
}
const notifications = () => db.sql`SELECT key, kind, text FROM factory.notifications ORDER BY created_at, key`

describe('rule 1: a block with a live lead is woken', () => {
  test('a block whose cause clears is woken after 30 minutes, the lead closes, and the owner heard nothing', async () => {
    const id = await working()
    await lead(id)
    await report(id, 'block', { reason: 'waiting for the upstream fix' })
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'blocked' })

    advance(29 * MIN)
    await pass()
    expect(await acts()).toEqual([])

    advance(MIN)
    await pass()
    const [act, ...rest] = await acts()
    expect(rest).toEqual([])
    expect(act).toMatchObject({ key: `steward:${id}:blocked:1`, kind: 'note', result: 'applied' })
    expect(act.payload).toMatchObject({ who: 'steward', wake: true, cause: 'blocked', n: 1 })
    expect(act.payload.call).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(await state(id)).toMatchObject({ state: 'working' })
    expect(await trail(id)).toContain('note waiting→working')
    const [effect] = await db.sql`SELECT kind, key FROM factory.issue_effects WHERE kind = 'note_lead'`
    expect(effect.key).toBe(`note_lead:steward:${id}:blocked:1`)

    await report(id, 'close', { summary: 'done' })
    expect(await state(id)).toMatchObject({ state: 'closed', outcome: 'done' })
    expect(await notifications()).toEqual([])
  })

  test('running the pass twice in the same instant changes nothing', async () => {
    const id = await working()
    await lead(id)
    await report(id, 'block', { reason: 'r' })
    advance(30 * MIN)
    await pass()
    const before = [await acts(), await trail(id), await db.sql`SELECT count(*)::int AS n FROM factory.issue_inbox`]
    await pass()
    await pass()
    expect([await acts(), await trail(id), await db.sql`SELECT count(*)::int AS n FROM factory.issue_inbox`]).toEqual(
      before,
    )
  })

  test('a park by `unreported` and a `parked` one are woken on the same schedule', async () => {
    const id = await working()
    await lead(id)
    await report(id, 'unreported', {})
    expect(await state(id)).toMatchObject({ reason: 'unreported' })
    advance(30 * MIN)
    await pass()
    expect(await state(id)).toMatchObject({ state: 'working' })
    expect((await acts())[0]?.payload).toMatchObject({ cause: 'unreported' })

    await send(id, 'park')
    await pass()
    expect(await state(id)).toMatchObject({ reason: 'parked' })
    advance(30 * MIN)
    await pass()
    expect(await state(id)).toMatchObject({ state: 'working' })
    expect((await acts()).map((a: { payload: { cause: string } }) => a.payload.cause)).toEqual(['unreported', 'parked'])
  })

  test('a block with no live lead is left alone', async () => {
    const id = await working()
    await report(id, 'block', { reason: 'r' })
    advance(10 * HOUR)
    await pass()
    expect(await acts()).toEqual([])
  })

  test('backoff is 30 minutes, 2 hours, 6 hours from each time it blocked, at most 3 acts, then one line to the owner, once', async () => {
    const id = await working()
    await lead(id)
    const block = () => report(id, 'block', { reason: 'still stuck' })
    await block()
    advance(30 * MIN)
    await pass()
    expect(await acts()).toHaveLength(1)

    await block()
    advance(2 * HOUR - MIN)
    await pass()
    expect(await acts()).toHaveLength(1)
    advance(MIN)
    await pass()
    expect(await acts()).toHaveLength(2)

    await block()
    advance(6 * HOUR - MIN)
    await pass()
    expect(await acts()).toHaveLength(2)
    advance(MIN)
    await pass()
    expect(await acts()).toHaveLength(3)

    await block()
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'blocked' })
    advance(6 * HOUR - MIN)
    await pass()
    expect(await notifications()).toEqual([])
    advance(MIN)
    await pass()
    const [message, ...others] = await notifications()
    expect(others).toEqual([])
    expect(message).toMatchObject({ key: `notify:steward:${id}:blocked`, kind: 'failed' })
    expect(message.text).toContain('1. ')
    expect(message.text).toContain('3. ')
    expect(message.text).toContain(`factory issue show ${id}`)
    expect(await trail(id)).toContain('steward_exhausted')
    expect((await buildStatus(db.sql, clock.now())).steward?.exhausted).toBe(1)

    // replayed ticks and later ones: no fourth act, no second line
    for (let i = 0; i < 3; i++) {
      await pass()
      advance(12 * HOUR)
    }
    expect(await acts()).toHaveLength(3)
    expect(await notifications()).toHaveLength(1)
    const [counted] = await db.sql`SELECT count(*)::int AS n FROM factory.issue_events WHERE kind = 'steward_exhausted'`
    expect(counted.n).toBe(1)
  })

  test('the owner is always away: the steward line goes out, other lines are folded', () => {
    expect(foldReason('notify:steward:7:blocked')).toBeNull()
    expect(foldReason('notify:parked:7:3')).not.toBeNull()
  })

  test('a block that names the verification re-runs it off the tick first and puts the result in the note', async () => {
    const id = await working()
    await lead(id)
    await db.sql`INSERT INTO factory.issue_events (issue_id, key, kind, from_state, to_state, at) VALUES (${id}, 'ship-seed', 'ship', 'working', 'watching', ${clock.now()})`
    await report(id, 'block', { reason: 'make verify is red on the deployed version' })
    const runs: string[] = []
    const proof: Proof = {
      run: async () => {
        runs.push('run')
        return [{ name: 'make verify', ok: true, detail: 'exit 0' }]
      },
    }
    const offTick = new OffTick({ now: () => clock.now().getTime() })
    const deps = steward({ verify: { proof, offTick } })
    advance(30 * MIN)
    await pass(deps)
    // the run started off the tick; the act waits for its answer
    expect(await acts()).toEqual([])
    await offTick.settled()
    await pass(deps)
    const [act] = await acts()
    expect(act.payload.text).toContain('verify re-run just now: green')
    expect(runs).toEqual(['run'])
    expect(await state(id)).toMatchObject({ state: 'working' })
  })

  test('without a verifier the note says the verification was not re-run', async () => {
    const id = await working()
    await lead(id)
    await db.sql`INSERT INTO factory.issue_events (issue_id, key, kind, from_state, to_state, at) VALUES (${id}, 'ship-seed', 'ship', 'working', 'watching', ${clock.now()})`
    await report(id, 'block', { reason: 'verify keeps failing' })
    advance(30 * MIN)
    await pass()
    expect((await acts())[0]?.payload.text).toContain('verify was not re-run')
  })

  test('a lead_gone park is requeued on the same backoff: finalize first, then the next attempt', async () => {
    const id = await working()
    await db.sql`
      INSERT INTO factory.issue_events (issue_id, key, kind, from_state, to_state, at)
      VALUES (${id}, 'seed:1', 'lead_gone', 'working', 'queued', ${clock.now()}), (${id}, 'seed:2', 'lead_gone', 'working', 'queued', ${clock.now()})`
    await send(id, 'lead_gone', { attempt: 1, detail: 'spawn ended' })
    await pass()
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'lead_gone' })
    advance(29 * MIN)
    await pass()
    expect(await acts()).toEqual([])
    advance(MIN)
    await pass()
    expect(await state(id)).toMatchObject({ state: 'queued' })
    expect(await trail(id)).toContain('restart waiting→queued')
    const effects = await db.sql`SELECT kind FROM factory.issue_effects WHERE issue_id = ${id} ORDER BY id`
    expect(effects.map((e: { kind: string }) => e.kind)).toContain('finalize')
    expect((await acts())[0]).toMatchObject({ key: `steward:${id}:lead_gone:1`, kind: 'restart', result: 'applied' })
  })
})

describe('rule 2: a timed wait is woken when its cause lifted', () => {
  const deepStarted = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await db.sql`
        INSERT INTO factory.spawns (key, repo, prompt, status, role, account, first_claimed_at, review_job, review_tier, review_effort, created_at)
        VALUES (${`review-d${i}-a1`}, '/r', 'p', 'started', 'reviewer', 'a', ${clock.now()}, ${`d${i}`}, 'deep', 'high', ${clock.now()})`
    }
  }
  const waitOn = (id: number, payload: Record<string, unknown>) =>
    report(id, 'wait', { until: new Date(clock.now().getTime() + 6 * HOUR).toISOString(), ...payload })

  test('--on deep_cap wakes when the cap has room, and not before', async () => {
    const id = await working()
    await lead(id)
    await deepStarted(DEFAULT_REVIEW_LIMITS.deepCap)
    await waitOn(id, { on: 'deep_cap', why: 'review held' })
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'wait' })
    advance(HOUR)
    await pass()
    expect(await state(id)).toMatchObject({ state: 'waiting' })

    await db.sql`DELETE FROM factory.spawns WHERE key LIKE 'review-d%'`
    await pass()
    expect(await state(id)).toMatchObject({ state: 'working' })
    const [wake] = await db.sql`SELECT key, payload FROM factory.issue_inbox WHERE kind = 'wake'`
    expect(wake.key).toBe(`wake:${id}:1`)
    expect(wake.payload).toMatchObject({ for: 'wait', wait: 1, who: 'steward', cause: 'deep_cap' })
  })

  test('a wait whose why names the deep cap counts, and the timer at until acts no second time', async () => {
    const id = await working()
    await waitOn(id, { why: 'the review is held at the deep cap' })
    await pass()
    expect(await state(id)).toMatchObject({ state: 'working' })
    advance(7 * HOUR)
    await fireTimers(db.sql, clock.now())
    await pass()
    const wakes = await db.sql`SELECT key FROM factory.issue_inbox WHERE kind = 'wake'`
    expect(wakes).toHaveLength(1)
    expect(await state(id)).toMatchObject({ state: 'working' })
  })

  test('a wait with another cause, or none, is left to its timer', async () => {
    const id = await working()
    await waitOn(id, { why: 'waiting for the deploy window' })
    advance(HOUR)
    await pass()
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'wait' })
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind = 'wake'`).toEqual([])
  })

  test('a decision wait (a question) is never touched, however long it sits', async () => {
    const id = await working()
    await lead(id)
    await report(id, 'ask', { question: 'which one?' })
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'decision' })
    for (let i = 0; i < 8; i++) {
      advance(6 * HOUR)
      await pass()
    }
    expect(await state(id)).toMatchObject({ state: 'waiting', reason: 'decision' })
    expect(await acts()).toEqual([])
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind IN ('wake', 'note', 'restart')`).toEqual([])
  })
})

describe('rule 4: a silent or over-budget lead is nudged, a claim holder is woken', () => {
  test('a lead silent for 20 minutes gets a nudge (not a wake), then 2 h and 6 h later, three at most', async () => {
    const id = await working()
    await lead(id)
    await pass()
    expect(await acts()).toEqual([])
    advance(SILENT_AFTER_MS)
    await pass()
    const [nudge] = await acts()
    expect(nudge.payload).toMatchObject({
      cause: 'silent',
      who: 'steward',
      text: 'report: continue, ship, block, or narrow',
    })
    expect(nudge.payload.wake).toBeUndefined()
    expect(await state(id)).toMatchObject({ state: 'working' })
    expect(await trail(id)).toContain('note')

    // counted from the lead's last word, 20 minutes ago: 2 h and 6 h after it
    advance(2 * HOUR - SILENT_AFTER_MS - MIN)
    await pass()
    expect(await acts()).toHaveLength(1)
    advance(MIN)
    await pass()
    expect(await acts()).toHaveLength(2)
    advance(4 * HOUR)
    await pass()
    expect(await acts()).toHaveLength(3)
    advance(12 * HOUR)
    await pass()
    // the sixth hour is past the size's budget: that is its own cause, with its own three
    const causes = (await acts()).map((a: { payload: { cause: string } }) => a.payload.cause)
    expect(causes.filter((c: string) => c === 'silent')).toHaveLength(3)
    expect(causes.filter((c: string) => c === 'over_budget')).toHaveLength(1)
  })

  test('an Issue past its size budget is nudged once the lead is not silent', async () => {
    const id = await working({ size: 's' })
    await lead(id, 1, 5)
    advance(BUDGET_HOURS.s * HOUR - 3 * MIN)
    await w.emit(`lead-${id}-1`, 'turn_started', clock.now())
    advance(33 * MIN)
    await w.emit(`lead-${id}-1`, 'turn_started', clock.now())
    await pass()
    const rows = await acts()
    expect(rows.map((r: { payload: { cause: string } }) => r.payload.cause)).toEqual(['over_budget'])
  })

  const claim = (key: string, id: number, queuedMinutesAgo: number, held: boolean) =>
    db.sql`INSERT INTO factory.claims (key, issue_id, queued_at, held_at) VALUES (${key}, ${id}, ${new Date(clock.now().getTime() - queuedMinutesAgo * MIN)}, ${held ? clock.now() : null})`

  async function queuedBehind(holder: number, minutes: number) {
    const made = await createIssue(
      db.sql,
      { source: 'request', sourceKey: `q${++n}`, repo: TEST_REPO, title: 'queued', facts: {} },
      { repoRoots: [TEST_ROOT], now: clock.now() },
    )
    await claim('repo:p', holder, 120, true)
    await claim('repo:p', made.issue.id, minutes, false)
    return made.issue.id
  }

  test('a waiting holder is woken at once when another Issue has queued behind its claim for 15 minutes and nothing is live', async () => {
    const holder = await working()
    await lead(holder)
    await report(holder, 'block', { reason: 'waiting for something' })
    await queuedBehind(holder, 14)
    await pass()
    expect(await acts()).toEqual([])
    advance(MIN)
    await pass()
    const [wake] = await acts()
    expect(wake.payload).toMatchObject({ cause: 'claim', wake: true, who: 'steward' })
    expect(await state(holder)).toMatchObject({ state: 'working' })
  })

  test('no wake while another holder is working', async () => {
    const holder = await working()
    await lead(holder)
    await report(holder, 'block', { reason: 'r' })
    const other = await working()
    const waiting = await queuedBehind(holder, 60)
    await claim('repo:p', other, 90, true)
    await pass()
    expect(waiting).toBeGreaterThan(0)
    expect((await acts()).filter((a: { payload: { cause: string } }) => a.payload.cause === 'claim')).toEqual([])
  })
})

describe('rule 6 and the status', () => {
  test('factory status counts the acts and the handed-over Issues, read from the rows', async () => {
    const id = await working()
    await lead(id)
    await report(id, 'block', { reason: 'r' })
    advance(30 * MIN)
    await pass()
    expect((await buildStatus(db.sql, clock.now())).steward).toEqual({ acts: 1, exhausted: 0 })
    expect(id).toBeGreaterThan(0)
  })
})

describe('rule 5: finished review work is no health line', () => {
  const outcome = (job: string, kind: string, at = clock.now()) =>
    db.sql`INSERT INTO factory.review_outcomes (spawn_key, job_id, attempt, outcome, detail, at) VALUES (${`review-${job}-${kind}`}, ${job}, 1, ${kind}, 'refused', ${at})`
  const spawn = (job: string, kind: string, repo = TEST_REPO) =>
    db.sql`INSERT INTO factory.spawns (key, repo, prompt, status, role, review_job, review_tier, review_effort, created_at)
      VALUES (${`review-${job}-${kind}`}, ${repo}, 'p', 'started', 'reviewer', ${job}, 'light', 'low', ${clock.now()})`
  const lines = async () =>
    (await buildStatus(db.sql, clock.now())).health
      .filter((line) => line.includes('needs a human'))
      .map((l) => l.split(':')[0])

  test('shown while the job is unfinished; gone when it was taken, its repo has no open Issue, or it is a day old', async () => {
    await working()
    await spawn('open', 'needs_human')
    await outcome('open', 'needs_human')
    expect(await lines()).toEqual(['review open needs a human'])

    // a later attempt was submitted: agw has its verdict
    await spawn('covered', 'needs_human')
    await outcome('covered', 'needs_human')
    await spawn('covered', 'submitted')
    await outcome('covered', 'submitted')
    // its repo has no open Issue
    await spawn('orphan', 'needs_human', '/elsewhere')
    await outcome('orphan', 'needs_human')
    expect(await lines()).toEqual(['review open needs a human'])

    advance(25 * HOUR)
    expect(await lines()).toEqual([])
  })
})
