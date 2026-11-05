import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEWER_ROLE, reviewKey, Status } from '@software-factory/contract'
import { statusScreen } from '../../cli/src/run.ts'
import { HOLD_RECHECK_MS } from '../src/admission.ts'
import { type Reading, standing } from '../src/capacity.ts'
import { HcRunner, REVIEWER_DISALLOWED_TOOLS } from '../src/hc-runner.ts'
import { DEFAULT_REVIEW_LIMITS, type ReviewLimits, reviewSessionsLive } from '../src/review/limits.ts'
import {
  AgwSubmitter,
  MAX_ERROR_CHARS,
  REPLY_GRACE_MS,
  retryPrompt,
  ReviewTransport,
  SUBMIT_RETRY_MS,
  type ReviewSubmitter,
  type SubmitInput,
  type Submitted,
} from '../src/review/transport.ts'
import { evaluateRules } from '../src/rules.ts'
import { getSession, liveSessions, openSession, recordEvent, RUNNER_SESSION } from '../src/sessions.ts'
import { createSpawn } from '../src/spawns.ts'
import { tick } from '../src/tick.ts'
import { startApp, TEST_REPO, TEST_ROLES, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHc, type FakeHc } from './support/hc.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { usage } from './support/quota.ts'
import { FakeRunner, world } from './support/world.ts'

let db: TestDb
let hc: FakeHc
let app: TestApp
const clock = new FakeClock()

beforeAll(async () => {
  db = await startTestDb()
  hc = await createFakeHc()
  app = startApp({ sql: db.sql, clock })
})
afterAll(async () => {
  await app.stop()
  await hc.cleanup()
  await db.stop()
})
beforeEach(async () => {
  await db.reset()
  await hc.reset()
  clock.advance(0)
})

const inMs = (ms: number) => new Date(clock.now().getTime() + ms)
const reading = (
  account: string,
  weekly: number | null,
  fiveHour: number | null,
  extra: Parameters<typeof usage>[3] = {},
) => app.send('PUT', `/quota/accounts/${account}`, usage(weekly, fiveHour, inMs(100 * 3_600_000), extra))
/** Two accounts the fake core's registry knows, `a` with the lower week. */
const readings = async (extra: Parameters<typeof usage>[3] = {}) => {
  await reading('a', 10, 10, extra)
  await reading('b', 20, 10, extra)
}
const runner = () =>
  new HcRunner({
    bin: hc.bin,
    clock,
    pretrustBin: hc.pretrustBin,
    accountsFile: hc.accountsFile,
    home: '/home/me',
    deliverWaitMs: 3_000,
  })
const runTick = (limits?: ReviewLimits, extra: Partial<Parameters<typeof tick>[0]> = {}) =>
  tick({ sql: db.sql, clock, runner: runner(), reviewLimits: limits, ...extra })

const jobLine = (job: string) => `job=/tmp/${job} worktree=/tmp/${job}/wt tier=standard round=1`
const reviewerBody = (job: string, extra: Record<string, unknown> = {}, review: Record<string, unknown> = {}) => ({
  key: reviewKey(job, 1),
  repo: TEST_REPO,
  role: REVIEWER_ROLE,
  prompt: jobLine(job),
  review: { jobId: job, tier: 'standard', effort: 'medium', ...review },
  ...extra,
})
const post = (body: Record<string, unknown>) => app.send('POST', '/spawns', body)
const spawnRow = async (key: string) => (await (await app.get(`/spawns/${key}`)).json()) as Record<string, unknown>

describe('the reviewer spawn', () => {
  test('is a role of the table, hidden by default, and carries its job on the row', async () => {
    expect(TEST_ROLES.get(REVIEWER_ROLE)).toEqual({ role: 'reviewer', tier: 'sonnet', effort: 'medium' })
    await readings()
    const res = await post(reviewerBody('rv_ddx2xwgrsnyz7mh4rrwy', {}, { tier: 'deep', effort: 'high' }))
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      key: 'review-rv_ddx2xwgrsnyz7mh4rrwy-a1',
      role: 'reviewer',
      tier: 'sonnet',
      effort: 'medium',
      placement: 'hidden',
      review: { jobId: 'rv_ddx2xwgrsnyz7mh4rrwy', tier: 'deep', effort: 'high' },
      status: 'queued',
    })
    // A replay answers with the stored row.
    expect((await post(reviewerBody('rv_ddx2xwgrsnyz7mh4rrwy'))).status).toBe(200)
  })

  test('takes the review fields with the role reviewer only, and the role requires them', async () => {
    const withoutReview = await post({ key: 'r-1', repo: TEST_REPO, role: 'reviewer', prompt: 'x' })
    expect(withoutReview.status).toBe(400)
    const otherRole = await post({ ...reviewerBody('rv_one'), role: 'worker' })
    expect(otherRole.status).toBe(400)
    const wrongKey = await post({ ...reviewerBody('rv_one'), key: 'review-rv_other-a1' })
    expect(wrongKey.status).toBe(400)
    expect((await post({ ...reviewerBody('rv_one'), key: 'review-rv_one-a3' })).status).toBe(400)
    expect((await post(reviewerBody('rv_one', { placement: 'tab' }))).status).toBe(400)
    expect((await post(reviewerBody('rv_one', {}, { effort: 'max' }))).status).toBe(400)
    expect((await post(reviewerBody('rv_one', {}, { tier: 'none' }))).status).toBe(400)
    expect((await db.sql`SELECT count(*)::int AS n FROM factory.spawns`)[0]?.n).toBe(0)
  })

  test('starts as claude --agent reviewer with the writing tools denied, in a terminal with no parent, space or tab', async () => {
    await readings()
    const prompt = jobLine('rv_a')
    await post(reviewerBody('rv_a', {}, { tier: 'light', effort: 'low' }))
    expect((await runTick()).started).toEqual(['review-rv_a-a1'])
    const state = await hc.state()
    const [terminal] = state.terminals
    // The list-valued option is followed by another option, so the prompt stays the last argument.
    expect(terminal?.argv).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--model',
      'sonnet',
      '--effort',
      'low',
      '--disallowed-tools',
      REVIEWER_DISALLOWED_TOOLS.join(','),
      '--agent',
      'reviewer',
      prompt,
    ])
    for (const tool of ['Bash', 'Write', 'Edit', 'NotebookEdit']) expect(REVIEWER_DISALLOWED_TOOLS).toContain(tool)
    expect(terminal?.labels).toEqual({ 'factory.key': 'review-rv_a-a1' })
    expect(terminal?.parent).toBeNull()
    expect(state.runs[0]?.params).toMatchObject({ no_parent: true, keep: false, cwd: TEST_REPO })
    expect(state.runs[0]?.params.env).toMatchObject({ FACTORY_ROLE: 'reviewer', FACTORY_SESSION: 'review-rv_a-a1' })
    // Hidden: no space was seeded in the app's document and the result has no tab.
    expect(state.docs).toEqual({})
    expect(await spawnRow('review-rv_a-a1')).toMatchObject({ status: 'started', tab: null, workspace: null })
  })

  test('another role keeps its argv: no agent flags', async () => {
    await readings()
    await post({ key: 'plain', repo: TEST_REPO, prompt: 'do it' })
    await runTick()
    expect((await hc.state()).terminals[0]?.argv).not.toContain('--agent')
  })
})

describe('the review ceiling', () => {
  const at = new Date('2026-11-03T12:00:00.000Z')
  const r = (five: number | null, week: number | null, extra: Partial<Reading> = {}): Reading => ({
    id: 1,
    account: 'a',
    readAt: at,
    sampledAt: at,
    enabled: true,
    authOk: true,
    fiveHourUsed: five,
    weeklyUsed: week,
    fiveHourResetsAt: new Date(at.getTime() + 3_600_000),
    weeklyResetsAt: new Date(at.getTime() + 3 * 24 * 3_600_000),
    exhaustedUntil: null,
    ...extra,
  })
  const open = (x: Reading, review = true) => standing(x, at, false, review).open

  test('is 70 % of the 5-hour window and 90 % of the week, lower than a worker’s 85 and 95', () => {
    expect(open(r(69.9, 10))).toBe(true)
    expect(open(r(70, 10))).toBe(false)
    expect(open(r(10, 89.9))).toBe(true)
    expect(open(r(10, 90))).toBe(false)
    // The same readings are open for a worker.
    expect(open(r(70, 10), false)).toBe(true)
    expect(open(r(10, 90), false)).toBe(true)
    expect(open(r(85, 10), false)).toBe(false)
    // A closed account says when it opens: the reset of the window that closed it.
    expect(standing(r(75, 10), at, false, true)).toEqual({ open: false, until: new Date(at.getTime() + 3_600_000) })
  })

  test('an account without a 5-hour reading is judged on its week, one with no reading is not eligible', () => {
    expect(open(r(null, 50))).toBe(true)
    expect(open(r(null, 90))).toBe(false)
    expect(open(r(null, null))).toBe(false)
    expect(open(r(10, 10, { sampledAt: null }))).toBe(false)
  })

  test('a review over the ceiling waits for the first opening, a worker on the same account starts', async () => {
    await reading('a', 10, 75)
    await post(reviewerBody('rv_w'))
    const waiting = await spawnRow('review-rv_w-a1')
    expect(waiting).toMatchObject({ status: 'waiting', account: null, hold: null })
    expect(new Date(waiting.resumeAt as string).getTime()).toBe(inMs(100 * 3_600_000).getTime())
    await post({ key: 'worker', repo: TEST_REPO, prompt: 'x' })
    expect(await spawnRow('worker')).toMatchObject({ status: 'queued', account: 'a' })
    // Never spills: the tick starts the worker and leaves the review waiting.
    const result = await runTick()
    expect(result.started).toEqual(['worker'])
    expect(await spawnRow('review-rv_w-a1')).toMatchObject({ status: 'waiting', account: null })
  })

  test('a new reading under the ceiling wakes the waiting review', async () => {
    await reading('a', 10, 75)
    await post(reviewerBody('rv_x'))
    clock.advance(60_000)
    await reading('a', 10, 20)
    expect(await runTick()).toMatchObject({ started: ['review-rv_x-a1'] })
  })
})

describe('the review slots', () => {
  test('at most two live reviewer sessions host-wide; the third is held until an attempt ends', async () => {
    await readings()
    for (const job of ['rv_1', 'rv_2', 'rv_3']) expect((await post(reviewerBody(job))).status).toBe(201)
    expect(await spawnRow('review-rv_1-a1')).toMatchObject({ status: 'queued', account: 'a', hold: null })
    expect(await spawnRow('review-rv_2-a1')).toMatchObject({ status: 'queued', account: 'b', hold: null })
    // Queued spawns hold no slot yet, and both accounts are taken: the third waits for a sample.
    expect((await runTick()).started.sort()).toEqual(['review-rv_1-a1', 'review-rv_2-a1'])
    expect(await spawnRow('review-rv_3-a1')).toMatchObject({ status: 'waiting', account: null })
    // A new reading shows the accounts free again, but both slots are taken: held, not started.
    clock.advance(60_000)
    await readings()
    expect((await runTick()).started).toEqual([])
    expect(await spawnRow('review-rv_3-a1')).toMatchObject({ status: 'queued', hold: 'review_slots', account: null })

    // An attempt that has an outcome gives its slot back.
    await db.sql`INSERT INTO factory.review_outcomes (spawn_key, job_id, attempt, outcome, at) VALUES ('review-rv_1-a1', 'rv_1', 1, 'submitted', ${clock.now()})`
    clock.advance(HOLD_RECHECK_MS + 1_000)
    await readings()
    expect((await runTick()).started).toEqual(['review-rv_3-a1'])
  })

  test('a worker does not count, and FACTORY_REVIEW_SESSIONS moves the limit', async () => {
    await readings()
    await post({ key: 'w', repo: TEST_REPO, prompt: 'x' })
    await runTick()
    const one: ReviewLimits = { ...DEFAULT_REVIEW_LIMITS, sessions: 1 }
    const first = await createSpawn(db.sql, newReviewer('rv_s1'), clock.now(), one)
    expect(first.spawn.hold).toBeNull()
    await db.sql`UPDATE factory.spawns SET status = 'started' WHERE key = 'review-rv_s1-a1'`
    await db.sql`INSERT INTO factory.sessions (id, spawn_key, created_at) VALUES ('review-rv_s1-a1', 'review-rv_s1-a1', ${clock.now()})`
    const second = await createSpawn(db.sql, newReviewer('rv_s2'), clock.now(), one)
    expect(second.spawn.hold).toBe('review_slots')
    expect(await reviewSessionsLive(db.sql, await liveSessions(db.sql, clock.now()))).toBe(1)
  })
})

const newReviewer = (job: string, tier: 'light' | 'standard' | 'deep' = 'standard', attempt = 1) => ({
  key: reviewKey(job, attempt),
  repo: TEST_REPO,
  prompt: jobLine(job),
  role: REVIEWER_ROLE,
  tier: 'sonnet' as const,
  effort: 'medium' as const,
  placement: 'hidden' as const,
  review: { jobId: job, tier, effort: 'medium' as const },
})

describe('the deep cap', () => {
  const limits: ReviewLimits = { sessions: 10, deepCap: 1, idleMs: 600_000 }
  const admit = (job: string, tier: 'light' | 'standard' | 'deep') =>
    createSpawn(db.sql, newReviewer(job, tier), clock.now(), limits)
  const fresh = async () => {
    clock.advance(60_000)
    await readings()
  }

  test('past the cap an account takes no more deep reviews today: the spawn is held, other tiers are not', async () => {
    await readings()
    expect((await admit('rv_d1', 'deep')).spawn).toMatchObject({ status: 'queued', account: 'a' })
    await runTick(limits)
    await fresh()
    // Account a has started its one deep review: the next goes to b.
    expect((await admit('rv_d2', 'deep')).spawn).toMatchObject({ status: 'queued', account: 'b' })
    await runTick(limits)
    await fresh()
    const third = (await admit('rv_d3', 'deep')).spawn
    expect(third).toMatchObject({ status: 'queued', hold: 'deep_cap', account: null, review: { tier: 'deep' } })
    expect((await admit('rv_s', 'standard')).spawn).toMatchObject({ status: 'queued', hold: null })

    const status = Status.parse(await (await app.get('/status')).json())
    expect(status.attention.filter((l) => l.startsWith('review '))).toEqual([
      expect.stringMatching(
        /^review review-rv_d3-a1 held: deep cap reached on every open account today \(UTC\), started a 1\/15, b 1\/15; allow runs it past the cap$/,
      ),
    ])
  })

  test('the owner’s allow lets exactly that spawn start, at its own tier', async () => {
    await readings()
    await admit('rv_d1', 'deep')
    await runTick(limits)
    await fresh()
    await admit('rv_d2', 'deep')
    await runTick(limits)
    await fresh()
    await admit('rv_d3', 'deep')
    await admit('rv_d4', 'deep')
    await db.sql`UPDATE factory.spawns SET deep_allowed = true, resume_at = ${clock.now()} WHERE key = 'review-rv_d3-a1'`
    const result = await runTick(limits)
    expect(result.started).toEqual(['review-rv_d3-a1'])
    expect(await spawnRow('review-rv_d3-a1')).toMatchObject({ status: 'started', review: { tier: 'deep' } })
    expect(await spawnRow('review-rv_d4-a1')).toMatchObject({ status: 'queued', hold: 'deep_cap' })
  })

  test('the count is per UTC day: the next day the accounts have their deep reviews again', async () => {
    await readings()
    await admit('rv_d1', 'deep')
    await runTick(limits)
    await fresh()
    await admit('rv_d2', 'deep')
    await runTick(limits)
    await fresh()
    expect((await admit('rv_d3', 'deep')).spawn.hold).toBe('deep_cap')
    clock.advance(13 * 3_600_000)
    await readings()
    clock.advance(HOLD_RECHECK_MS + 1)
    await readings()
    expect((await runTick(limits)).started).toEqual(['review-rv_d3-a1'])
  })
})

describe('submit on Stop', () => {
  let w: ReturnType<typeof world>
  let fake: FakeRunner
  let calls: SubmitInput[]
  let answers: Submitted[]
  let replies: Map<string, string | null>
  let written: Map<string, Date>
  let transport: ReviewTransport
  const submitter: ReviewSubmitter = {
    submit: async (input) => {
      calls.push(input)
      return answers.shift() ?? { kind: 'accepted', output: '{"ok":true}' }
    },
  }

  beforeEach(() => {
    w = world(db.sql, clock)
    fake = new FakeRunner()
    calls = []
    answers = []
    replies = new Map()
    written = new Map()
    transport = new ReviewTransport({
      sql: db.sql,
      clock,
      runner: fake,
      roles: TEST_ROLES,
      replies: { lastReply: async (path) => replies.get(path) ?? null },
      submitter,
      mtime: async (path) => written.get(path),
    })
  })

  /** A started reviewer attempt whose session has a transcript; `turn`: its turn is open, or ended `endedMinutesAgo`. */
  async function attempt(
    job: string,
    n: number,
    turn: 'open' | 'ended',
    options: { prompt?: string; since?: number } = {},
  ) {
    const key = reviewKey(job, n)
    const path = `/home/me/.claude/projects/-x/${key}.jsonl`
    // The attempt's own spawn row (an earlier pass may have made it queued) is replaced by a started one.
    await db.sql`DELETE FROM factory.spawns WHERE key = ${key}`
    await w.spawned(key, {
      role: REVIEWER_ROLE,
      account: 'a',
      repo: TEST_REPO,
      startedMinutesAgo: Math.max(30, (options.since ?? 20) + 1),
    })
    await db.sql`
      UPDATE factory.spawns SET prompt = ${options.prompt ?? jobLine(job)}, review_job = ${job}, review_tier = 'standard', review_effort = 'medium',
        placement = 'hidden', first_claimed_at = ${w.at(30)} WHERE key = ${key}`
    await db.sql`UPDATE factory.sessions SET transcript_path = ${path} WHERE id = ${key}`
    await w.emit(key, 'turn_started', w.at(options.since ?? 20))
    if (turn === 'ended') await w.emit(key, 'turn_ended', w.at(options.since === undefined ? 10 : options.since - 1))
    return { key, path }
  }
  const outcome = async (key: string) =>
    (await db.sql`SELECT outcome, detail FROM factory.review_outcomes WHERE spawn_key = ${key}`)[0] as
      | { outcome: string; detail: string | null }
      | undefined
  const spawnKeys = async (): Promise<string[]> =>
    (await db.sql`SELECT key FROM factory.spawns WHERE key LIKE 'review-%' ORDER BY key`).map(
      (r: { key: string }) => r.key,
    )

  test('hands the last reply to agw review submit verbatim, then closes the terminal and gives the slot back', async () => {
    const { key, path } = await attempt('rv_ok', 1, 'ended')
    const reply = '  {"verdict":"pass","notes":"line one\\nline two"}\n\n'
    replies.set(path, reply)
    const result = await transport.pass()
    expect(result).toMatchObject({ submitted: [key], retried: [], needsHuman: [], errors: [] })
    expect(calls).toEqual([{ jobId: 'rv_ok', attempt: 1, account: 'a', reply }])
    expect(fake.closed).toEqual([key])
    expect(await outcome(key)).toMatchObject({ outcome: 'submitted' })
    expect(await reviewSessionsLive(db.sql, await liveSessions(db.sql, clock.now()))).toBe(0)

    // A replayed pass submits and closes nothing again.
    expect((await transport.pass()).submitted).toEqual([])
    expect(calls).toHaveLength(1)
    expect(fake.closed).toEqual([key])
  })

  test('does nothing while the turn is open', async () => {
    await attempt('rv_open', 1, 'open', { since: 2 })
    const result = await transport.pass()
    expect(result).toMatchObject({ submitted: [], retried: [] })
    expect(calls).toEqual([])
  })

  test('a Stop with background work running is not the reply: nothing is submitted until a later Stop without it', async () => {
    const { key, path } = await attempt('rv_bg', 1, 'open', { since: 2 })
    await w.emit(key, 'turn_ended', w.at(1), { backgroundTasks: true })
    replies.set(path, 'The verifier is still running, so I have no verdict yet.')
    written.set(path, w.at(1))
    expect(await transport.pass()).toMatchObject({ submitted: [], retried: [], needsHuman: [] })
    expect(calls).toEqual([])

    // The session resumed when the verifier finished and stopped again, this time for good.
    await w.emit(key, 'turn_started', w.at(0.5))
    await w.emit(key, 'turn_ended', w.at(0.2))
    replies.set(path, '{"verdict":"pass"}')
    clock.advance(REPLY_GRACE_MS + 1)
    expect((await transport.pass()).submitted).toEqual([key])
    expect(calls).toEqual([{ jobId: 'rv_bg', attempt: 1, account: 'a', reply: '{"verdict":"pass"}' }])
  })

  test('a Stop with background work that never resumes is judged by the idle limit', async () => {
    const { key, path } = await attempt('rv_bg_idle', 1, 'open', { since: 40 })
    await w.emit(key, 'turn_ended', w.at(39), { backgroundTasks: true })
    replies.set(path, 'waiting for the verifier')
    written.set(path, w.at(39))
    const result = await transport.pass()
    expect(result).toMatchObject({ submitted: [], retried: [key] })
    expect(calls).toEqual([])
    expect(await outcome(key)).toMatchObject({ outcome: 'idle' })
  })

  test('a refusal starts attempt 2 once, with agw’s message (2,000 characters at most) after the original prompt', async () => {
    const { key, path } = await attempt('rv_no', 1, 'ended')
    replies.set(path, 'not json')
    answers.push({ kind: 'refused', error: `schema: ${'x'.repeat(5_000)}` })
    const result = await transport.pass()
    expect(result).toMatchObject({ submitted: [], retried: [key] })
    expect(fake.closed).toEqual([key])
    expect(await outcome(key)).toMatchObject({ outcome: 'refused' })

    const next = reviewKey('rv_no', 2)
    const [row] = await db.sql`
      SELECT prompt, role, placement, review_job, review_tier, review_effort, status FROM factory.spawns WHERE key = ${next}`
    const sent = `schema: ${'x'.repeat(5_000)}`.slice(0, MAX_ERROR_CHARS)
    expect(row).toMatchObject({
      role: 'reviewer',
      placement: 'hidden',
      review_job: 'rv_no',
      review_tier: 'standard',
      review_effort: 'medium',
    })
    expect(row?.prompt).toBe(
      `${jobLine('rv_no')}\n\nYour previous reply was refused by agw review submit: ${sent}. Reply again with only the JSON.`,
    )
    expect(row?.prompt).toBe(
      retryPrompt(
        jobLine('rv_no'),
        `Your previous reply was refused by agw review submit: ${sent}. Reply again with only the JSON.`,
      ),
    )

    // Replayed: neither a second submit nor a second a2.
    await transport.pass()
    expect(calls).toHaveLength(1)
    expect(await spawnKeys()).toEqual([key, next])
  })

  test('a repeated pass after a crash between the new spawn and the outcome makes no second a2', async () => {
    const { key, path } = await attempt('rv_crash', 1, 'ended')
    replies.set(path, 'x')
    answers.push({ kind: 'refused', error: 'bad' }, { kind: 'refused', error: 'bad' })
    await transport.pass()
    // The outcome row is lost (as if the pass died before writing it): the same effects run again.
    await db.sql`DELETE FROM factory.review_outcomes WHERE spawn_key = ${key}`
    await transport.pass()
    expect(await spawnKeys()).toEqual([key, reviewKey('rv_crash', 2)])
    expect(calls).toHaveLength(2)
  })

  test('attempt 2 refused too is for a person: closed, no attempt 3, an attention line naming the job', async () => {
    // Unfinished work: an Issue of the reviewer's repo is open.
    await db.sql`INSERT INTO factory.issues (state, source, source_key, repo, title, facts, created_at, updated_at)
      VALUES ('working', 'request', 'rv-two', ${TEST_REPO}, 't', '{}'::jsonb, ${clock.now()}, ${clock.now()})`
    await attempt('rv_two', 1, 'ended')
    await db.sql`INSERT INTO factory.review_outcomes (spawn_key, job_id, attempt, outcome, at) VALUES (${reviewKey('rv_two', 1)}, 'rv_two', 1, 'refused', ${clock.now()})`
    const { key, path } = await attempt('rv_two', 2, 'ended')
    replies.set(path, 'still not json')
    answers.push({ kind: 'refused', error: 'missing field verdict' })
    const result = await transport.pass()
    expect(result).toMatchObject({ needsHuman: [key], retried: [] })
    expect(fake.closed).toEqual([key])
    expect(await outcome(key)).toMatchObject({ outcome: 'needs_human', detail: 'refused: missing field verdict' })
    expect(await spawnKeys()).toEqual([reviewKey('rv_two', 1), key])
    const status = Status.parse(await (await app.get('/status')).json())
    expect(status.health).toContain('review rv_two needs a human: attempt 2 failed: refused: missing field verdict')
    expect(status.attention.filter((l) => l.includes('needs a human'))).toEqual([])
  })

  test('agw not answering is no refusal: the same attempt is asked again after a pause', async () => {
    const { key, path } = await attempt('rv_slow', 1, 'ended')
    replies.set(path, 'ok')
    answers.push({ kind: 'unavailable', error: 'agw review submit did not answer in time' })
    expect((await transport.pass()).errors).toHaveLength(1)
    expect(await outcome(key)).toBeUndefined()
    expect(fake.closed).toEqual([])
    await transport.pass()
    expect(calls).toHaveLength(1)
    clock.advance(SUBMIT_RETRY_MS + 1)
    expect((await transport.pass()).submitted).toEqual([key])
    expect(calls).toHaveLength(2)
  })

  test('a turn that left no text waits out the transcript’s lag, then counts as a failed attempt', async () => {
    const { key } = await attempt('rv_empty', 1, 'ended', { since: 5 })
    // The turn ended four minutes ago in `attempt`; make it end just now.
    await db.sql`UPDATE factory.events SET at = ${clock.now()} WHERE session = ${key} AND kind = 'turn_ended'`
    expect(await transport.pass()).toMatchObject({ retried: [], needsHuman: [] })
    expect(calls).toEqual([])
    clock.advance(REPLY_GRACE_MS + 1_000)
    expect(await transport.pass()).toMatchObject({ retried: [key] })
    expect(calls).toEqual([])
    expect(
      (await db.sql`SELECT prompt FROM factory.spawns WHERE key = ${reviewKey('rv_empty', 2)}`)[0]?.prompt,
    ).toContain('ended without a reply')
  })

  test('a session whose terminal is gone still gets its last reply submitted', async () => {
    const { key, path } = await attempt('rv_dead', 1, 'ended')
    await w.emit(key, 'pane_gone', w.at(0))
    replies.set(path, 'the reply')
    expect((await transport.pass()).submitted).toEqual([key])
  })

  test('a runner restart with a live reviewer resumes nothing and starts attempt 2', async () => {
    const { key } = await attempt('rv_restart', 1, 'open', { since: 10 })
    await w.spawned('control', { account: 'a', startedMinutesAgo: 30 })
    await w.emit('control', 'turn_started', w.at(10))
    await recordEvent(db.sql, {
      key: 'runner_restarted:new',
      session: RUNNER_SESSION,
      kind: 'runner_restarted',
      at: w.at(6),
      payload: { from: '1@x', to: '2@y' },
    })
    // The rule resumes the worker, and never the reviewer.
    const { created } = await evaluateRules(db.sql, clock.now())
    expect(created).toHaveLength(1)
    expect(created[0]).toContain('control')
    expect((await db.sql`SELECT count(*)::int AS n FROM factory.prompts WHERE session = ${key}`)[0]?.n).toBe(0)

    // The reviewer's attempt failed with its terminal: a fresh session, once.
    const result = await transport.pass()
    expect(result).toMatchObject({ retried: [key], needsHuman: [] })
    expect(fake.closed).toEqual([key])
    expect(await spawnKeys()).toEqual([key, reviewKey('rv_restart', 2)])
    expect(calls).toEqual([])
    expect((await db.sql`SELECT count(*)::int AS n FROM factory.prompts WHERE session = ${key}`)[0]?.n).toBe(0)
  })

  test('a lost terminal mid-turn is a failed attempt; a lost terminal after the turn ended still hands its reply over', async () => {
    const lost = await attempt('rv_lost', 1, 'open', { since: 10 })
    await w.emit(lost.key, 'pane_gone', w.at(1))
    replies.set(lost.path, 'a half-finished thought before a tool call')
    expect(await transport.pass()).toMatchObject({ retried: [lost.key] })
    expect(calls).toEqual([])
  })

  test('a job agw abandoned, or that another attempt won, is final: closed, no attempt 2, no person', async () => {
    for (const [job, error] of [
      ['rv_gone', 'job rv_gone was abandoned (a later prepare restarted its round)'],
      ['rv_won', 'job rv_won is already submitted by attempt 1'],
    ] as const) {
      const { key, path } = await attempt(job, 1, 'ended')
      replies.set(path, '{}')
      answers.push({ kind: 'refused', error })
      expect(await transport.pass()).toMatchObject({ superseded: [key], retried: [], needsHuman: [], submitted: [] })
      expect(fake.closed).toContain(key)
      expect(await outcome(key)).toMatchObject({ outcome: 'superseded' })
      expect((await spawnKeys()).filter((k) => k.startsWith(`review-${job}-`))).toEqual([key])
      expect(await reviewSessionsLive(db.sql, await liveSessions(db.sql, clock.now()))).toBe(0)
    }
    const status = Status.parse(await (await app.get('/status')).json())
    expect(status.health.filter((l) => l.includes('needs a human'))).toEqual([])
  })

  test('a walled reviewer is a failed attempt at once: closed, a2 that says usage limit, its slot back', async () => {
    const { key } = await attempt('rv_wall', 1, 'open', { since: 5 })
    await w.emit(key, 'limit_stop', w.at(1))
    expect((await getSession(db.sql, key, clock.now()))?.state).toBe('walled')
    expect(await transport.pass()).toMatchObject({ retried: [key], needsHuman: [] })
    expect(fake.closed).toEqual([key])
    expect(await outcome(key)).toMatchObject({ outcome: 'walled' })
    const [next] = await db.sql`SELECT prompt FROM factory.spawns WHERE key = ${reviewKey('rv_wall', 2)}`
    expect(next?.prompt).toContain('hit a usage limit')
    expect(next?.prompt).not.toContain('refused')
    expect(next?.prompt).not.toContain('wrote nothing')
    expect(await reviewSessionsLive(db.sql, await liveSessions(db.sql, clock.now()))).toBe(0)

    // The second attempt walled too: a person.
    const again = await attempt('rv_wall', 2, 'open', { since: 5 })
    await w.emit(again.key, 'limit_stop', w.at(1))
    expect(await transport.pass()).toMatchObject({ needsHuman: [again.key] })
    expect(await outcome(again.key)).toMatchObject({
      outcome: 'needs_human',
      detail: expect.stringContaining('walled'),
    })
  })

  test('a session that never starts its turn is a failed attempt after the idle limit, not before', async () => {
    const key = reviewKey('rv_silent', 1)
    await db.sql`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, account, session, created_at, placement, review_job, review_tier, review_effort)
      VALUES (${key}, ${TEST_REPO}, ${jobLine('rv_silent')}, 'reviewer', 'sonnet', 'medium', 'started', 'a', 't9', ${w.at(9)}, 'hidden', 'rv_silent', 'standard', 'medium')`
    await openSession(db.sql, { id: key, spawnKey: key, pane: 't9', at: w.at(9) })
    expect((await getSession(db.sql, key, clock.now()))?.state).toBe('starting')
    expect(await transport.pass()).toMatchObject({ retried: [], needsHuman: [] })
    expect(fake.closed).toEqual([])
    expect(await reviewSessionsLive(db.sql, await liveSessions(db.sql, clock.now()))).toBe(1)

    clock.advance(2 * 60_000)
    expect(await transport.pass()).toMatchObject({ retried: [key] })
    expect(fake.closed).toEqual([key])
    expect(await outcome(key)).toMatchObject({ outcome: 'idle' })
    expect(await reviewSessionsLive(db.sql, await liveSessions(db.sql, clock.now()))).toBe(0)
    expect(await spawnKeys()).toEqual([key, reviewKey('rv_silent', 2)])
  })

  describe('the idle watchdog', () => {
    const MIN = 60_000
    test('closes a session whose open turn has not written for ten minutes, then attempt 2, then a person', async () => {
      const { key, path } = await attempt('rv_idle', 1, 'open')
      written.set(path, new Date(clock.now().getTime() - 9 * MIN))
      expect(await transport.pass()).toMatchObject({ retried: [], needsHuman: [] })
      expect(fake.closed).toEqual([])

      clock.advance(2 * MIN)
      const result = await transport.pass()
      expect(result.retried).toEqual([key])
      expect(fake.closed).toEqual([key])
      expect(await outcome(key)).toMatchObject({ outcome: 'idle' })
      expect(calls).toEqual([])
      const second = reviewKey('rv_idle', 2)
      expect((await db.sql`SELECT review_job, prompt FROM factory.spawns WHERE key = ${second}`)[0]).toMatchObject({
        review_job: 'rv_idle',
      })

      // Attempt 2 stalls too.
      const again = await attempt('rv_idle', 2, 'open')
      written.set(again.path, new Date(clock.now().getTime() - 11 * MIN))
      expect((await transport.pass()).needsHuman).toEqual([second])
      expect(await outcome(second)).toMatchObject({ outcome: 'needs_human' })
      expect((await spawnKeys()).filter((k) => k.endsWith('-a3'))).toEqual([])
    })

    test('a wedged reviewer (terminal alive, no output past the window) is killed and its slot freed, a2 starts, and a wedged a2 is for a person', async () => {
      const live = async () => reviewSessionsLive(db.sql, await liveSessions(db.sql, clock.now()))
      const { key, path } = await attempt('rv_wedged', 1, 'open', { since: 5 })
      written.set(path, new Date(clock.now().getTime() - 5 * MIN))
      // The terminal is alive: no pane_gone, no turn end, the session still counts against the slots.
      expect((await getSession(db.sql, key, clock.now()))?.state).not.toBe('gone')
      expect(await live()).toBe(1)
      expect(await transport.pass()).toMatchObject({ retried: [], needsHuman: [] })
      expect(fake.closed).toEqual([])

      clock.advance(6 * MIN)
      expect(await transport.pass()).toMatchObject({ retried: [key] })
      expect(fake.closed).toEqual([key])
      expect(await outcome(key)).toMatchObject({ outcome: 'idle' })
      expect(await live()).toBe(0)
      const second = reviewKey('rv_wedged', 2)
      expect(await spawnKeys()).toEqual([key, second])

      // a2 starts, wedges the same way: killed, no a3, a person.
      const again = await attempt('rv_wedged', 2, 'open')
      written.set(again.path, new Date(clock.now().getTime() - 11 * MIN))
      expect(await live()).toBe(1)
      expect(await transport.pass()).toMatchObject({ needsHuman: [second] })
      expect(fake.closed).toEqual([key, second])
      expect(await outcome(second)).toMatchObject({ outcome: 'needs_human' })
      expect(await live()).toBe(0)
      expect(await spawnKeys()).toEqual([key, second])
    })

    test('a session that keeps writing is never closed, however long it runs', async () => {
      const { path } = await attempt('rv_busy', 1, 'open', { since: 600 })
      for (let i = 0; i < 4; i++) {
        clock.advance(30 * MIN)
        written.set(path, new Date(clock.now().getTime() - MIN))
        expect(await transport.pass()).toMatchObject({ retried: [], needsHuman: [] })
      }
      expect(fake.closed).toEqual([])
    })

    test('without a readable transcript the turn’s own start is the reference, and FACTORY_REVIEW_IDLE_MS moves the limit', async () => {
      const short = new ReviewTransport({
        sql: db.sql,
        clock,
        runner: fake,
        roles: TEST_ROLES,
        replies: { lastReply: async () => null },
        submitter,
        mtime: async () => undefined,
        limits: { ...DEFAULT_REVIEW_LIMITS, idleMs: 3 * MIN },
      })
      const { key } = await attempt('rv_short', 1, 'open', { since: 4 })
      expect((await short.pass()).retried).toEqual([key])
      await attempt('rv_long', 1, 'open', { since: 4 })
      expect((await transport.pass()).retried).toEqual([])
    })
  })
})

describe('the account of a review, end to end', () => {
  test('admission judges, the Runner launches and agw is told the same account; an account over the ceiling is never used', async () => {
    // `a`: no 5-hour reading, week 94 (over the 90 ceiling, under a worker's 95). `b`: week 72, 5 h at 0.
    await reading('a', 94, null)
    await reading('b', 72, 0)
    const w = world(db.sql, clock)
    const key = reviewKey('rv_acct', 1)
    await post(reviewerBody('rv_acct'))
    expect(await spawnRow(key)).toMatchObject({ status: 'queued', account: 'b' })
    expect((await runTick()).started).toEqual([key])
    expect(await spawnRow(key)).toMatchObject({ status: 'started', account: 'b' })

    // The Runner: that account's config directory and name, not another's.
    const env = (await hc.state()).runs[0]?.params.env as Record<string, string>
    expect(env).toMatchObject({ CLAUDE_ACCOUNT_PICKED: 'b', CLAUDE_CONFIG_DIR: '/home/me/.claude-b' })

    // The hook reports whatever account the pane says; the spawn's own wins, and that is what `--account` carries.
    const path = '/home/me/.claude-b/projects/-x/s.jsonl'
    await w.emit(key, 'session_started', w.at(3), { account: 'b', transcriptPath: path, claudeSessionId: 's' })
    await w.emit(key, 'turn_started', w.at(2))
    await w.emit(key, 'turn_ended', w.at(1))
    const calls: SubmitInput[] = []
    const transport = new ReviewTransport({
      sql: db.sql,
      clock,
      runner: new FakeRunner(),
      roles: TEST_ROLES,
      replies: { lastReply: async () => '{"ok":true}' },
      submitter: {
        submit: async (input) => {
          calls.push(input)
          return { kind: 'accepted', output: '{}' }
        },
      },
    })
    clock.advance(REPLY_GRACE_MS + 1_000)
    await transport.pass()
    expect(calls).toMatchObject([{ jobId: 'rv_acct', attempt: 1, account: 'b' }])

    // With only the over-ceiling account fresh, a review waits; it never starts there.
    await db.reset()
    await reading('a', 94, null)
    await post(reviewerBody('rv_over'))
    expect(await spawnRow(reviewKey('rv_over', 1))).toMatchObject({ status: 'waiting', account: null })
    expect((await runTick()).started).toEqual([])
  })
})

describe('agw review submit', () => {
  let dir: string
  let bin: string
  const previous = process.env.FAKE_AGW_OUT
  beforeAll(() => {
    dir = mkdtempSync('/tmp/factory-agw-')
    bin = join(dir, 'agw')
    writeFileSync(
      bin,
      `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_AGW_OUT/args"
cat > "$FAKE_AGW_OUT/stdin"
if [ -f "$FAKE_AGW_OUT/refuse" ]; then echo "schema mismatch: no verdict" >&2; exit 2; fi
if [ -f "$FAKE_AGW_OUT/slow" ]; then sleep 5; fi
echo '{"ok":true}'
`,
    )
    chmodSync(bin, 0o755)
    process.env.FAKE_AGW_OUT = dir
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.FAKE_AGW_OUT
    else process.env.FAKE_AGW_OUT = previous
  })
  const input: SubmitInput = { jobId: 'rv_ddx2xwgrsnyz7mh4rrwy', attempt: 2, account: 'b', reply: ' {"a":"é"}\n\n' }

  test('is called with the job, the attempt, the account and --commit, and the reply on stdin untouched', async () => {
    const answer = await new AgwSubmitter({ bin }).submit(input)
    expect(answer).toEqual({ kind: 'accepted', output: '{"ok":true}' })
    expect(readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')).toEqual([
      'review',
      'submit',
      'rv_ddx2xwgrsnyz7mh4rrwy',
      '--attempt',
      '2',
      '--account',
      'b',
      '--commit',
      '--format',
      'json',
    ])
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe(input.reply)
  })

  test('a non-zero exit is a refusal that carries agw’s message; a missing binary or a hang is no answer', async () => {
    writeFileSync(join(dir, 'refuse'), '')
    expect(await new AgwSubmitter({ bin }).submit(input)).toEqual({
      kind: 'refused',
      error: 'schema mismatch: no verdict',
    })
    rmSync(join(dir, 'refuse'))
    expect(await new AgwSubmitter({ bin: join(dir, 'nowhere') }).submit(input)).toMatchObject({ kind: 'unavailable' })
    writeFileSync(join(dir, 'slow'), '')
    expect(await new AgwSubmitter({ bin, timeoutMs: 300 }).submit(input)).toMatchObject({ kind: 'unavailable' })
    rmSync(join(dir, 'slow'))
  })
})

describe('the tick and the status', () => {
  test('the tick kicks the transport once per pass, after the claims', async () => {
    let kicks = 0
    await runTick(undefined, { reviews: { kick: () => void kicks++ } })
    expect(kicks).toBe(1)
  })

  test('factory status shows the reviews line, with the deep count against the cap per account', async () => {
    await readings()
    await post(reviewerBody('rv_st', {}, { tier: 'deep' }))
    await runTick()
    const status = Status.parse(await (await app.get('/status')).json())
    expect(status.reviews).toEqual({ live: 1, slots: 2, deepCap: 15, deepToday: [{ account: 'a', started: 1 }] })
    expect(statusScreen(status)).toContain('reviews: 1/2 live, deep today 1/15 per account (a 1)')
  })
})
