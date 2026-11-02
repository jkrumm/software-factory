import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { IssueVerbAck, type StopCheck } from '@software-factory/contract'
import { serveHooks } from '../src/http.ts'
import { Classification } from '../src/issues/classify.ts'
import { createIssue } from '../src/issues/create.ts'
import { briefPromptId, leadKey, leadPorts } from '../src/issues/lead.ts'
import { enqueue } from '../src/issues/inbox.ts'
import { ProjectSync } from '../src/projects/sync.ts'
import { QuotaPoller } from '../src/quota.ts'
import { stopCheck } from '../src/rules.ts'
import { openSession, recordEvent } from '../src/sessions.ts'
import { type EventKind } from '../src/sessions.ts'
import { createSpawn } from '../src/spawns.ts'
import { tick } from '../src/tick.ts'
import { startApp, TEST_ROLES, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClassifier } from './support/classifier.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { FakeQuotaSource, usage } from './support/quota.ts'
import { repoRoot } from './support/repos.ts'
import { FakeRunner } from './support/world.ts'
import { FakeWorktrees } from './support/worktree.ts'
import type { StartInput, StartResult } from '../src/runner.ts'

/** A runner whose panes are terminals of the current core, so a spawn it started does not read as ended. */
class PaneRunner extends FakeRunner {
  panes = 0
  override async start(input: StartInput): Promise<StartResult> {
    await super.start(input)
    return { session: `t${++this.panes}`, tab: null, workspace: 'w1' }
  }
}

let db: TestDb
let clock: FakeClock
const fixture = repoRoot('factory-lead-')
let app: TestApp
let sync: ProjectSync
let classifier: FakeClassifier
let worktrees: FakeWorktrees
let runner: PaneRunner
let classification: Classification
let alerts = false
let n = 0

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(async () => {
  await db.stop()
  fixture.cleanup()
})
async function setup() {
  await db.reset()
  clock = new FakeClock()
  n = 0
  alerts = false
  const source = new FakeQuotaSource()
  source.readings = ['a', 'b'].map((account) => ({
    account,
    ...usage(1, 1, new Date(clock.now().getTime() + 1_000 * 3_600_000)),
  }))
  await new QuotaPoller({ sql: db.sql, clock, source }).poll()
  classifier = new FakeClassifier()
  worktrees = new FakeWorktrees()
  runner = new PaneRunner()
  classification = new Classification({ sql: db.sql, classifier, roles: TEST_ROLES, now: () => clock.now() })
  sync = new ProjectSync({ sql: db.sql, roots: [fixture.root], now: () => clock.now() })
  await app?.stop()
  app = startApp({
    sql: db.sql,
    clock,
    repoRoots: [fixture.root],
    get alertLeads() {
      return alerts
    },
  })
}
beforeEach(setup)

const statusOf = async () => (await (await app.get('/status')).json()) as { attention: string[] }

const ports = () => leadPorts({ sql: db.sql, clock, roles: TEST_ROLES, repoRoots: [fixture.root], worktrees })

/** One tick of the server, then the classifies it started finish. */
async function pass(extra: { issuePorts?: ReturnType<typeof ports>; settle?: boolean } = {}) {
  const result = await tick({
    sql: db.sql,
    clock,
    runner,
    issuePorts: extra.issuePorts ?? ports(),
    classification,
    projects: sync,
    alertLeads: alerts,
  })
  if (extra.settle !== false) await classification.settled()
  clock.advance(5_000)
  return result
}
const drive = async (passes = 4) => {
  for (let i = 0; i < passes; i++) await pass()
}

let repos = 0
const newRepo = (files: Record<string, string> = {}) => fixture.repo(`repo${++repos}`, files)

async function file(repo: string, source = 'request', title = 'the title'): Promise<number> {
  const { issue } = await createIssue(
    db.sql,
    { source, sourceKey: `k${++n}`, repo, title, facts: { note: 'data' } },
    { repoRoots: [fixture.root], now: clock.now() },
  )
  return issue.id
}

const issue = async (id: number) => {
  const [row] = await db.sql`SELECT * FROM factory.issues WHERE id = ${id}`
  return row as Record<string, unknown> & { wake_at: Date; hold: number }
}
const trail = async (id: number) => {
  const rows =
    await db.sql`SELECT kind, from_state, to_state, payload FROM factory.issue_events WHERE issue_id = ${id} ORDER BY id`
  return rows.map((r: { kind: string; from_state: string | null; to_state: string | null }) =>
    r.to_state ? `${r.kind} ${r.from_state ?? '-'}→${r.to_state}` : r.kind,
  ) as string[]
}
const spawns = async () =>
  db.sql`SELECT key, status, role, tier, effort, repo, space, issue_id, prompt, hold FROM factory.spawns ORDER BY key`
const sessionRow = async (id: string) => (await db.sql`SELECT * FROM factory.sessions WHERE id = ${id}`)[0]

/** A filed, classified, admitted Issue whose lead has been started by the runner. */
async function lead(repo = newRepo(), source = 'request') {
  const id = await file(repo, source)
  alerts = source === 'alert' ? true : alerts
  await drive(4)
  return { id, key: leadKey(id, 1), repo }
}

let events = 0
const emit = (session: string, kind: EventKind, at: Date = clock.now(), payload?: Record<string, unknown>) =>
  recordEvent(db.sql, { key: `e${++events}`, session, kind, at, payload })

describe('classify, then admission', () => {
  test('a request is classified, admitted, and gets a lead: a worktree, a spawn, a session of its Issue', async () => {
    classifier.answer = { project: null, kind: 'bug', class: 'routine', size: 's', tier: 'sonnet', effort: 'medium' }
    const repo = newRepo()
    const id = await file(repo)
    await drive(4)

    expect(await trail(id)).toEqual(['created -→queued', 'classified', 'admitted queued→working'])
    expect(await issue(id)).toMatchObject({
      state: 'working',
      attempt: 1,
      kind: 'bug',
      lead_tier: 'sonnet',
      lead_effort: 'medium',
    })
    expect(worktrees.made).toEqual([{ repo, branch: `factory/${id}-1` }])

    const [spawn, ...rest] = await spawns()
    expect(rest).toEqual([])
    expect(spawn).toMatchObject({
      key: `lead-${id}-1`,
      role: 'lead',
      tier: 'sonnet',
      effort: 'medium',
      repo: `${repo}/.claude/worktrees/factory-${id}-1`,
      space: repo,
      issue_id: id,
      status: 'started',
    })
    // The runner got the brief as the lead's argument, in the worktree, in the main checkout's space.
    expect(runner.started).toHaveLength(1)
    expect(runner.started[0]).toMatchObject({
      key: `lead-${id}-1`,
      role: 'lead',
      tier: 'sonnet',
      effort: 'medium',
      space: repo,
    })
    expect(runner.started[0]?.prompt).toContain('# Standing orders')
    expect(runner.started[0]?.prompt).toContain(`# Issue ${id}`)
    expect(runner.started[0]?.prompt).toContain(`factory/${id}-1`)
    // The brief is recorded under its prompt id before anything types it, and never typed a second time.
    const [prompt] = await db.sql`SELECT id, session, source, status FROM factory.prompts`
    expect(prompt).toMatchObject({
      id: briefPromptId(id, 1),
      session: `lead-${id}-1`,
      source: 'brief',
      status: 'delivered',
    })
    expect(runner.typed).toEqual([])
    // Its session belongs to the Issue, so its events reach the inbox.
    expect(await sessionRow(`lead-${id}-1`)).toMatchObject({ issue_id: id })
    await emit(`lead-${id}-1`, 'session_started', clock.now(), { claudeSessionId: 'c1' })
    expect(await db.sql`SELECT kind FROM factory.issue_inbox WHERE session = ${`lead-${id}-1`}`).toEqual([
      { kind: 'session_started' },
    ])
  })

  test('a classify that failed still gets a lead, on the role table’s defaults', async () => {
    classifier.failure = new Error('agw is down')
    const id = await file(newRepo())
    await drive(4)
    expect(await trail(id)).toEqual(['created -→queued', 'classify_failed', 'admitted queued→working'])
    expect((await spawns())[0]).toMatchObject({ role: 'lead', tier: 'opus', effort: 'high' })
  })

  test('an Issue is not admitted before it is classified', async () => {
    let open!: () => void
    classifier.gate = new Promise<void>((resolve) => (open = resolve))
    const id = await file(newRepo())
    await pass({ settle: false })
    await pass({ settle: false })
    expect((await issue(id)).state).toBe('queued')
    expect(await spawns()).toEqual([])
    open()
    await classification.settled()
    await drive(3)
    expect((await issue(id)).state).toBe('working')
  })

  test('a second admission attaches: one event, one worktree, one spawn, one brief', async () => {
    const { id } = await lead()
    // The admission asked again, and the effect ran again (a replay): the keys make both the same row.
    expect(await enqueue(db.sql, { issueId: id, key: `admit:${id}:1`, kind: 'admitted', at: clock.now() })).toEqual({
      duplicate: true,
    })
    await db.sql`UPDATE factory.issue_effects SET done_at = NULL WHERE kind = 'start_lead'`
    await drive(2)
    expect(worktrees.made).toHaveLength(1)
    expect(await spawns()).toHaveLength(1)
    expect(await db.sql`SELECT 1 FROM factory.prompts WHERE source = 'brief'`).toHaveLength(1)
    expect(runner.started).toHaveLength(1)
    expect((await issue(id)).attempt).toBe(1)
  })

  test('with the claim full the second Issue stays queued, and is admitted when the first closes', async () => {
    const repo = newRepo()
    const first = await file(repo)
    const second = await file(repo)
    await drive(5)
    expect((await issue(first)).state).toBe('working')
    expect((await issue(second)).state).toBe('queued')
    expect(await trail(second)).toEqual(['created -→queued', 'classified'])
    expect(worktrees.made).toHaveLength(1)
    // It says why in `factory status`.
    const status = await statusOf()
    expect(status.attention).toContain(`Issue ${second} waits for the claim on ${repo.split('/').pop()}`)

    const stop = await app.send('POST', `/issues/${first}/drop`, { reason: 'not needed' })
    expect(stop.status).toBe(201)
    await drive(4)
    expect((await issue(first)).state).toBe('closed')
    expect((await issue(second)).state).toBe('working')
    expect(worktrees.made.map((w) => w.branch)).toEqual([`factory/${first}-1`, `factory/${second}-1`])
  })

  test('an alert starts no lead while the switch is off, says why in status, and starts one with it on; a request is not asked', async () => {
    const repo = newRepo()
    const alert = await file(repo, 'alert', 'a Kuma alert')
    const other = newRepo()
    const request = await file(other)
    await drive(5)
    expect((await issue(alert)).state).toBe('queued')
    expect((await issue(request)).state).toBe('working')
    expect(await trail(alert)).toEqual(['created -→queued', 'classified'])
    const status = await statusOf()
    expect(status.attention).toContain(`Issue ${alert} is an alert and starts no lead: FACTORY_ALERT_LEADS is not set`)

    alerts = true
    await drive(4)
    expect((await issue(alert)).state).toBe('working')
    expect(worktrees.made.map((w) => w.repo)).toContain(repo)
    const after = await statusOf()
    expect(after.attention.some((line: string) => line.includes('starts no lead'))).toBe(false)
  })

  test('a drain and a paused project hold admission back', async () => {
    const repo = newRepo()
    const id = await file(repo)
    await app.send('PUT', '/queue', { state: 'drain' })
    await drive(4)
    expect((await issue(id)).state).toBe('queued')
    await app.send('PUT', '/queue', { state: 'run' })
    await db.sql`UPDATE factory.projects SET paused = true`
    await drive(3)
    expect((await issue(id)).state).toBe('queued')
    await db.sql`UPDATE factory.projects SET paused = false`
    await drive(4)
    expect((await issue(id)).state).toBe('working')
  })

  test('the lead starts at the level of the role table now, with the floor, whatever was stored', async () => {
    // Classified long ago, when the table said otherwise: what is stored is out of date.
    const classified = async (id: number, set: { tier: string; effort: string; kind: string; class: string }) =>
      db.sql`
        UPDATE factory.issues SET classified_at = ${clock.now()}, lead_tier = ${set.tier}, lead_effort = ${set.effort},
          kind = ${set.kind}, class = ${set.class} WHERE id = ${id}`
    const id = await file(newRepo())
    await classified(id, { tier: 'opus', effort: 'max', kind: 'bug', class: 'routine' })
    const incident = await file(newRepo())
    await classified(incident, { tier: 'haiku', effort: 'low', kind: 'incident', class: 'routine' })
    await drive(4)
    const started = async (issueId: number) =>
      (await spawns()).find((s: { key: string }) => s.key === `lead-${issueId}-1`)
    expect(await started(id)).toMatchObject({ tier: 'opus', effort: 'high' })
    expect(await started(incident)).toMatchObject({ tier: 'sonnet', effort: 'high' })
  })

  test('a worktree that cannot be made keeps the effect open, shows in status, and goes on when it can', async () => {
    worktrees.failure = new Error('git fetch origin failed (exit 128)')
    const id = await file(newRepo())
    await drive(5)
    expect((await issue(id)).state).toBe('working')
    expect(await spawns()).toEqual([])
    const status = await statusOf()
    expect(status.attention).toContain(`Issue ${id}: its lead did not start: git fetch origin failed (exit 128)`)
    worktrees.failure = undefined
    await drive(3)
    expect(await spawns()).toHaveLength(1)
  })

  test('issue_id is on the lead’s session only: a worker the lead starts has none', async () => {
    const { id, key } = await lead()
    await emit(key, 'session_started', clock.now(), { claudeSessionId: 'c1' })
    await createSpawn(
      db.sql,
      {
        key: 'worker-1',
        repo: (await spawns())[0]?.repo,
        prompt: 'work',
        role: 'worker',
        tier: 'sonnet',
        effort: 'high',
        parent: key,
      },
      clock.now(),
    )
    await pass()
    expect(await sessionRow('worker-1')).toMatchObject({ spawn_key: 'worker-1', issue_id: null })
    expect(await sessionRow(key)).toMatchObject({ issue_id: id })
    // A worker's wall does not reach the Issue.
    await emit('worker-1', 'limit_stop')
    await pass()
    expect((await issue(id)).state).toBe('working')
  })
})

const post = (id: number, verb: string, body: Record<string, unknown> = {}) =>
  app.send('POST', `/issues/${id}/${verb}`, body)

describe('the lead’s verbs', () => {
  test('phase is recorded and the Issue stays working', async () => {
    const { id, key } = await lead()
    const response = await post(id, 'phase', { id: 'c1', phase: 'build', note: 'started', session: key })
    expect(response.status).toBe(201)
    expect(IssueVerbAck.parse(await response.json())).toEqual({
      issue: id,
      verb: 'phase',
      key: `${id}:1:phase:c1`,
      duplicate: false,
      state: 'working',
    })
    await pass()
    expect(await trail(id)).toContain('phase')
    expect((await issue(id)).state).toBe('working')
  })

  test('the same call twice is one event, and the second answers duplicate', async () => {
    const { id } = await lead()
    expect((await post(id, 'phase', { id: 'again', phase: 'plan' })).status).toBe(201)
    const second = await post(id, 'phase', { id: 'again', phase: 'plan' })
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ duplicate: true })
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE key = ${`${id}:1:phase:again`}`).toHaveLength(1)
  })

  test('wait parks until a time and wakes the lead then', async () => {
    const { id, key } = await lead()
    const until = new Date(clock.now().getTime() + 3_600_000).toISOString()
    await post(id, 'wait', { until, why: 'a deploy', session: key })
    await pass()
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'wait' })
    expect((await issue(id)).wake_at.toISOString()).toBe(until)
    clock.advance(3_700_000)
    await drive(3)
    expect((await issue(id)).state).toBe('working')
  })

  test('ship starts the hold, and a close with nothing deployed ends it', async () => {
    const shipped = await lead()
    await post(shipped.id, 'ship', {
      summary: 'done\nit works',
      evidence: [{ kind: 'commit', link: 'https://example.com/c/1' }],
      session: shipped.key,
    })
    await pass()
    expect(await issue(shipped.id)).toMatchObject({ state: 'watching', hold: 1 })
    const closed = await lead()
    await post(closed.id, 'close', { summary: 'a doc change', session: closed.key })
    await pass()
    expect(await issue(closed.id)).toMatchObject({ state: 'closed', outcome: 'done' })
  })

  test('block waits for the owner with its reason in status; drop closes as dropped', async () => {
    const blocked = await lead()
    await post(blocked.id, 'block', { reason: 'needs a credential nobody has', session: blocked.key })
    await pass()
    expect(await issue(blocked.id)).toMatchObject({ state: 'waiting', reason: 'blocked' })
    const status = await statusOf()
    expect(status.attention).toContain(`Issue ${blocked.id} blocked: needs a credential nobody has`)
    const dropped = await lead()
    await post(dropped.id, 'drop', { reason: 'the owner changed their mind', session: dropped.key })
    await pass()
    expect(await issue(dropped.id)).toMatchObject({ state: 'closed', outcome: 'dropped' })
  })

  test('ask records a decision, shows in status, and sets the wake to its expiry', async () => {
    const { id, key } = await lead()
    const expiresAt = new Date(clock.now().getTime() + 2 * 3_600_000).toISOString()
    await post(id, 'ask', {
      id: 'q1',
      question: 'Which port?',
      options: ['80', '8080'],
      default: '8080',
      expiresAt,
      session: key,
    })
    await pass()
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'decision' })
    expect((await issue(id)).wake_at.toISOString()).toBe(expiresAt)
    const [decision] = await db.sql`SELECT key, question, options, default_option, answered_at FROM factory.decisions`
    expect(decision).toMatchObject({
      key: `${id}:1:ask:q1`,
      question: 'Which port?',
      options: ['80', '8080'],
      default_option: '8080',
      answered_at: null,
    })
    const status = await statusOf()
    expect(status.attention).toContain(`Issue ${id} asks: Which port? (default 8080, until ${expiresAt})`)
  })

  test('an expired ask takes its default and tells the lead; one with no default stays open with a line for the owner', async () => {
    const withDefault = await lead()
    const expiresAt = new Date(clock.now().getTime() + 600_000).toISOString()
    await post(withDefault.id, 'ask', {
      question: 'Which port?',
      options: ['80', '8080'],
      default: '8080',
      expiresAt,
      session: withDefault.key,
    })
    const bare = await lead()
    await post(bare.id, 'ask', { question: 'Rename it?', expiresAt, session: bare.key })
    await emit(withDefault.key, 'session_started', clock.now(), { claudeSessionId: 'c1' })
    await emit(withDefault.key, 'turn_started')
    await emit(withDefault.key, 'turn_ended')
    await pass()
    expect((await issue(withDefault.id)).state).toBe('waiting')

    clock.advance(700_000)
    await drive(3)
    expect(await issue(withDefault.id)).toMatchObject({ state: 'working', reason: null, wake_at: null })
    const [answered] =
      await db.sql`SELECT answer, answered_by FROM factory.decisions WHERE issue_id = ${withDefault.id}`
    expect(answered).toEqual({ answer: '8080', answered_by: 'default' })
    const [note] =
      await db.sql`SELECT text, session FROM factory.prompts WHERE source = 'note' AND session = ${withDefault.key}`
    expect(note?.text).toContain('your question was answered (default): 8080')

    expect(await issue(bare.id)).toMatchObject({ state: 'waiting', reason: 'decision', wake_at: null })
    expect(await trail(bare.id)).toContain('lapsed')
    const status = await statusOf()
    expect(status.attention).toContain(`Issue ${bare.id} asks: Rename it? (expired with no default)`)
    // An owner’s answer is still taken.
    await enqueue(db.sql, {
      issueId: bare.id,
      key: `answer:${bare.id}:late`,
      kind: 'answer',
      at: clock.now(),
      payload: { answer: 'yes' },
    })
    await drive(2)
    expect((await issue(bare.id)).state).toBe('working')
  })

  test('a session reports on its own Issue only; unknown Issues and bad bodies are refused', async () => {
    const mine = await lead()
    const theirs = await lead()
    expect((await post(theirs.id, 'phase', { phase: 'x', session: mine.key })).status).toBe(409)
    expect((await post(theirs.id, 'phase', { phase: 'x', session: 'rd-session' })).status).toBe(409)
    expect((await post(4242, 'phase', { phase: 'x' })).status).toBe(404)
    expect((await post(mine.id, 'phase', {})).status).toBe(400)
    expect((await post(mine.id, 'wait', { until: 'tomorrow' })).status).toBe(400)
    expect((await post(mine.id, 'ask', { question: 'q', options: ['a'], default: 'b' })).status).toBe(400)
    expect((await post(mine.id, 'ship', { summary: 's', surprise: true })).status).toBe(400)
    expect((await post(mine.id, 'fly', {})).status).toBe(400)
    expect(
      (
        await app.bare(`/issues/${mine.id}/phase`, {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(401)
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind IN ('phase', 'wait', 'ask', 'ship')`).toHaveLength(
      0,
    )
  })

  test('the attempt is in the key, and only the Issue’s current lead is heard', async () => {
    const { id, key } = await lead()
    expect((await post(id, 'phase', { id: 'same', phase: 'a', session: key })).status).toBe(201)
    // A second attempt: the earlier lead is still open, and the same call id is a new event.
    await db.sql`UPDATE factory.issues SET attempt = 2 WHERE id = ${id}`
    const stale = await post(id, 'phase', { id: 'same', phase: 'b', session: key })
    expect(stale.status).toBe(409)
    const second = await post(id, 'phase', { id: 'same', phase: 'b' })
    expect(second.status).toBe(201)
    expect(await second.json()).toMatchObject({ key: `${id}:2:phase:same`, duplicate: false })
  })

  test('a lead reports through the socket with no token', async () => {
    const dir = mkdtempSync('/tmp/factory-lead-sock-')
    const socketPath = join(dir, 'h.sock')
    const hooks = serveHooks({
      sql: db.sql,
      clock,
      token: TEST_TOKEN,
      socketPath,
      repoRoots: [fixture.root],
      roles: TEST_ROLES,
      slots: 2,
    })
    try {
      const { id, key } = await lead()
      const response = await fetch(`http://localhost/issues/${id}/block`, {
        unix: socketPath,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'stuck', session: key, id: 'sock' }),
      })
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({ key: `${id}:1:block:sock` })
    } finally {
      await hooks.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('what the review found', () => {
  test('a regression reaches the lead as a regression, not as generic news', async () => {
    const { id, key } = await lead()
    await emit(key, 'session_started', clock.now(), { claudeSessionId: 'c1' })
    await post(id, 'ship', { summary: 'shipped', session: key })
    await pass()
    await enqueue(db.sql, {
      issueId: id,
      key: `sig:${id}`,
      kind: 'signal',
      at: clock.now(),
      payload: { regression: true, summary: '500s on /login' },
    })
    await drive(2)
    expect((await issue(id)).state).toBe('working')
    const [note] = await db.sql`SELECT text FROM factory.prompts WHERE source = 'note' AND session = ${key}`
    expect(note?.text).toContain('a regression was reported after your ship: 500s on /login')
  })

  test('an expiry answers the question it was set for, not one asked since', async () => {
    const { id, key } = await lead()
    const expiresAt = new Date(clock.now().getTime() + 600_000).toISOString()
    await post(id, 'ask', { id: 'old', question: 'old?', default: 'x', expiresAt, session: key })
    await pass()
    const [old] = await db.sql`SELECT id FROM factory.decisions`
    // The owner answers, the lead asks again, and only then does the old expiry's answer come up.
    await enqueue(db.sql, {
      issueId: id,
      key: `answer:${id}:o`,
      kind: 'answer',
      at: clock.now(),
      payload: { answer: 'yes' },
    })
    await pass()
    await post(id, 'ask', { id: 'new', question: 'new?', session: key })
    await pass()
    await enqueue(db.sql, {
      issueId: id,
      key: `answer:${id}:late`,
      kind: 'answer',
      at: clock.now(),
      payload: { answer: 'x', who: 'default', decision: Number(old?.id) },
    })
    await pass()
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'decision' })
    expect(await db.sql`SELECT 1 FROM factory.issue_events WHERE issue_id = ${id} AND kind = 'refused'`).toHaveLength(1)
    expect(await db.sql`SELECT 1 FROM factory.decisions WHERE answered_at IS NULL`).toHaveLength(1)
  })

  test('a business question never takes its default', async () => {
    classifier.answer = { project: null, kind: 'bug', class: 'business', size: 's', tier: 'sonnet', effort: 'medium' }
    const { id, key } = await lead()
    const expiresAt = new Date(clock.now().getTime() + 600_000).toISOString()
    await post(id, 'ask', {
      question: 'Raise the price?',
      options: ['yes', 'no'],
      default: 'yes',
      expiresAt,
      session: key,
    })
    await pass()
    clock.advance(700_000)
    await drive(2)
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'decision' })
    expect(await trail(id)).toContain('lapsed')
  })

  test('an urgent Issue’s business classification still keeps its questions the owner’s', async () => {
    classifier.answer = { project: null, kind: 'bug', class: 'business', size: 's', tier: 'sonnet', effort: 'medium' }
    const id = await file(newRepo())
    await db.sql`UPDATE factory.issues SET class = 'urgent' WHERE id = ${id}`
    await drive(4)
    const key = leadKey(id, 1)
    const expiresAt = new Date(clock.now().getTime() + 600_000).toISOString()
    await post(id, 'ask', { question: 'Raise the price?', default: 'yes', expiresAt, session: key })
    await pass()
    clock.advance(700_000)
    await drive(2)
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'decision', class: 'urgent' })
  })

  test('a stop that a later turn has overtaken parks nothing', async () => {
    const { id, key } = await lead()
    await emit(key, 'session_started', clock.now(), { claudeSessionId: 'c1' })
    clock.advance(1_000)
    await emit(key, 'turn_started')
    clock.advance(1_000)
    await enqueue(db.sql, {
      issueId: id,
      key: `unreported:${id}:${key}:1`,
      kind: 'unreported',
      at: clock.now(),
      session: key,
      payload: { turn: 1 },
    })
    clock.advance(1_000)
    // The lead began another turn before the tick got to the stop.
    await emit(key, 'turn_started')
    await pass()
    expect((await issue(id)).state).toBe('working')
    expect(await trail(id)).toContain('refused')
  })

  test('only a project’s oldest queued Issue is looked at, and an incident takes the urgent place', async () => {
    const repo = newRepo()
    const first = await file(repo)
    const second = await file(repo)
    const third = await file(repo)
    // Classified already (the third is an incident), so only admission decides what happens.
    await db.sql`UPDATE factory.issues SET classified_at = ${clock.now()}, lead_tier = 'sonnet', lead_effort = 'high', kind = 'bug'`
    await db.sql`UPDATE factory.issues SET kind = 'incident' WHERE id = ${third}`
    await drive(4)
    // The first holds the one ordinary place; the incident takes the urgent one; the second waits, and was never looked at.
    expect((await issue(first)).state).toBe('working')
    expect((await issue(third)).state).toBe('working')
    expect((await issue(second)).state).toBe('queued')
    const claims =
      await db.sql`SELECT issue_id, urgent, held_at IS NOT NULL AS held FROM factory.claims ORDER BY issue_id`
    expect(claims).toEqual([
      { issue_id: first, urgent: false, held: true },
      { issue_id: second, urgent: false, held: false },
      { issue_id: third, urgent: true, held: true },
    ])
  })

  test('Issues the claim cannot take do not starve the ones behind them', async () => {
    const held = newRepo()
    for (let i = 0; i < 22; i++) await file(held, 'alert')
    // They are classified already, so only admission stands between them and a lead.
    await db.sql`UPDATE factory.issues SET classified_at = ${clock.now()}, lead_tier = 'opus', lead_effort = 'high'`
    const other = newRepo()
    const request = await file(other)
    await drive(4)
    expect((await issue(request)).state).toBe('working')
  })

  test('a classify keeps the kind and class an Issue already has, urgent included', async () => {
    const id = await file(newRepo())
    await db.sql`UPDATE factory.issues SET class = 'urgent', kind = 'incident' WHERE id = ${id}`
    await drive(1)
    expect(await issue(id)).toMatchObject({ class: 'urgent', kind: 'incident', size: 's' })
  })

  test('a lead’s name is reserved, and a spawn of that name that is not the Issue’s lead is not attached to', async () => {
    const id = await file(newRepo())
    const taken = await app.send('POST', '/spawns', { key: `lead-${id}-1`, repo: fixture.root, prompt: 'x' })
    expect(taken.status).toBe(400)
    await createSpawn(
      db.sql,
      { key: `lead-${id}-1`, repo: fixture.root, prompt: 'x', role: 'worker', tier: 'sonnet', effort: 'high' },
      clock.now(),
    )
    await drive(4)
    expect(runner.started.some((start) => start.prompt.includes('# Standing orders'))).toBe(false)
    const status = await statusOf()
    expect(status.attention.some((line) => line.includes("is not this Issue's lead"))).toBe(true)
  })

  test('on the socket a verb needs a session that works the Issue; the port does not', async () => {
    const dir = mkdtempSync('/tmp/factory-lead-sock-')
    const socketPath = join(dir, 'h.sock')
    const hooks = serveHooks({
      sql: db.sql,
      clock,
      token: TEST_TOKEN,
      socketPath,
      repoRoots: [fixture.root],
      roles: TEST_ROLES,
      slots: 2,
    })
    try {
      const { id, key } = await lead()
      const send = (body: Record<string, unknown>) =>
        fetch(`http://localhost/issues/${id}/phase`, {
          unix: socketPath,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      expect((await send({ phase: 'x' })).status).toBe(409)
      expect((await send({ phase: 'x', session: 'someone-else' })).status).toBe(409)
      expect((await send({ phase: 'x', session: key })).status).toBe(201)
      expect((await post(id, 'phase', { phase: 'x' })).status).toBe(201)
    } finally {
      await hooks.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a time before 1970 is refused at the door', async () => {
    const { id } = await lead()
    expect((await post(id, 'wait', { until: '1969-12-31T00:00:00Z' })).status).toBe(400)
    expect((await post(id, 'ask', { question: 'q', expiresAt: '0001-01-01T00:00:00Z' })).status).toBe(400)
  })
})

describe('factory issue <verb>', () => {
  const CLI = join(import.meta.dir, '..', '..', 'cli', 'bin', 'factory.ts')
  async function factory(env: Record<string, string>, ...args: string[]) {
    const proc = Bun.spawn(['bun', CLI, ...args], {
      env: {
        ...process.env,
        FACTORY_URL: app.url.href,
        FACTORY_TOKEN: TEST_TOKEN,
        FACTORY_SOCKET: '/nonexistent',
        ...env,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
    return { stdout, stderr, code }
  }

  test('each verb files one event from the flags; FACTORY_SESSION says which lead; --id makes a repeat one event', async () => {
    const { id, key } = await lead()
    const env = { FACTORY_SESSION: key }
    const until = new Date(clock.now().getTime() + 3_600_000).toISOString()
    const calls: string[][] = [
      ['phase', String(id), '--phase', 'build', '--note', 'half way', '--id', 'p1'],
      ['wait', String(id), '--until', until, '--why', 'a deploy', '--id', 'w1'],
      [
        'ship',
        String(id),
        '--summary',
        'shipped',
        '--evidence',
        'kind=commit,link=https://example.com/c,note=a, b',
        '--id',
        's1',
      ],
      ['close', String(id), '--summary', 'nothing deployed', '--id', 'c1'],
      ['block', String(id), '--reason', 'no key', '--id', 'b1'],
      [
        'ask',
        String(id),
        '--question',
        'Which?',
        '--option',
        'a',
        '--option',
        'b',
        '--default',
        'a',
        '--expires',
        until,
        '--id',
        'a1',
      ],
      ['drop', String(id), '--reason', 'not needed', '--id', 'd1'],
    ]
    for (const args of calls) {
      const result = await factory(env, 'issue', ...args, '--format', 'plain')
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${id}\t${args[0]}\tfiled\t${id}:1:${args[0]}:${args.at(-1)}\tworking\n`)
    }
    const rows =
      await db.sql`SELECT kind, session, payload FROM factory.issue_inbox WHERE key LIKE ${`${id}:%`} AND session = ${key} ORDER BY id`
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual([
      'phase',
      'wait',
      'ship',
      'close',
      'block',
      'ask',
      'drop',
    ])
    expect(rows[2]?.payload).toEqual({
      summary: 'shipped',
      evidence: [{ kind: 'commit', link: 'https://example.com/c', note: 'a, b' }],
    })
    expect(rows[5]?.payload).toEqual({ question: 'Which?', options: ['a', 'b'], default: 'a', expiresAt: until })

    const again = await factory(env, 'issue', ...(calls[0] ?? []), '--format', 'plain')
    expect(again.stdout).toContain('\tduplicate\t')
  })

  test('a missing flag, a bad id and another Issue’s session are refused', async () => {
    const mine = await lead()
    const theirs = await lead()
    expect((await factory({}, 'issue', 'ship', String(mine.id))).code).toBe(2)
    expect((await factory({}, 'issue', 'ship', 'abc', '--summary', 's')).code).toBe(2)
    const wrong = await factory({ FACTORY_SESSION: mine.key }, 'issue', 'phase', String(theirs.id), '--phase', 'x')
    expect(wrong.code).not.toBe(0)
    expect(wrong.stderr).toContain('does not work this Issue')
    expect((await factory({}, 'issue', 'ship', '4242', '--summary', 's')).code).toBe(4)
  })
})

describe('the lead’s send-back', () => {
  const stop = (session: string, active = false): Promise<StopCheck> =>
    stopCheck(db.sql, session, { stopHookActive: active }, clock.now())

  /** A lead whose first turn (the brief) is running. */
  async function running() {
    const lead_ = await lead()
    await emit(lead_.key, 'session_started', clock.now(), { claudeSessionId: 'c1' })
    clock.advance(1_000)
    await emit(lead_.key, 'turn_started')
    clock.advance(1_000)
    return lead_
  }

  test('a stop with nothing reported is sent back once, with the verbs to report with', async () => {
    const { id, key } = await running()
    const first = await stop(key)
    expect(first.sendBack).toBe(true)
    expect(first.message).toContain(`Issue ${id}`)
    expect(first.message).toContain('factory issue ship|close|block|ask|wait|drop')
    // The same stop asked again (a retried hook) records nothing and is let through.
    expect(await stop(key)).toEqual({ sendBack: false, message: null })
    expect(await db.sql`SELECT 1 FROM factory.effects WHERE rule = 'issue-sendback'`).toHaveLength(1)
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind = 'unreported'`).toHaveLength(0)
    expect((await issue(id)).state).toBe('working')
  })

  test('a second unreported stop parks the Issue with a line for the owner', async () => {
    const { id, key } = await running()
    expect((await stop(key)).sendBack).toBe(true)
    expect(await stop(key, true)).toEqual({ sendBack: false, message: null })
    await pass()
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'unreported' })
    expect(await trail(id)).toContain('unreported working→waiting')
    const status = await statusOf()
    expect(status.attention).toContain(`Issue ${id} parked: its lead stopped twice with nothing reported`)
    // Replayed, the stop records nothing more.
    await stop(key, true)
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind = 'unreported'`).toHaveLength(1)
  })

  test('a report made before the stop, handled or not, lets it through', async () => {
    for (const verb of ['block', 'ask', 'wait'] as const) {
      const { id, key } = await running()
      const body: Record<string, unknown> =
        verb === 'block'
          ? { reason: 'x' }
          : verb === 'ask'
            ? { question: 'q?' }
            : { until: new Date(clock.now().getTime() + 60_000).toISOString() }
      await post(id, verb, { ...body, session: key })
      expect(await stop(key)).toEqual({ sendBack: false, message: null })
    }
    // `phase` is no report.
    const { id, key } = await running()
    await post(id, 'phase', { phase: 'build', session: key })
    expect((await stop(key)).sendBack).toBe(true)
  })

  test('a report from an earlier turn does not cover this one', async () => {
    const { id, key } = await running()
    await post(id, 'wait', { until: new Date(clock.now().getTime() + 60_000).toISOString(), session: key })
    await emit(key, 'turn_ended')
    clock.advance(1_000)
    // A note from the factory starts the next turn.
    await db.sql`
      INSERT INTO factory.prompts (id, session, source, via, text, status, created_at, next_at, claimed_at, sent_at, sent_count)
      VALUES ('note-1', ${key}, 'note', 'type', 'carry on', 'sent', ${clock.now()}, ${clock.now()}, ${clock.now()}, ${clock.now()}, 1)`
    await db.sql`UPDATE factory.issues SET state = 'working', reason = NULL, wake_at = NULL WHERE id = ${id}`
    clock.advance(1_000)
    await emit(key, 'turn_started')
    clock.advance(1_000)
    expect((await stop(key)).sendBack).toBe(true)
  })

  test('a turn answering a prompt the owner typed is never sent back', async () => {
    const { key } = await running()
    await emit(key, 'turn_ended')
    clock.advance(1_000)
    // No prompt of the factory's lies behind this turn: the owner typed into the pane.
    await emit(key, 'turn_started')
    clock.advance(1_000)
    expect(await stop(key)).toEqual({ sendBack: false, message: null })
    expect(await stop(key, true)).toEqual({ sendBack: false, message: null })
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind = 'unreported'`).toHaveLength(0)
  })

  test('a session that works no Issue, an Issue that is not working, and a wait are left to the workers rule', async () => {
    const { id, key } = await running()
    await openSession(db.sql, { id: 'plain', spawnKey: 'plain', pane: 't99', at: clock.now() })
    await emit('plain', 'session_started', clock.now(), {})
    await emit('plain', 'turn_started')
    expect(await stop('plain')).toEqual({ sendBack: false, message: null })
    await db.sql`UPDATE factory.issues SET state = 'watching' WHERE id = ${id}`
    expect(await stop(key)).toEqual({ sendBack: false, message: null })
    await db.sql`UPDATE factory.issues SET state = 'working' WHERE id = ${id}`
    await db.sql`INSERT INTO factory.events (key, session, kind, at, payload) VALUES ('w1', ${key}, 'wait_declared', ${clock.now()}, ${{ on: 'owner' }})`
    expect(await stop(key)).toEqual({ sendBack: false, message: null })
  })
})

describe('the replay test: a crash around the lead’s effects', () => {
  class Crash extends Error {}

  /** Ports that die once, before or after the n-th point of their calls (two per call), as a process killed there would. */
  function crashing(at: number) {
    let seen = 0
    const real = ports()
    const wrap =
      (name: 'start_lead' | 'note_lead') => async (effect: Parameters<NonNullable<typeof real.start_lead>>[0]) => {
        if (seen++ === at) throw new Crash(`before point ${at}`)
        await real[name]?.(effect)
        if (seen++ === at) throw new Crash(`after point ${at}`)
      }
    return { run: { start_lead: wrap('start_lead'), note_lead: wrap('note_lead') }, points: () => seen }
  }

  async function script(issuePorts: ReturnType<typeof ports>) {
    // The Issue's id is not its first attempt's number, so the snapshots can name it.
    await db.sql`SELECT nextval('factory.issues_id_seq')`
    const id = await file(newRepo())
    for (let i = 0; i < 4; i++) await pass({ issuePorts })
    await emit(leadKey(id, 1), 'session_started', clock.now(), { claudeSessionId: 'c' })
    await enqueue(db.sql, {
      issueId: id,
      key: `note:${id}:1`,
      kind: 'note',
      at: clock.now(),
      payload: { text: 'a new fact' },
    })
    for (let i = 0; i < 3; i++) await pass({ issuePorts })
    // The new process: the real ports, and the passes again.
    for (let i = 0; i < 4; i++) await pass()
    return id
  }

  const snapshot = async (id: number) => {
    const plain = (text: string) => text.replaceAll(String(id), '#')
    return {
      state: (await issue(id)).state,
      worktrees: worktrees.made.map((w) => plain(w.branch)),
      spawns: (await spawns()).map((s: { key: string }) => plain(s.key)),
      started: runner.started.map((s) => plain(s.key)),
      prompts: (await db.sql`SELECT id, source FROM factory.prompts ORDER BY id`).map(
        (p: { id: string; source: string }) => `${p.source} ${plain(p.id)}`,
      ),
      open: (await db.sql`SELECT 1 FROM factory.issue_effects WHERE done_at IS NULL AND cancelled_at IS NULL`).length,
    }
  }

  test('a crash at every point of the lead’s ports replays to the run without one: one worktree, spawn, brief and note', async () => {
    const clean = crashing(Number.MAX_SAFE_INTEGER)
    const reference = await snapshot(await script(clean.run))
    expect(reference).toMatchObject({ state: 'working', spawns: ['lead-#-1'], started: ['lead-#-1'], open: 0 })
    expect(reference.prompts).toEqual(['brief issue:#:brief:1', 'note note_lead:note:#:1'])
    const points = clean.points()
    expect(points).toBe(4)

    for (let at = 0; at < points; at++) {
      await setup()
      const crash = crashing(at)
      const id = await script(crash.run)
      expect(await snapshot(id)).toEqual(reference)
    }
  }, 120_000)
})
