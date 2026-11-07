import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Fleet, type IssueCard, type IssueDetail, type ReadAsk, type ReadHealth } from '@software-factory/contract'
import { namesVisible } from '../src/fleet/digest-model.ts'
import { writeSnapshot } from '../src/fleet/store.ts'
import { createIssue } from '../src/issues/create.ts'
import { logEvent } from '../src/issues/shared.ts'
import { Reader } from '../src/read/index.ts'
import {
  redactAsk,
  redactHealth,
  redactIssueCard,
  redactIssueDetail,
  redactSessionCard,
  redactSpawn,
} from '../src/read/surface.ts'
import { openSession } from '../src/sessions.ts'
import { startApp, TEST_REPO, TEST_ROOT, TEST_READ_TOKEN, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { usage } from './support/quota.ts'
import { world } from './support/world.ts'

const NOW = new Date('2026-11-06T12:00:00.000Z')
const MARKER = 'ZZMARKER-secret'
const VISIBLE_NAME = 'secretportal'
const VISIBLE_REPO = join(TEST_ROOT, VISIBLE_NAME)
mkdirSync(VISIBLE_REPO, { recursive: true })

let db: TestDb
let app: TestApp
let clock: FakeClock
let w: ReturnType<typeof world>

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(async () => {
  await app?.stop()
  await db.stop()
})
beforeEach(async () => {
  await app?.stop()
  await db.reset()
  clock = new FakeClock(NOW)
  w = world(db.sql, clock)
  app = startApp({
    sql: db.sql,
    clock,
    readToken: TEST_READ_TOKEN,
    read: {
      isVisible: (path) => path === VISIBLE_REPO,
      visibleNames: async () => [VISIBLE_NAME],
      pollMs: 20,
      keepaliveMs: 50,
    },
  })
  await app.send('PUT', '/quota/accounts/a', usage(20, 30, new Date(NOW.getTime() + 1e9)))
})

const as = (token: string, path: string, init: RequestInit = {}) =>
  app.bare(path, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
const read = (path: string) => as(TEST_READ_TOKEN, path)

describe('the read token', () => {
  test('reads GET /v1 and nothing else', async () => {
    await writeSnapshot(db.sql, snapshot([], []))
    const { issue } = await createIssue(
      db.sql,
      { source: 'request', sourceKey: 'k', repo: TEST_REPO, title: 'Plain', facts: {} },
      { repoRoots: [TEST_ROOT], now: w.at(10) },
    )
    for (const path of [
      '/v1/overview',
      '/v1/issues',
      `/v1/issues/${issue.id}`,
      '/v1/sessions',
      '/v1/asks',
      '/v1/health',
      '/v1/accounts',
    ]) {
      expect([path, (await read(path)).status]).toEqual([path, 200])
    }
    const stream = await read('/v1/stream')
    expect(stream.status).toBe(200)
    await stream.body?.cancel()

    for (const [method, path] of [
      ['POST', '/issues'],
      ['POST', '/spawns'],
      ['GET', '/status'],
      ['GET', '/fleet'],
      ['GET', '/issues'],
      ['PUT', '/queue'],
      ['POST', '/v1/overview'],
      ['GET', '/nowhere'],
    ] as const) {
      const res = await as(TEST_READ_TOKEN, path, { method, ...(method === 'GET' ? {} : { body: '{}' }) })
      expect([method, path, res.status]).toEqual([method, path, 403])
    }
  })

  test('a wrong token is 401, and without a configured read token no read bearer passes; the owner is unchanged', async () => {
    expect((await as('wrong-token-0123456789', '/v1/issues')).status).toBe(401)
    expect((await as('wrong-token-0123456789', '/status')).status).toBe(401)
    expect((await as(TEST_TOKEN, '/v1/issues')).status).toBe(200)
    expect((await as(TEST_TOKEN, '/status')).status).toBe(200)
    await app.stop()
    app = startApp({ sql: db.sql, clock })
    expect((await as(TEST_READ_TOKEN, '/v1/issues')).status).toBe(401)
    expect((await as(TEST_READ_TOKEN, '/status')).status).toBe(401)
  })
})

/** The snapshot with a visible repo, a visible session, and the asks and health lines given. */
function snapshot(asks: unknown[], health: unknown[]): Fleet {
  return Fleet.parse({
    builtAt: NOW.toISOString(),
    fingerprint: 'fp',
    summary: { working: 0, idle: 0, done: 0, asks: asks.length, staleAsks: 0 },
    asks,
    health,
    repos: [],
    unplaced: [],
    errors: [],
    quota: [],
    queue: { effective: 'run', spawns: [] },
  })
}

async function seed(repo: string, title: string, goal: string, note: string, session: string) {
  const { issue } = await createIssue(
    db.sql,
    { source: 'request', sourceKey: `k-${session}`, repo, title, facts: { goal } },
    { repoRoots: [TEST_ROOT], now: w.at(120) },
  )
  await db.sql`UPDATE factory.issues SET state = 'working', attempt = 1, updated_at = ${w.at(5)} WHERE id = ${issue.id}`
  const lead = `lead-${issue.id}-1`
  await db.sql`
    INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, account, assigned_at, session, created_at, issue_id, tab, workspace)
    VALUES (${lead}, ${repo}, 'work', 'lead', 'sonnet', 'high', 'started', 'a', ${w.at(100)}, 'w1:p1', ${w.at(100)}, ${issue.id}, 'w1:t1', 'w1')`
  await openSession(db.sql, { id: lead, spawnKey: lead, pane: 'w1:p1', tab: 'w1:t1', issueId: issue.id, at: w.at(100) })
  await w.emit(lead, 'turn_started', w.at(10))
  await logEvent(
    db.sql,
    { issueId: issue.id, key: `phase:${issue.id}`, kind: 'phase', from: 'working', to: null, at: w.at(30) },
    { phase: `phase ${session}`, note, attempt: 1 },
  )
  await logEvent(
    db.sql,
    { issueId: issue.id, key: `close:${issue.id}`, kind: 'ship', from: 'working', to: null, at: w.at(20) },
    { summary: note, attempt: 1 },
  )
  await db.sql`
    INSERT INTO factory.decisions (issue_id, key, question, options, default_option, created_at)
    VALUES (${issue.id}, ${`dec-${session}`}, ${`${note}?`}, ${[note, 'no']}, ${note}, ${w.at(20)})`
  await db.sql`
    INSERT INTO factory.evidence (issue_id, kind, link, payload, attempt, at, author)
    VALUES (${issue.id}, 'service', ${`https://example.com/${session}`}, ${{ note }}, 1, ${w.at(15)}, 'lead')`
  return { id: issue.id, lead }
}

describe('a surface never reads IuRoot', () => {
  test('no /v1 body or stream frame under the read token carries a visible repo’s text; the owner still sees it', async () => {
    const secret = `${MARKER} in the portal`
    const hidden = await seed(VISIBLE_REPO, `Title ${MARKER}`, `Goal ${MARKER}`, secret, 'v')
    const plain = await seed(TEST_REPO, 'Ordinary title', 'Ordinary goal', 'ordinary note', 'o')
    await writeSnapshot(
      db.sql,
      snapshot(
        [
          {
            id: `factory:${MARKER}`,
            kind: 'question',
            repo: VISIBLE_REPO,
            session: null,
            short: null,
            text: secret,
            source: 'factory',
            at: w.at(5).toISOString(),
          },
          {
            id: 'factory:named',
            kind: 'question',
            repo: TEST_REPO,
            session: null,
            short: null,
            text: `Ordinary repo asks about ${VISIBLE_NAME} ${MARKER}`,
            source: 'factory',
            at: w.at(5).toISOString(),
          },
          {
            id: 'factory:plain',
            kind: 'question',
            repo: TEST_REPO,
            session: null,
            short: null,
            text: 'An ordinary question',
            source: 'factory',
            at: w.at(5).toISOString(),
          },
        ],
        [
          {
            id: 'health:v',
            kind: 'machine',
            text: `${secret} ${VISIBLE_REPO}`,
            repo: VISIBLE_REPO,
            since: w.at(30).toISOString(),
          },
        ],
      ),
    )
    await db.sql`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, created_at, error)
      VALUES ('queued-v', ${VISIBLE_REPO}, ${MARKER}, 'implementer', 'sonnet', 'high', 'failed', ${w.at(5)}, ${MARKER})`

    const paths = [
      '/v1/overview',
      '/v1/issues?state=all',
      `/v1/issues/${hidden.id}`,
      `/v1/issues/${plain.id}`,
      '/v1/sessions',
      `/v1/sessions/${hidden.lead}`,
      '/v1/asks',
      '/v1/health',
      '/v1/accounts',
    ]
    for (const path of paths) {
      const text = await (await read(path)).text()
      for (const leak of [MARKER, VISIBLE_REPO, VISIBLE_NAME]) {
        expect([path, leak, text.includes(leak)]).toEqual([path, leak, false])
      }
    }
    const owner = await (await as(TEST_TOKEN, `/v1/issues/${hidden.id}`)).text()
    expect(owner).toContain(MARKER)

    // an ordinary repo's Issue is intact
    const card = (await (await read('/v1/issues?state=all')).json()) as { issues: IssueCard[] }
    expect(card.issues.find((c) => c.id === plain.id)).toMatchObject({ filedTitle: 'Ordinary title' })
    const detail = (await (await read(`/v1/issues/${plain.id}`)).json()) as IssueDetail
    expect(detail.asks[0]?.question).toBe('ordinary note?')
    expect(detail.evidence[0]?.note).toBe('ordinary note')
    const hiddenDetail = (await (await read(`/v1/issues/${hidden.id}`)).json()) as IssueDetail
    expect(hiddenDetail).toMatchObject({ filedTitle: `Issue #${hidden.id}`, state: 'working', visible: true })
    expect(hiddenDetail.timeline.map((t) => t.text)).toEqual(hiddenDetail.timeline.map((t) => t.kind))

    // the owner's lists keep the text; the surface's do not
    const ownerAsks = (await (await as(TEST_TOKEN, '/v1/asks')).json()) as { asks: ReadAsk[] }
    expect(ownerAsks.asks.find((a) => a.id === 'factory:named')).toMatchObject({ visible: true })
    const surfaceAsks = (await (await read('/v1/asks')).json()) as { asks: ReadAsk[] }
    expect(surfaceAsks.asks.map((a) => a.id)).toContain('factory:plain')
    expect(surfaceAsks.asks.filter((a) => a.visible).every((a) => a.text === '' && a.id.startsWith('redacted:'))).toBe(
      true,
    )
  })

  test('the stream says only the event kind for a visible repo’s Issue', async () => {
    const hidden = await seed(VISIBLE_REPO, 'Hidden', 'goal', `${MARKER} note`, 'v')
    const plain = await seed(TEST_REPO, 'Plain', 'goal', 'ordinary note', 'o')
    const collect = async (token: string) => {
      const res = await as(token, '/v1/stream?since=i0.s0')
      const reader = res.body?.getReader()
      if (!reader) throw new Error('no body')
      const decoder = new TextDecoder()
      let text = ''
      while (!text.includes('ordinary note') || !text.includes(`"issue":${hidden.id}`)) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value)
      }
      await reader.cancel()
      return text
    }
    const surface = await collect(TEST_READ_TOKEN)
    expect(surface).not.toContain(MARKER)
    expect(surface).not.toContain(VISIBLE_NAME)
    expect(surface).toContain('ordinary note')
    expect(plain.id).toBeGreaterThan(0)
    const owner = await collect(TEST_TOKEN)
    expect(owner).toContain(MARKER)
  })
})

describe('surface.ts', () => {
  const insights = {
    startedAt: 'x',
    endedAt: null,
    elapsedMs: 0,
    workingMs: 0,
    turns: 0,
    toolCalls: 0,
    subagents: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    models: [],
    attempts: 1,
    partial: false,
  }
  const card = (visible: boolean): IssueCard => ({
    id: 4,
    filedTitle: 'secret title',
    title: 'secret',
    summary: 'secret summary',
    about: 'secret about',
    state: 'working',
    reason: null,
    outcome: null,
    phase: 'secret phase',
    repo: '/secret/repo',
    repoName: 'repo',
    visible,
    kind: 'feature',
    size: 'm',
    lead: 'lead-4-1',
    account: 'a',
    quota: null,
    insights,
    createdAt: 'c',
    updatedAt: 'u',
    closedAt: null,
    heldBy: 2,
    waitingOnOwner: true,
  })
  const session = (visible: boolean) => ({
    id: 's1',
    issue: 4,
    parent: null,
    role: 'lead',
    title: 'secret session',
    summary: 'secret',
    state: 'working' as const,
    wait: null,
    account: 'a',
    quota: null,
    model: null,
    turn: 1,
    terminal: { id: 'p', name: 'n', space: '/secret', tab: 't', workspace: 'w' },
    transcriptPath: '/secret/t.jsonl',
    repo: '/secret/repo',
    visible,
    since: null,
    lastActivityAt: 'l',
    insights,
  })

  test('a visible card loses its text and keeps its facts; an ordinary one is untouched', () => {
    expect(redactIssueCard(card(false))).toEqual(card(false))
    expect(redactIssueCard(card(true))).toMatchObject({
      id: 4,
      filedTitle: 'Issue #4',
      title: 'Issue #4',
      about: 'Text of a visible repository is not shown.',
      phase: null,
      repo: 'visible',
      repoName: 'visible',
      state: 'working',
      heldBy: 2,
      waitingOnOwner: true,
      lead: 'lead-4-1',
    })
    expect(redactSessionCard(session(true))).toMatchObject({
      title: 'Session of a visible repository.',
      repo: null,
      transcriptPath: null,
      terminal: null,
      state: 'working',
    })
    expect(redactSessionCard(session(false))).toEqual(session(false))
  })

  test('a detail: a visible one loses timeline, evidence and questions; an ordinary one redacts its visible sessions only', () => {
    const detail = (visible: boolean): IssueDetail => ({
      ...card(visible),
      timeline: [{ at: 'a', kind: 'phase', text: 'secret words', session: null }],
      evidence: [{ kind: 'service', link: 'https://secret', note: 'secret', at: 'a' }],
      asks: [{ question: 'secret?', options: ['a'], default: 'a', answer: 'a', askedAt: 'a' }],
      sessions: [session(true), { ...session(false), id: 's2' }],
    })
    const hidden = redactIssueDetail({ ...detail(true), sessions: [session(true)] })
    expect(JSON.stringify(hidden)).not.toContain('secret ')
    expect(JSON.stringify(hidden)).not.toContain('https://secret')
    expect(hidden.timeline[0]).toMatchObject({ text: 'phase' })
    expect(hidden.evidence[0]).toEqual({ kind: 'service', link: null, note: null, at: 'a' })
    expect(hidden.asks[0]).toMatchObject({ options: [], default: null, answer: null })
    const ordinary = redactIssueDetail(detail(false))
    expect(ordinary.timeline[0]?.text).toBe('secret words')
    expect(ordinary.sessions[0]?.title).toBe('Session of a visible repository.')
    expect(ordinary.sessions[1]?.title).toBe('secret session')
  })

  test('an ask or health line: a stable opaque id, no text', () => {
    const ask: ReadAsk = {
      id: 'factory:1',
      kind: 'question',
      repo: '/secret',
      session: 's',
      short: 'secret',
      text: 'secret',
      source: 'factory',
      at: 'a',
      summary: 'secret',
      issue: 3,
      stale: false,
      visible: true,
    }
    const out = redactAsk(ask)
    expect(out).toMatchObject({ text: '', repo: null, session: 's', issue: 3, source: 'factory' })
    expect(out.id).toMatch(/^redacted:[0-9a-f]{12}$/)
    expect(redactAsk(ask).id).toBe(out.id)
    expect(redactAsk({ ...ask, visible: false })).toEqual({ ...ask, visible: false })
    const line: ReadHealth = {
      id: 'health:x',
      kind: 'machine',
      text: 'secret',
      repo: '/secret',
      since: 's',
      short: 'secret',
      summary: 'secret',
      visible: true,
    }
    expect(redactHealth(line)).toMatchObject({ text: '', repo: null, short: 'Item of a visible repository.' })
  })

  test('a spawn of a visible place loses its place and error', () => {
    const spawn = {
      key: 'k',
      status: 'failed',
      repo: '/secret/repo',
      space: '/secret/repo',
      role: 'lead',
      tier: 'sonnet',
      effort: 'high',
      hold: null,
      account: null,
      resumeAt: null,
      attempts: 1,
      session: null,
      pane: null,
      tab: 't',
      workspace: 'w',
      error: 'secret',
      parent: null,
      issue: 1,
    } as const
    expect(redactSpawn(spawn, (p) => p.startsWith('/secret'))).toMatchObject({
      repo: 'visible',
      space: 'visible',
      tab: null,
      workspace: null,
      error: null,
    })
    expect(redactSpawn(spawn, () => false)).toEqual(spawn)
  })
})

describe('asks that name a visible repo', () => {
  test('namesVisible: IuRoot or a visible name as a whole word', () => {
    expect(namesVisible('look at iuroot', [])).toBe(true)
    expect(namesVisible(`fix ${VISIBLE_NAME} now`, [VISIBLE_NAME])).toBe(true)
    expect(namesVisible(`${VISIBLE_NAME}x`, [VISIBLE_NAME])).toBe(false)
    expect(namesVisible('nothing here', [VISIBLE_NAME])).toBe(false)
  })

  test('a non-visible repo’s ask whose text names a visible repo is marked visible and gets no digest words', async () => {
    await writeSnapshot(
      db.sql,
      snapshot(
        [
          {
            id: 'factory:n',
            kind: 'question',
            repo: TEST_REPO,
            session: null,
            short: null,
            text: `Ask about ${basename(VISIBLE_REPO)}`,
            source: 'factory',
            at: w.at(5).toISOString(),
          },
        ],
        [],
      ),
    )
    const reader = new Reader({ sql: db.sql, clock, visibleNames: async () => [VISIBLE_NAME] })
    expect((await reader.lists()).asks[0]?.visible).toBe(true)
    expect((await reader.lists({ surface: true })).asks[0]).toMatchObject({ text: '', repo: null })
    const without = new Reader({ sql: db.sql, clock })
    expect((await without.lists()).asks[0]?.visible).toBe(false)
  })
})
