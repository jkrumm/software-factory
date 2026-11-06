/* oxlint-disable typescript/await-thenable -- bun types the `rejects` matchers as void; they return a promise */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { IssueVerbAck, type StopCheck } from '@software-factory/contract'
import { type AdmissionLimits, HOLD_RECHECK_MS } from '../src/admission.ts'
import { serveHooks } from '../src/http.ts'
import { Classification } from '../src/issues/classify.ts'
import type { Commits } from '../src/issues/commits.ts'
import { notifyFailures } from '../src/notify/rules.ts'
import { createIssue } from '../src/issues/create.ts'
import { finalizePorts } from '../src/issues/finalize.ts'
import { LEAD_GONE_GRACE_MS, leadPorts, parkGoneLeads } from '../src/issues/lead.ts'
import { WorktreeMaker } from '../src/issues/leadtree.ts'
import { briefPromptId, leadKey } from '../src/issues/names.ts'
import { OffTick } from '../src/issues/offtick.ts'
import { enqueue } from '../src/issues/inbox.ts'
import { processInbox } from '../src/issues/worker.ts'
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

const SHA = 'a'.repeat(40)

/** Commits as the lead names them, touching nothing that deploys: this file is about the lead, `evidence.test.ts` about the bar. */
const commits: Commits = {
  read: async ({ reported }) => ({
    landedAt: null,
    commits: [...reported],
    paths: ['docs/x.md'],
    mergedAt: null,
  }),
}

let db: TestDb
let clock: FakeClock
const fixture = repoRoot('factory-lead-')
let app: TestApp
let sync: ProjectSync
let classifier: FakeClassifier
let worktrees: FakeWorktrees
let maker: WorktreeMaker
let runner: PaneRunner
let classification: Classification
let offTick: OffTick
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
  maker = new WorktreeMaker({ sql: db.sql, worktrees, now: () => clock.now() })
  runner = new PaneRunner()
  offTick = new OffTick({ now: () => clock.now().getTime() })
  classification = new Classification({ sql: db.sql, classifier, roles: TEST_ROLES, now: () => clock.now() })
  sync = new ProjectSync({ sql: db.sql, roots: [fixture.root], now: () => clock.now() })
  await app?.stop()
  app = startApp({
    sql: db.sql,
    clock,
    commits,
    repoRoots: [fixture.root],
    get alertLeads() {
      return alerts
    },
  })
}
beforeEach(setup)

const statusOf = async () => (await (await app.get('/status')).json()) as { attention: string[]; health: string[] }

const ports = () => ({
  ...leadPorts({ sql: db.sql, clock, roles: TEST_ROLES, repoRoots: [fixture.root] }),
  ...finalizePorts({
    sql: db.sql,
    clock,
    runner,
    worktrees,
    transcripts: { copy: async () => false },
    archiveDir: '/nowhere',
    projectsDir: async () => undefined,
    making: (issueId) => maker.busy(issueId),
    offTick,
  }),
})

/** One tick of the server, then the classifies it started finish. */
async function pass(
  extra: { issuePorts?: ReturnType<typeof ports>; settle?: boolean; admission?: AdmissionLimits } = {},
) {
  const result = await tick({
    sql: db.sql,
    clock,
    runner,
    issuePorts: extra.issuePorts ?? ports(),
    classification,
    leadWorktrees: maker,
    projects: sync,
    alertLeads: alerts,
    admission: extra.admission,
  })
  if (extra.settle !== false) {
    await classification.settled()
    await maker.settled()
    await offTick.settled()
  }
  clock.advance(5_000)
  return result
}
const drive = async (passes = 4) => {
  for (let i = 0; i < passes; i++) await pass()
}

let repos = 0
const newRepo = (files: Record<string, string> = {}) => fixture.repo(`repo${++repos}`, files)

async function file(repo: string, source = 'request', title = 'the title', after?: number[]): Promise<number> {
  const { issue } = await createIssue(
    db.sql,
    { source, sourceKey: `k${++n}`, repo, title, facts: { note: 'data' }, ...(after ? { after } : {}) },
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

/** The Issue's two restarts are spent, as its events say: the next `lead_gone` is the third and parks. */
const restartsSpent = (id: number) =>
  db.sql`
    INSERT INTO factory.issue_events (issue_id, key, kind, from_state, to_state, at)
    VALUES (${id}, ${`seed:${id}:1`}, 'lead_gone', 'working', 'queued', ${clock.now()}),
           (${id}, ${`seed:${id}:2`}, 'lead_gone', 'working', 'queued', ${clock.now()})`

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
      lead_effort: 'high',
    })
    expect(worktrees.made).toEqual([{ repo, branch: `factory/${id}-1` }])

    const [spawn, ...rest] = await spawns()
    expect(rest).toEqual([])
    expect(spawn).toMatchObject({
      key: `lead-${id}-1`,
      role: 'lead',
      tier: 'sonnet',
      effort: 'high',
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
      effort: 'high',
      space: repo,
    })
    expect(runner.started[0]?.prompt).toContain('# Operating contract')
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
    expect((await spawns())[0]).toMatchObject({ role: 'lead', tier: 'sonnet', effort: 'high' })
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
    expect(status.health).toContain(`Issue ${second} waits for the claim on ${repo.split('/').pop()}`)

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
    expect(status.health).toContain(`Issue ${alert} is an alert and starts no lead: FACTORY_ALERT_LEADS is off`)

    alerts = true
    await drive(4)
    expect((await issue(alert)).state).toBe('working')
    expect(worktrees.made.map((w) => w.repo)).toContain(repo)
    const after = await statusOf()
    expect(after.health.some((line: string) => line.includes('starts no lead'))).toBe(false)
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

  test('the lead starts at the lead row of the role table now, whatever Classify stored', async () => {
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
    expect(await started(id)).toMatchObject({ tier: 'sonnet', effort: 'high' })
    expect(await started(incident)).toMatchObject({ tier: 'sonnet', effort: 'high' })
  })

  describe('the lead cap per account', () => {
    /** A fresh sample of these accounts: an account takes one new spawn per sample, and the cap is what these tests are about. */
    const sample = async (accounts: string[]) => {
      const source = new FakeQuotaSource()
      source.readings = accounts.map((account) => ({
        account,
        ...usage(1, 1, new Date(clock.now().getTime() + 1_000 * 3_600_000)),
      }))
      await new QuotaPoller({ sql: db.sql, clock, source }).poll()
    }
    const states = async () =>
      Object.fromEntries(
        (await db.sql`SELECT key, status, account FROM factory.spawns ORDER BY key`).map(
          (r: { key: string; status: string; account: string | null }) => [
            r.key,
            `${r.status}${r.account ? ` on ${r.account}` : ''}`,
          ],
        ),
      )
    /** The started leads have begun their first turn: a started spawn without one keeps holding its account whatever the sample says. */
    const began = async () => {
      const keys: { key: string }[] = await db.sql`SELECT key FROM factory.spawns WHERE status = 'started'`
      for (const { key } of keys) await emit(key, 'turn_started')
    }
    /** Three Issues in three repos, one account: the first two leads start on it, the third waits at the cap. */
    async function twoOnOne() {
      await db.sql`DELETE FROM factory.quota_readings WHERE account = 'b'`
      const ids = [await file(newRepo()), await file(newRepo()), await file(newRepo())]
      for (let i = 0; i < 3; i++) {
        await drive(4)
        await began()
        await sample(['a'])
      }
      await drive(4)
      await began()
      return ids
    }

    test('an account with two live Issue leads takes no third: the spawn waits, and the account has two', async () => {
      const [first, second, third] = await twoOnOne()
      expect(await states()).toEqual({
        [leadKey(first ?? 0, 1)]: 'started on a',
        [leadKey(second ?? 0, 1)]: 'started on a',
        [leadKey(third ?? 0, 1)]: 'waiting',
      })
      expect((await issue(third ?? 0)).state).toBe('working')
    })

    test('another account with room is picked for it', async () => {
      const [, , third] = await twoOnOne()
      await sample(['a', 'b'])
      clock.advance(HOLD_RECHECK_MS)
      await drive(3)
      expect((await states())[leadKey(third ?? 0, 1)]).toBe('started on b')
    })

    test('a lead that ends gives its place back: the waiting spawn starts at the next look', async () => {
      const [first, , third] = await twoOnOne()
      await emit(leadKey(first ?? 0, 1), 'session_ended')
      await sample(['a'])
      clock.advance(HOLD_RECHECK_MS)
      await drive(3)
      expect((await states())[leadKey(third ?? 0, 1)]).toBe('started on a')
    })

    test('a program lead or a wave, which have no Issue, are neither counted nor capped', async () => {
      await twoOnOne()
      await sample(['a'])
      const res = await app.send('POST', '/spawns', { key: 'program-lead', repo: newRepo(), prompt: 'p', role: 'lead' })
      expect(await res.json()).toMatchObject({ status: 'queued', account: 'a' })
    })

    test('a cap of one holds the second lead on the account', async () => {
      await db.sql`DELETE FROM factory.quota_readings WHERE account = 'b'`
      await file(newRepo())
      await file(newRepo())
      const admission = { leadsPerAccount: 1 }
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 4; j++) await pass({ admission })
        await sample(['a'])
      }
      await pass({ admission })
      expect(Object.values(await states()).sort()).toEqual(['started on a', 'waiting'])
    })

    test('a lead whose Issue waits on the owner’s decision holds no capacity: the waiting spawn starts', async () => {
      const [first, , third] = await twoOnOne()
      expect((await states())[leadKey(third ?? 0, 1)]).toBe('waiting')
      await post(first ?? 0, 'ask', { question: 'Which?', session: leadKey(first ?? 0, 1) })
      await pass()
      expect(await issue(first ?? 0)).toMatchObject({ state: 'waiting', reason: 'decision' })
      await sample(['a'])
      clock.advance(HOLD_RECHECK_MS)
      await drive(3)
      expect((await states())[leadKey(third ?? 0, 1)]).toBe('started on a')
    })
  })

  describe('the load ceiling', () => {
    const lines = async () => (await statusOf()).health.filter((line) => line.startsWith('held by load'))
    const held = async () => (await spawns()).map((s: { status: string; hold: string | null }) => [s.status, s.hold])

    test('holds a new lead above the ceiling with a health line, and releases it below', async () => {
      let reading = 346
      const admission = { loadCeiling: 60, loadAverage: () => reading }
      const id = await file(newRepo())
      for (let i = 0; i < 4; i++) await pass({ admission })
      expect(await held()).toEqual([['queued', 'load']])
      expect((await issue(id)).state).toBe('working')
      expect(await lines()).toEqual([expect.stringContaining(`Issue ${id} waits for the machine`)])

      reading = 60
      clock.advance(HOLD_RECHECK_MS)
      for (let i = 0; i < 3; i++) await pass({ admission })
      expect(await held()).toEqual([['started', null]])
      expect(await lines()).toEqual([])
    })

    test('touches no running lead and no spawn without an Issue', async () => {
      const running = await lead()
      const admission = { loadCeiling: 60, loadAverage: () => 346 }
      await pass({ admission })
      expect((await spawns()).find((s: { key: string }) => s.key === running.key)).toMatchObject({ status: 'started' })
      const res = await app.send('POST', '/spawns', { key: 'program-lead', repo: newRepo(), prompt: 'p', role: 'lead' })
      expect(await res.json()).toMatchObject({ status: 'queued', hold: null })
    })
  })

  test('a note with no lead to go to parks the Issue as lead_gone, with a line for the owner', async () => {
    for (const how of ['failed', 'ended'] as const) {
      const { id, key } = await lead()
      await restartsSpent(id)
      await post(id, 'ask', { question: 'Which?', session: key })
      await pass()
      // The lead's spawn failed, or its agent is gone from the core: nothing can be told the answer.
      if (how === 'failed')
        await db.sql`UPDATE factory.spawns SET status = 'failed', error = 'the runner refused' WHERE key = ${key}`
      else await db.sql`UPDATE factory.sessions SET pane = 'w9:p9' WHERE id = ${key}`
      await enqueue(db.sql, {
        issueId: id,
        key: `answer:${id}:o`,
        kind: 'answer',
        at: clock.now(),
        payload: { answer: 'this one' },
      })
      await drive(3)
      expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'lead_gone' })
      expect(await trail(id)).toContain('lead_gone working→waiting')
      const { attention, health } = await statusOf()
      expect(
        health.some(
          (line) =>
            line.startsWith(`Issue ${id} parked for `) && line.includes(`its lead is gone (spawn ${key} ${how}`),
        ),
      ).toBe(true)
      expect(attention).toEqual([])
      expect(await db.sql`SELECT 1 FROM factory.prompts WHERE source = 'note' AND session = ${key}`).toHaveLength(0)
      // The owner wakes it with the lead still gone: it parks again, and does not sit working with nobody to work.
      await enqueue(db.sql, {
        issueId: id,
        key: `wake:${id}:lg`,
        kind: 'wake',
        at: clock.now(),
        payload: { for: 'lead_gone' },
      })
      await drive(3)
      expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'lead_gone' })
    }
  })

  test('a lead whose spawn failed parks the Issue without a note to find it, and again when woken with it still failed', async () => {
    const { id, key } = await lead()
    await restartsSpent(id)
    await db.sql`UPDATE factory.spawns SET status = 'failed', error = 'the runner refused' WHERE key = ${key}`
    await pass()
    await pass()
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'lead_gone' })
    await enqueue(db.sql, {
      issueId: id,
      key: `wake:${id}:lg`,
      kind: 'wake',
      at: clock.now(),
      payload: { for: 'lead_gone' },
    })
    await drive(3)
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'lead_gone' })
  })

  describe('a lead that is gone', () => {
    const fail = (key: string) =>
      db.sql`UPDATE factory.spawns SET status = 'failed', error = 'the runner refused' WHERE key = ${key}`
    const notifications = async () =>
      (await db.sql`SELECT key FROM factory.notifications ORDER BY key`).map((row: { key: string }) => row.key)

    describe('whose terminal is gone (the spawn ended)', () => {
      const killed = async (key: string) => {
        await emit(key, 'session_started')
        await emit(key, 'session_ended')
      }

      test('starts the next attempt with no note, once it has been dead past the grace', async () => {
        const { id, key } = await lead()
        await killed(key)
        clock.advance(LEAD_GONE_GRACE_MS + 1_000)
        await drive(6)
        expect(await issue(id)).toMatchObject({ state: 'working', attempt: 2, reason: null })
        expect(await trail(id)).toContain('lead_gone working→queued')
        const [row] = await db.sql`SELECT payload FROM factory.issue_inbox WHERE key LIKE ${`lead_gone:ended:${id}:%`}`
        expect(row.payload).toEqual({ attempt: 1, detail: `spawn ${key} ended` })
      })

      test('does nothing inside the grace', async () => {
        const { id, key } = await lead()
        await killed(key)
        clock.advance(LEAD_GONE_GRACE_MS - 60_000)
        await drive(3)
        expect(await issue(id)).toMatchObject({ state: 'working', attempt: 1 })
        expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind = 'lead_gone'`).toHaveLength(0)
      })

      test('does nothing within the grace after the runner restarted', async () => {
        const { id, key } = await lead()
        await killed(key)
        clock.advance(2 * LEAD_GONE_GRACE_MS)
        await emit('_runner', 'runner_restarted', clock.now(), { to: 'core-2' })
        clock.advance(LEAD_GONE_GRACE_MS - 60_000)
        await drive(3)
        expect(await issue(id)).toMatchObject({ state: 'working', attempt: 1 })
        expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind = 'lead_gone'`).toHaveLength(0)
        clock.advance(2 * LEAD_GONE_GRACE_MS)
        await drive(6)
        expect(await issue(id)).toMatchObject({ state: 'working', attempt: 2 })
      })

      test('never for a lead that is alive', async () => {
        const { id, key } = await lead()
        await emit(key, 'session_started')
        clock.advance(3 * LEAD_GONE_GRACE_MS)
        await drive(3)
        expect(await issue(id)).toMatchObject({ state: 'working', attempt: 1 })
        expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind = 'lead_gone'`).toHaveLength(0)
      })

      test('a replayed sweep files one event', async () => {
        const { id, key } = await lead()
        await killed(key)
        clock.advance(LEAD_GONE_GRACE_MS + 1_000)
        await parkGoneLeads(db.sql, clock.now())
        await parkGoneLeads(db.sql, clock.now())
        expect(
          await db.sql`SELECT 1 FROM factory.issue_inbox WHERE issue_id = ${id} AND kind = 'lead_gone'`,
        ).toHaveLength(1)
      })
    })

    test('gets the next attempt, twice, with no message to the owner; the third time the Issue parks, with one', async () => {
      const { id, key, repo } = await lead()
      await fail(key)
      await drive(6)
      await notifyFailures(db.sql, clock.now())
      expect(await issue(id)).toMatchObject({ state: 'working', attempt: 2, reason: null })
      expect(await trail(id)).toContain('lead_gone working→queued')
      // The ended attempt was finalized (its tab closed, its worktree asked to go) before the next lead was made.
      expect(runner.closed).toContain(key)
      expect(worktrees.removed).toEqual([{ repo, branch: `factory/${id}-1`, reported: [] }])
      expect(worktrees.made.map((made) => made.branch)).toEqual([`factory/${id}-1`, `factory/${id}-2`])
      expect((await spawns()).map((spawn: { key: string }) => spawn.key)).toEqual([`lead-${id}-1`, `lead-${id}-2`])
      expect(await notifications()).toEqual([])

      // A lead_gone filed late for the attempt that was replaced says nothing about the one running.
      await enqueue(db.sql, {
        issueId: id,
        key: `late-gone:${id}`,
        kind: 'lead_gone',
        at: clock.now(),
        payload: { attempt: 1, detail: 'late' },
      })
      await drive(3)
      expect(await issue(id)).toMatchObject({ state: 'working', attempt: 2 })

      await fail(leadKey(id, 2))
      await drive(6)
      await notifyFailures(db.sql, clock.now())
      expect(await issue(id)).toMatchObject({ state: 'working', attempt: 3 })
      expect(await notifications()).toEqual([])

      await fail(leadKey(id, 3))
      await drive(6)
      await notifyFailures(db.sql, clock.now())
      expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'lead_gone', attempt: 3 })
      const parked = (await notifications()).filter((k: string) => k.startsWith('notify:parked:'))
      expect(parked).toHaveLength(1)
      // The park is the one message: the failed spawn behind it adds none.
      expect(await notifications()).toEqual(parked)
      expect((await trail(id)).filter((line) => line.startsWith('lead_gone'))).toEqual([
        'lead_gone working→queued',
        'lead_gone working→queued',
        'lead_gone working→waiting',
      ])
      // Replays and later passes make no fourth attempt.
      await drive(4)
      expect((await spawns()).map((spawn: { key: string }) => spawn.key)).toEqual([
        `lead-${id}-1`,
        `lead-${id}-2`,
        `lead-${id}-3`,
      ])
    })

    test('the news a note could not type to the gone lead is in the next attempt’s brief', async () => {
      const gone = (key: string) => db.sql`UPDATE factory.sessions SET pane = 'w9:p9' WHERE id = ${key}`
      const briefOf = async (id: number) =>
        (await spawns()).find((spawn: { key: string }) => spawn.key === leadKey(id, 2))?.prompt as string | undefined

      const regressed = await lead()
      await emit(regressed.key, 'session_started', clock.now(), { claudeSessionId: 'c1' })
      await post(regressed.id, 'ship', { summary: 'shipped', commits: [SHA], session: regressed.key })
      await pass()
      await gone(regressed.key)
      await enqueue(db.sql, {
        issueId: regressed.id,
        key: `sig:${regressed.id}`,
        kind: 'signal',
        at: clock.now(),
        payload: { regression: true, summary: '500s on /login' },
      })
      await drive(8)
      expect(await issue(regressed.id)).toMatchObject({ state: 'working', attempt: 2 })
      expect(await briefOf(regressed.id)).toContain('## What happened before this attempt')
      expect(await briefOf(regressed.id)).toContain('a regression was reported after your ship: 500s on /login')
    })

    test('an answer the gone lead could not hear is in the next attempt’s brief', async () => {
      const gone = (key: string) => db.sql`UPDATE factory.sessions SET pane = 'w9:p9' WHERE id = ${key}`
      const briefOf = async (id: number) =>
        (await spawns()).find((spawn: { key: string }) => spawn.key === leadKey(id, 2))?.prompt as string | undefined

      const asked = await lead()
      await emit(asked.key, 'session_started', clock.now(), { claudeSessionId: 'c2' })
      await post(asked.id, 'ask', { question: 'Which?', session: asked.key })
      await pass()
      await gone(asked.key)
      await enqueue(db.sql, {
        issueId: asked.id,
        key: `answer:${asked.id}:o`,
        kind: 'answer',
        at: clock.now(),
        payload: { answer: 'this one' },
      })
      await drive(8)
      expect(await issue(asked.id)).toMatchObject({ state: 'working', attempt: 2 })
      expect(await briefOf(asked.id)).toContain('your question was answered: this one')
    })

    test('the next brief names the previous attempt’s branch and kept worktree, and says nothing when finalize removed it', async () => {
      worktrees.removal = { kept: 'it has uncommitted changes', path: '/work/tree-1' }
      const kept = await lead()
      await fail(kept.key)
      await drive(6)
      const next = (await spawns()).find((spawn: { key: string }) => spawn.key === leadKey(kept.id, 2))
      expect(next?.prompt).toContain('## The previous attempt')
      expect(next?.prompt).toContain(`"factory/${kept.id}-1"`)
      expect(next?.prompt).toContain('"/work/tree-1"')
      expect(next?.prompt).toContain('it has uncommitted changes')

      worktrees.removal = { removed: true }
      const clean = await lead()
      await fail(clean.key)
      await drive(6)
      const again = (await spawns()).find((spawn: { key: string }) => spawn.key === leadKey(clean.id, 2))
      expect(again?.prompt).not.toContain('The previous attempt')
    })
  })

  test('a note to a lead that is gone does not disturb an Issue that waits', async () => {
    const { id, key } = await lead()
    const until = new Date(clock.now().getTime() + 3_600_000).toISOString()
    await post(id, 'wait', { until, session: key })
    await pass()
    // The spawn ended (not failed, so the sweep leaves it), and the owner sends a note into the waiting Issue.
    await db.sql`UPDATE factory.sessions SET pane = 'w9:p9' WHERE id = ${key}`
    await enqueue(db.sql, { issueId: id, key: `note:${id}:o`, kind: 'note', at: clock.now(), payload: { text: 'fyi' } })
    await drive(3)
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'wait' })
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind = 'lead_gone'`).toHaveLength(0)
  })

  test('a lead in a decision wait is typed to only once it has its repo’s claim again, answer first, with the order to rebase', async () => {
    const { id, key } = await lead()
    await post(id, 'ask', { question: 'Which?', session: key })
    await pass()
    await pass()
    expect(await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${id}`).toHaveLength(0)
    // A note while the question is open waits; so does the answer's wake while another lead holds the repo.
    await enqueue(db.sql, { issueId: id, key: `note:${id}:w`, kind: 'note', at: clock.now(), payload: { text: 'fyi' } })
    await drive(3)
    expect(await db.sql`SELECT 1 FROM factory.prompts WHERE source = 'note' AND session = ${key}`).toHaveLength(0)
    await enqueue(db.sql, {
      issueId: id,
      key: `answer:${id}:w`,
      kind: 'answer',
      at: clock.now(),
      payload: { answer: 'this one' },
    })
    await drive(3)
    expect(await issue(id)).toMatchObject({ state: 'working', reason: null })
    expect(await db.sql`SELECT 1 FROM factory.claims WHERE issue_id = ${id} AND held_at IS NOT NULL`).toHaveLength(1)
    const texts: { text: string }[] = await db.sql`
      SELECT text FROM factory.prompts WHERE source = 'note' AND session = ${key} ORDER BY created_at, id`
    expect(
      texts.some((t) => t.text.includes('your question was answered: this one') && t.text.includes('rebase')),
    ).toBe(true)
    expect(texts.some((t) => t.text.includes('fyi'))).toBe(true)
  })

  test('the brief is recorded with the spawn: a create that fails leaves no prompt behind', async () => {
    const id = await file(newRepo())
    const input = {
      key: 'x-1',
      repo: fixture.root,
      prompt: 'p',
      role: 'lead',
      tier: 'sonnet',
      effort: 'high',
      issueId: id,
    } as const
    await expect(
      createSpawn(
        db.sql,
        {
          ...input,
          withSpawn: async (tx) => {
            await tx`INSERT INTO factory.prompts (id, session, source, via, text, status, created_at, next_at) VALUES ('p', 'x-1', 'brief', 'type', 't', 'delivered', ${clock.now()}, ${clock.now()})`
            throw new Error('after the insert')
          },
        },
        clock.now(),
      ),
    ).rejects.toThrow('after the insert')
    expect(await spawns()).toEqual([])
    expect(await db.sql`SELECT 1 FROM factory.prompts`).toHaveLength(0)
    // Closed meanwhile: nothing is stored either.
    await db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'dropped', closed_at = ${clock.now()} WHERE id = ${id}`
    await expect(createSpawn(db.sql, input, clock.now())).rejects.toThrow('closed')
    expect(await db.sql`SELECT 1 FROM factory.prompts`).toHaveLength(0)
  })

  test('the worktree is made off the tick: a slow one stalls nothing, and is made once, one at a time per Issue', async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => (open = resolve))
    const create = worktrees.create.bind(worktrees)
    worktrees.create = async (input) => {
      await gate
      return create(input)
    }
    const id = await file(newRepo())
    const settle = { settle: false }
    for (let i = 0; i < 6; i++) await pass(settle)
    // Admitted, its effect open and waiting; the tick went on, and the worktree is asked for once.
    expect((await issue(id)).state).toBe('working')
    expect(await spawns()).toEqual([])
    expect((await db.sql`SELECT status FROM factory.lead_worktrees`)[0]).toEqual({ status: 'making' })
    expect(
      await db.sql`SELECT 1 FROM factory.issue_effects WHERE kind = 'start_lead' AND error IS NOT NULL`,
    ).toHaveLength(0)
    open()
    await maker.settled()
    expect(worktrees.made).toHaveLength(1)
    await drive(2)
    expect(await spawns()).toHaveLength(1)
    expect((await db.sql`SELECT status, tries FROM factory.lead_worktrees`)[0]).toEqual({ status: 'made', tries: 1 })
  })

  test('a worktree that cannot be made backs off, says so in status, and is made when it can be', async () => {
    worktrees.failure = new Error('git fetch origin failed (exit 128)')
    const id = await file(newRepo())
    await drive(5)
    expect((await issue(id)).state).toBe('working')
    expect(await spawns()).toEqual([])
    const tries = async () => (await db.sql`SELECT tries FROM factory.lead_worktrees`)[0]?.tries as number
    // 5 passes of 5 s: one try, and the next is 30 s on.
    expect(await tries()).toBe(1)
    expect((await statusOf()).health).toContain(
      `Issue ${id}: its worktree could not be made (try 1), trying again: git fetch origin failed (exit 128)`,
    )
    clock.advance(31_000)
    await drive(1)
    expect(await tries()).toBe(2)
    // The delays double (60 s) and the spawn is never made while it fails.
    clock.advance(31_000)
    await drive(1)
    expect(await tries()).toBe(2)
    worktrees.failure = undefined
    clock.advance(31_000)
    await drive(3)
    expect(await spawns()).toHaveLength(1)
  })

  test('past the retry budget the worktree is failed, and the Issue parks as lead_gone', async () => {
    maker = new WorktreeMaker({ sql: db.sql, worktrees, now: () => clock.now(), retryBudgetMs: 10 * 60_000 })
    worktrees.failure = new Error('no origin')
    const id = await file(newRepo())
    await restartsSpent(id)
    for (let i = 0; i < 20; i++) {
      await drive(1)
      clock.advance(60_000)
    }
    expect((await db.sql`SELECT status FROM factory.lead_worktrees`)[0]).toEqual({ status: 'failed' })
    await drive(3)
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'lead_gone' })
    expect(await spawns()).toEqual([])
    // The abandoned attempt gave its place on the project back.
    expect(await db.sql`SELECT 1 FROM factory.claims`).toHaveLength(0)
    expect(
      (await statusOf()).health.some((line) => line.includes('its lead is gone (the worktree could not be made after')),
    ).toBe(true)
  })

  test('a worktree left being made by a process that died is made again at once', async () => {
    const id = await file(newRepo())
    await drive(3)
    await db.sql`DELETE FROM factory.prompts`
    await db.sql`UPDATE factory.lead_worktrees SET status = 'making', path = NULL`
    await db.sql`DELETE FROM factory.spawns`
    await db.sql`UPDATE factory.issue_effects SET done_at = NULL`
    await drive(3)
    expect((await db.sql`SELECT status, tries FROM factory.lead_worktrees`)[0]).toEqual({ status: 'made', tries: 2 })
    expect(await spawns()).toHaveLength(1)
    expect((await issue(id)).state).toBe('working')
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
      result: null,
      detail: null,
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
      commits: [SHA],
      evidence: [{ kind: 'service', link: 'https://example.com/c/1' }],
      session: shipped.key,
    })
    await pass()
    expect(await issue(shipped.id)).toMatchObject({ state: 'watching', hold: 1 })
    const closed = await lead()
    await post(closed.id, 'close', { summary: 'a doc change', document: 'docs/x.md', session: closed.key })
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

  test('a verb filed for an earlier attempt that reaches the Issue on a later one is refused', async () => {
    const { id, key } = await lead()
    // Filed by attempt 1's lead, handled after attempt 2 began.
    await post(id, 'block', { reason: 'stuck', session: key })
    await db.sql`UPDATE factory.issues SET attempt = 2 WHERE id = ${id}`
    await pass()
    expect((await issue(id)).state).toBe('working')
    expect(await trail(id)).toContain('refused')
    const [refused] = await db.sql`SELECT detail FROM factory.issue_inbox WHERE kind = 'block'`
    expect(refused?.detail).toBe('block was filed for attempt 1, the Issue is on attempt 2')
  })

  test('a lead reports through the socket with no token', async () => {
    const dir = mkdtempSync('/tmp/factory-lead-sock-')
    const socketPath = join(dir, 'h.sock')
    const hooks = serveHooks({
      commits,
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
    await post(id, 'ship', { summary: 'shipped', commits: [SHA], session: key })
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

  describe('dependencies and priority', () => {
    /** Classified already, so only admission decides what happens. */
    const classified = () =>
      db.sql`UPDATE factory.issues SET classified_at = ${clock.now()}, lead_tier = 'sonnet', lead_effort = 'high', kind = 'bug' WHERE classified_at IS NULL`
    const stopIssue = (id: number) =>
      enqueue(db.sql, {
        issueId: id,
        key: `stop:${id}:${++n}`,
        kind: 'stop',
        at: clock.now(),
        payload: { reason: 'test' },
      })
    /** Filed and applied: a tick admits before it handles the inbox, so a prio counts from the next one. */
    const prio = async (id: number, value: number) => {
      await enqueue(db.sql, {
        issueId: id,
        key: `${id}:prio:${++n}`,
        kind: 'prio',
        at: clock.now(),
        payload: { value },
      })
      await processInbox(db.sql, () => clock.now())
    }

    test('an Issue that waits `--after` another stays queued while it is open, and is admitted once it closes', async () => {
      const repo = newRepo()
      const a = await file(repo)
      const b = await file(repo, 'request', 'b', [a])
      await classified()
      await drive(4)
      expect((await issue(a)).state).toBe('working')
      expect((await issue(b)).state).toBe('queued')
      // Even a free claim would not be enough: a project's one place is held by A, and B is not a candidate at all.
      await stopIssue(a)
      await drive(4)
      expect((await issue(a)).state).toBe('closed')
      expect((await issue(b)).state).toBe('working')
    })

    test('a blocked oldest does not hold back a younger Issue of its project that is free', async () => {
      const repo = newRepo()
      const blocker = await file(newRepo())
      const blocked = await file(repo, 'request', 'blocked', [blocker])
      const free = await file(repo, 'request', 'free')
      await db.sql`UPDATE factory.issues SET classified_at = ${clock.now()}, lead_tier = 'sonnet', lead_effort = 'high', kind = 'bug'`
      await db.sql`UPDATE factory.issues SET state = 'waiting', reason = 'blocked' WHERE id = ${blocker}`
      await drive(4)
      expect((await issue(blocked)).state).toBe('queued')
      expect((await issue(free)).state).toBe('working')
    })

    test('a higher prio is admitted before an older Issue of the same project, and the latest prio wins', async () => {
      const repo = newRepo()
      const older = await file(repo)
      const younger = await file(repo)
      await classified()
      await prio(older, 5)
      await prio(younger, 9)
      clock.advance(1_000)
      await prio(older, 20)
      await prio(younger, -3)
      clock.advance(1_000)
      await prio(younger, 50)
      await drive(4)
      expect((await issue(younger)).state).toBe('working')
      expect((await issue(older)).state).toBe('queued')
    })

    test('without a prio the oldest goes first, and an urgent Issue stays ahead of a prio', async () => {
      const repo = newRepo()
      const first = await file(repo)
      const second = await file(repo)
      const urgent = await file(repo)
      await classified()
      await db.sql`UPDATE factory.issues SET kind = 'incident' WHERE id = ${urgent}`
      await prio(second, 1000)
      await drive(4)
      expect((await issue(urgent)).state).toBe('working')
      expect((await issue(second)).state).toBe('working')
      expect((await issue(first)).state).toBe('queued')
    })
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
    expect(runner.started.some((start) => start.prompt.includes('# Operating contract'))).toBe(false)
    const status = await statusOf()
    expect(status.health.some((line) => line.includes("is not this Issue's lead"))).toBe(true)
  })

  test('on the socket a verb needs a session that works the Issue; the port does not', async () => {
    const dir = mkdtempSync('/tmp/factory-lead-sock-')
    const socketPath = join(dir, 'h.sock')
    const hooks = serveHooks({
      commits,
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
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual(['phase', 'wait', 'block', 'ask', 'drop'])
    expect(rows[3]?.payload).toEqual({
      attempt: 1,
      question: 'Which?',
      options: ['a', 'b'],
      default: 'a',
      expiresAt: until,
    })

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
    expect((await factory({}, 'issue', 'ship', '4242', '--summary', 's', '--commit', SHA)).code).toBe(4)
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
    expect(
      status.health.some(
        (l) => l.startsWith(`Issue ${id} parked for `) && l.endsWith(': its lead stopped twice with nothing reported'),
      ),
    ).toBe(true)
    expect(status.attention).toEqual([])
    // Replayed, the stop records nothing more.
    await stop(key, true)
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind = 'unreported'`).toHaveLength(1)
  })

  test('a park by the lead shows no reason from an older lead_gone', async () => {
    const { id } = await lead()
    await db.sql`
      INSERT INTO factory.issue_events (issue_id, key, kind, from_state, to_state, at, payload)
      VALUES (${id}, ${`stale:${id}`}, 'lead_gone', 'working', 'queued', ${clock.now()}, ${{ detail: 'old news' }})`
    await enqueue(db.sql, { issueId: id, key: `park:${id}`, kind: 'park', at: clock.now() })
    await pass()
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'parked' })
    const { attention, health } = await statusOf()
    expect(health.some((line) => line.startsWith(`Issue ${id} parked for `))).toBe(true)
    expect(health.some((line) => line.includes('old news'))).toBe(false)
    expect(attention).toEqual([])
  })

  test('a stop with a background task running is neither sent back nor parked; the same stop without one is', async () => {
    const { id, key } = await running()
    const busy = (active: boolean) =>
      stopCheck(db.sql, key, { stopHookActive: active, backgroundTasks: true }, clock.now())
    expect(await busy(false)).toEqual({ sendBack: false, message: null })
    expect(await busy(true)).toEqual({ sendBack: false, message: null })
    await pass()
    expect((await issue(id)).state).toBe('working')
    expect(await db.sql`SELECT 1 FROM factory.effects WHERE rule = 'issue-sendback'`).toHaveLength(0)
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind = 'unreported'`).toHaveLength(0)
    // The task ended, the session woke and stopped again: nothing was spent, so the stop is sent back as any other.
    expect((await stop(key)).sendBack).toBe(true)
  })

  test('an unreported park ends when the lead that parked it starts a turn again, and not for a worker or an older turn', async () => {
    const { id, key } = await running()
    expect((await stop(key)).sendBack).toBe(true)
    expect(await stop(key, true)).toEqual({ sendBack: false, message: null })
    await pass()
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'unreported' })
    const parkedAt = (await issue(id)).updated_at as Date

    // A turn that began before the park, and a worker's turn after it, say nothing about the lead.
    await emit(key, 'turn_started', new Date(parkedAt.getTime() - 500))
    await openSession(db.sql, { id: 'helper', spawnKey: 'helper', pane: 't98', issueId: id, at: clock.now() })
    await emit('helper', 'session_started', clock.now(), {})
    clock.advance(1_000)
    await emit('helper', 'turn_started')
    await drive(2)
    expect(await issue(id)).toMatchObject({ state: 'waiting', reason: 'unreported' })

    // The lead's own next turn (the owner typed into the pane, or a note woke it) ends the park, with no message to the owner.
    clock.advance(1_000)
    await emit(key, 'turn_started')
    await drive(2)
    expect(await issue(id)).toMatchObject({ state: 'working', reason: null })
    expect(await trail(id)).toContain('turn_started waiting→working')
    expect(
      (await db.sql`SELECT key FROM factory.notifications`).map((row: { key: string }) => row.key.split(':')[1]),
    ).toEqual(['parked'])
    // That turn is the owner's, so it is not sent back; and a replay of the event moves nothing.
    expect(await stop(key)).toEqual({ sendBack: false, message: null })
    await drive(2)
    expect((await issue(id)).state).toBe('working')
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
    expect(points).toBeGreaterThanOrEqual(4)

    for (let at = 0; at < points; at++) {
      await setup()
      const crash = crashing(at)
      const id = await script(crash.run)
      expect(await snapshot(id)).toEqual(reference)
    }
  }, 120_000)
})
