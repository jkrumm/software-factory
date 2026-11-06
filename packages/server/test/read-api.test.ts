import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AccountList,
  AskList,
  Fleet,
  HealthList,
  IssueCards,
  IssueDetail,
  Overview,
  SessionCard,
  SessionCards,
} from '@software-factory/contract'
import { cleanHeading } from '../src/fleet/digest-text.ts'
import { headingKey } from '../src/fleet/digest.ts'
import { writeSnapshot } from '../src/fleet/store.ts'
import { serveHooks } from '../src/http.ts'
import { createIssue } from '../src/issues/create.ts'
import { TABLE } from '../src/issues/lifecycle.ts'
import { openSession } from '../src/sessions.ts'
import { logEvent } from '../src/issues/shared.ts'
import { describeEvent } from '../src/read/describe.ts'
import { TranscriptInsights, workingOf } from '../src/read/insights.ts'
import { startApp, TEST_REPO, TEST_ROLES, TEST_ROOT, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { usage } from './support/quota.ts'
import { world } from './support/world.ts'

const NOW = new Date('2026-11-06T12:00:00.000Z')
const VISIBLE_REPO = join(TEST_ROOT, 'private-repo')
mkdirSync(VISIBLE_REPO, { recursive: true })
const TITLE = 'Fix the flaky login test in the auth module when the cache is cold and the token has just expired'

let db: TestDb
let app: TestApp
let clock: FakeClock
let w: ReturnType<typeof world>
let scratch: string
let transcript: string

beforeAll(async () => {
  db = await startTestDb()
  scratch = realpathSync(mkdtempSync('/tmp/factory-read-'))
  mkdirSync(join(scratch, '.claude-test', 'projects', 'proj'), { recursive: true })
  transcript = join(scratch, '.claude-test', 'projects', 'proj', 'lead.jsonl')
})
afterAll(async () => {
  await app?.stop()
  rmSync(scratch, { recursive: true, force: true })
  await db.stop()
})
beforeEach(async () => {
  await app?.stop()
  await db.reset()
  clock = new FakeClock(NOW)
  w = world(db.sql, clock)
  app = startApp({ sql: db.sql, clock, read: { isVisible: (path) => path === VISIBLE_REPO } })
  await app.send('PUT', '/quota/accounts/a', usage(20, 30, new Date(NOW.getTime() + 1e9)))
})

/** One assistant line the way Claude Code writes it. */
const assistant = (id: string, content: unknown[], usageFields: Record<string, number>, model = 'claude-sonnet-x') =>
  JSON.stringify({ type: 'assistant', message: { id, model, content, usage: usageFields } })

const writeTranscript = (path: string) =>
  writeFileSync(
    path,
    `${[
      JSON.stringify({ type: 'user', message: { content: 'go' } }),
      // one message written twice (a block each): usage counts once
      assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash' }], {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 40,
      }),
      assistant('m1', [{ type: 'tool_use', id: 't2', name: 'Agent' }], {
        input_tokens: 10,
        output_tokens: 7,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 40,
      }),
      assistant(
        'm2',
        [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 't3', name: 'Task' },
        ],
        {
          input_tokens: 3,
          output_tokens: 2,
        },
      ),
      'not json at all',
      assistant('m3', [], { input_tokens: 1, output_tokens: 1 }, 'claude-opus-x'),
    ].join('\n')}\n`,
  )

/** An Issue in the test repo, working on attempt 1, with a lead session that has a transcript, and one session the lead started. */
async function workingIssue(repo = TEST_REPO, helper = 'helper-1') {
  const { issue } = await createIssue(
    db.sql,
    { source: 'request', sourceKey: `k-${repo}`, repo, title: TITLE, facts: {} },
    { repoRoots: [TEST_ROOT], now: w.at(120) },
  )
  await db.sql`UPDATE factory.issues SET state = 'working', attempt = 1, kind = 'feature', size = 'm', updated_at = ${w.at(5)} WHERE id = ${issue.id}`
  const lead = `lead-${issue.id}-1`
  await db.sql`
    INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, account, assigned_at, session, created_at, issue_id, tab, workspace)
    VALUES (${lead}, ${repo}, 'work', 'lead', 'sonnet', 'high', 'started', 'a', ${w.at(100)}, 'w1:p1', ${w.at(100)}, ${issue.id}, 'w1:t1', 'w1')`
  await openSession(db.sql, { id: lead, spawnKey: lead, pane: 'w1:p1', tab: 'w1:t1', issueId: issue.id, at: w.at(100) })
  writeTranscript(transcript)
  await w.emit(lead, 'session_started', w.at(99), { claudeSessionId: 'c1', transcriptPath: transcript, account: 'a' })
  await w.emit(lead, 'turn_started', w.at(90))
  await w.emit(lead, 'turn_ended', w.at(80))
  await w.emit(lead, 'turn_started', w.at(10))
  await w.spawned(helper, { parent: lead, repo, startedMinutesAgo: 70 })
  await w.emit(helper, 'turn_started', w.at(60))
  await w.emit(helper, 'turn_ended', w.at(50))
  await logEvent(
    db.sql,
    {
      issueId: issue.id,
      key: `admitted:${issue.id}:1`,
      kind: 'admitted',
      from: 'queued',
      to: 'working',
      at: w.at(100),
    },
    { attempt: 1 },
  )
  await logEvent(
    db.sql,
    { issueId: issue.id, key: `phase:${issue.id}:1`, kind: 'phase', from: 'working', to: null, at: w.at(30) },
    { phase: 'implementing', note: 'Writing the fix now. Then the tests follow.', attempt: 1 },
  )
  return { issue, lead }
}

describe('the projection', () => {
  test('an Issue with events, evidence and a question is a card and a detail', async () => {
    const { issue, lead } = await workingIssue()
    await db.sql`
      INSERT INTO factory.decisions (issue_id, key, question, options, default_option, created_at)
      VALUES (${issue.id}, 'dec-1', 'Keep the old cache?', ${['yes', 'no']}, 'yes', ${w.at(20)})`
    await db.sql`
      INSERT INTO factory.evidence (issue_id, kind, link, payload, attempt, at, author)
      VALUES (${issue.id}, 'service', 'https://example.com/health', ${{ note: 'health is green' }}, 1, ${w.at(15)}, 'lead')`

    const list = IssueCards.parse(await (await app.get('/v1/issues')).json())
    expect(list.issues).toHaveLength(1)
    const card = list.issues[0]
    expect(card).toMatchObject({
      id: issue.id,
      filedTitle: TITLE,
      state: 'working',
      phase: 'implementing',
      summary: 'Writing the fix now.',
      lead,
      account: 'a',
      repoName: 'repo',
      visible: false,
      waitingOnOwner: true,
      kind: 'feature',
      size: 'm',
    })
    expect(card?.title.length).toBeLessThanOrEqual(80)
    expect(card?.title.endsWith('…')).toBe(true)
    expect(card?.quota).toMatchObject({ account: 'a', fiveHourUsed: 30, weeklyUsed: 20 })
    // the lead (2 turns) and its helper (1) sum; the transcript is the lead's, counted once per message id
    expect(card?.insights).toMatchObject({ turns: 3, toolCalls: 3, subagents: 2, attempts: 1 })
    expect(card?.insights.tokens).toEqual({ input: 14, output: 10, cacheRead: 100, cacheWrite: 40 })
    expect(card?.insights.models).toEqual(['claude-sonnet-x', 'claude-opus-x'])
    // the helper has no transcript on record: the sum is partial
    expect(card?.insights.partial).toBe(true)
    // 10 min open turn of the lead to now (10 + 10 min) + helper 10 min
    expect(card?.insights.workingMs).toBe((10 + 10 + 10) * 60_000)

    const detail = IssueDetail.parse(await (await app.get(`/v1/issues/${issue.id}`)).json())
    expect(detail.timeline.map((t) => t.kind)).toEqual(['created', 'admitted', 'phase'])
    expect(detail.timeline.map((t) => t.text)).toEqual([
      'Filed and queued.',
      'A lead was started.',
      'The lead moved on: implementing',
    ])
    expect(detail.evidence).toEqual([
      { kind: 'service', link: 'https://example.com/health', note: 'health is green', at: w.at(15).toISOString() },
    ])
    expect(detail.asks).toEqual([
      {
        question: 'Keep the old cache?',
        options: ['yes', 'no'],
        default: 'yes',
        answer: null,
        askedAt: w.at(20).toISOString(),
      },
    ])
    const ids = detail.sessions.map((s) => s.id).sort()
    expect(ids).toEqual(['helper-1', lead])
    const helper = detail.sessions.find((s) => s.id === 'helper-1')
    expect(helper).toMatchObject({ issue: issue.id, role: 'implementer', state: 'idle' })
    const leadCard = detail.sessions.find((s) => s.id === lead)
    expect(leadCard).toMatchObject({
      issue: issue.id,
      role: 'lead',
      title: 'Issue lead',
      state: 'working',
      account: 'a',
      model: 'claude-opus-x',
      terminal: { id: 'w1:p1', name: lead, tab: 'w1:t1', workspace: 'w1', space: TEST_REPO },
    })
    expect(detail.timeline.map((t) => t.text).join(' ')).not.toContain(String(issue.id))

    expect((await app.get('/v1/issues/9999')).status).toBe(404)
    const one = SessionCard.parse(await (await app.get(`/v1/sessions/${lead}`)).json())
    expect(one.issue).toBe(issue.id)
    expect((await app.get('/v1/sessions/nope')).status).toBe(404)
  })

  test('open Issues come first by recent activity; state and limit filter; a bad one is 400', async () => {
    const make = (key: string) =>
      createIssue(
        db.sql,
        { source: 'request', sourceKey: key, repo: TEST_REPO, title: key, facts: {} },
        { repoRoots: [TEST_ROOT], now: w.at(100) },
      ).then((r) => r.issue.id)
    const [a, b, c] = [await make('a'), await make('b'), await make('c')]
    await db.sql`UPDATE factory.issues SET updated_at = ${w.at(50)} WHERE id = ${a}`
    await db.sql`UPDATE factory.issues SET updated_at = ${w.at(10)} WHERE id = ${b}`
    await db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'done', closed_at = ${w.at(1)}, updated_at = ${w.at(1)} WHERE id = ${c}`
    const ids = async (query: string) =>
      IssueCards.parse(await (await app.get(`/v1/issues${query}`)).json()).issues.map((i) => i.id)
    expect(await ids('')).toEqual([b, a])
    expect(await ids('?state=all')).toEqual([b, a, c])
    expect(await ids('?state=closed')).toEqual([c])
    expect(await ids('?state=all&limit=1')).toEqual([b])
    expect((await app.get('/v1/issues?state=nope')).status).toBe(400)
    expect((await app.get('/v1/issues?limit=0')).status).toBe(400)
    const closed = IssueCards.parse(await (await app.get('/v1/issues?state=closed')).json()).issues[0]
    expect(closed?.summary).toBe('Closed as done.')
  })

  test('a short title comes from the digest cache, never for a visible repo', async () => {
    const open = (await workingIssue()).issue
    const hidden = (await workingIssue(VISIBLE_REPO, 'helper-2')).issue
    await db.sql`
      INSERT INTO factory.fleet_digest (key, fingerprint, answer, at)
      VALUES (${headingKey(cleanHeading(TITLE))}, 'f', ${{ short: 'Fix flaky login test' }}, ${NOW})`
    const cards = IssueCards.parse(await (await app.get('/v1/issues')).json()).issues
    expect(cards.find((c) => c.id === open.id)).toMatchObject({ title: 'Fix flaky login test', visible: false })
    const visible = cards.find((c) => c.id === hidden.id)
    expect(visible?.visible).toBe(true)
    expect(visible?.title).not.toBe('Fix flaky login test')
    expect(visible?.filedTitle).toBe(TITLE)
  })

  test('the overview and the lists need the fleet snapshot: 503 before it, the counts after', async () => {
    expect((await app.get('/v1/overview')).status).toBe(503)
    expect(await (await app.get('/v1/asks')).json()).toMatchObject({ code: 'not_ready' })
    await workingIssue()
    await writeSnapshot(db.sql, snapshot('fp1'))
    const overview = Overview.parse(await (await app.get('/v1/overview')).json())
    expect(overview).toMatchObject({
      version: 'v1',
      counts: { working: 1, waiting: 0, queued: 0, watching: 0, asks: 0, health: 0 },
      builtAt: NOW.toISOString(),
    })
    expect(overview.accounts.map((a) => a.account)).toEqual(['a'])
    expect(AskList.parse(await (await app.get('/v1/asks')).json())).toEqual({ asks: [] })
    expect(HealthList.parse(await (await app.get('/v1/health')).json())).toEqual({ health: [] })
    expect(AccountList.parse(await (await app.get('/v1/accounts')).json()).accounts).toHaveLength(1)
    const sessions = SessionCards.parse(await (await app.get('/v1/sessions?live=1&role=lead')).json())
    expect(sessions.sessions.map((s) => s.role)).toEqual(['lead'])
  })

  test('every /v1 route needs the token and a loopback host; the socket answers 404', async () => {
    for (const path of ['/v1/overview', '/v1/issues', '/v1/sessions', '/v1/stream']) {
      const res = await app.bare(path)
      expect(res.status).toBe(401)
    }
    expect(
      (await app.bare('/v1/issues', { method: 'POST', headers: { authorization: `Bearer ${TEST_TOKEN}` } })).status,
    ).toBe(405)
    const dir = mkdtempSync('/tmp/factory-read-sock-')
    const socket = join(dir, 'h.sock')
    const hooks = serveHooks({
      sql: db.sql,
      clock,
      token: TEST_TOKEN,
      socketPath: socket,
      repoRoots: [TEST_ROOT],
      roles: TEST_ROLES,
      slots: 2,
    })
    try {
      for (const path of ['/v1/overview', '/v1/issues', '/v1/issues/1', '/v1/sessions', '/v1/stream', '/v1/accounts']) {
        const res = await fetch(`http://localhost${path}`, { unix: socket })
        expect(res.status).toBe(404)
      }
    } finally {
      await hooks.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** The smallest stored snapshot. */
function snapshot(fingerprint: string): Fleet {
  return Fleet.parse({
    builtAt: NOW.toISOString(),
    fingerprint,
    summary: { working: 0, idle: 0, done: 0, asks: 0, staleAsks: 0 },
    asks: [],
    repos: [],
    unplaced: [],
    errors: [],
    quota: [],
    queue: { effective: 'run', spawns: [] },
  })
}

describe('describeEvent', () => {
  // The common kinds, filed the way the verbs file them, with ids and keys in the payload that must stay out of the prose.
  const payload = {
    attempt: 4711,
    key: 'issue:4711:ship:abc123',
    session: 'lead-4711-4',
    phase: 'review',
    note: 'looking at the diff',
    summary: 'Fixed the login flow.',
    reason: 'no longer needed',
    question: 'Keep the cache?',
    answer: 'yes',
    text: 'please hurry',
    until: '2026-11-07T08:00:00.000Z',
    why: 'the cap resets',
    value: 3,
    event: 'ship',
    detail: 'no evidence yet',
    commits: ['abcdef1234567'],
  }
  const kinds = [
    ...Object.keys(TABLE),
    'created',
    'refused',
    'hold',
    'transcript',
    'steward_exhausted',
    'ask_judged',
    'escalation',
  ]

  test.each(kinds)('%s reads as a plain sentence with no id or key', (kind) => {
    for (const to of [null, 'working', 'waiting', 'queued']) {
      const text = describeEvent(kind, 'working', to, payload)
      expect(text.length).toBeGreaterThan(3)
      expect(text).not.toContain('4711')
      expect(text).not.toContain('abc123')
      expect(text).not.toContain('lead-')
      expect(text).not.toContain('issue:')
      expect(text).not.toContain('abcdef1')
    }
  })

  test('an unknown kind and an unreadable payload still read', () => {
    expect(describeEvent('brand_new_kind', null, null, 'oops')).toBe('Brand new kind.')
    expect(describeEvent('ship', null, null, null)).toBe('Shipped, now held for the check.')
    expect(describeEvent('wait', null, null, { until: '2026-11-07T08:00:00.000Z' })).toBe(
      'Waiting until 2026-11-07 08:00 UTC.',
    )
  })
})

describe('insights', () => {
  const transcripts = () => new TranscriptInsights(2)

  test('tokens, tool calls, subagents and models come from the transcript, once per message', async () => {
    writeTranscript(transcript)
    const { stats, partial } = await transcripts().read(transcript)
    expect(partial).toBe(false)
    expect(stats.toolCalls).toBe(3)
    expect(stats.subagents).toBe(2)
    expect(stats.tokens).toEqual({ input: 14, output: 10, cacheRead: 100, cacheWrite: 40 })
    expect(stats.models).toEqual(['claude-sonnet-x', 'claude-opus-x'])
  })

  test('a file that did not change is not read again; one that grew is counted again', async () => {
    writeTranscript(transcript)
    const insights = transcripts()
    const first = await insights.read(transcript)
    expect((await insights.read(transcript)).stats).toBe(first.stats)
    appendFileSync(
      transcript,
      `${assistant('m4', [{ type: 'tool_use', id: 't9', name: 'Read' }], { input_tokens: 5, output_tokens: 5 })}\n`,
    )
    const grown = await insights.read(transcript)
    expect(grown.stats).not.toBe(first.stats)
    expect(grown.stats.toolCalls).toBe(4)
    expect(grown.stats.tokens.input).toBe(19)
  })

  test('a growing file counts only the appended lines, each parsed once', async () => {
    writeTranscript(transcript)
    const insights = transcripts()
    await insights.read(transcript)
    const afterFirst = insights.parsed
    expect(afterFirst).toBeGreaterThan(0)
    for (const [n, id] of [1, 2, 3].entries()) {
      appendFileSync(
        transcript,
        `${assistant(`g${id}`, [{ type: 'tool_use', id: `gt${id}`, name: 'Read' }], { input_tokens: 1, output_tokens: 1 })}\n`,
      )
      const { stats } = await insights.read(transcript)
      expect(stats.toolCalls).toBe(3 + n + 1)
      expect(stats.tokens.input).toBe(14 + n + 1)
      expect(insights.parsed).toBe(afterFirst + n + 1)
    }
  })

  test('a partial trailing line is not counted until it is complete', async () => {
    writeTranscript(transcript)
    const insights = transcripts()
    await insights.read(transcript)
    const line = assistant('p1', [{ type: 'tool_use', id: 'pt1', name: 'Read' }], { input_tokens: 7, output_tokens: 1 })
    appendFileSync(transcript, line.slice(0, 30))
    const half = await insights.read(transcript)
    expect(half.partial).toBe(false)
    expect(half.stats.toolCalls).toBe(3)
    appendFileSync(transcript, `${line.slice(30)}\n`)
    const whole = await insights.read(transcript)
    expect(whole.stats.toolCalls).toBe(4)
    expect(whole.stats.tokens.input).toBe(21)
  })

  test('a file that shrank is counted from the start', async () => {
    writeTranscript(transcript)
    const insights = transcripts()
    await insights.read(transcript)
    writeFileSync(
      transcript,
      `${assistant('s1', [{ type: 'tool_use', id: 'st1', name: 'Read' }], { input_tokens: 2, output_tokens: 1 })}\n`,
    )
    const { stats } = await insights.read(transcript)
    expect(stats.toolCalls).toBe(1)
    expect(stats.tokens).toEqual({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0 })
  })

  test('the cache is bounded', async () => {
    const insights = transcripts()
    for (const name of ['a', 'b', 'c']) {
      const path = join(scratch, '.claude-test', 'projects', 'proj', `${name}.jsonl`)
      writeTranscript(path)
      await insights.read(path)
    }
    expect(insights.size).toBe(2)
  })

  test('a path outside Claude’s transcripts, a missing file or no path is zeros and partial', async () => {
    const outside = join(scratch, 'notes.jsonl')
    writeTranscript(outside)
    const insights = transcripts()
    for (const path of [outside, join(scratch, '.claude-test', 'projects', 'proj', 'gone.jsonl'), null]) {
      const read = await insights.read(path)
      expect(read.partial).toBe(true)
      expect(read.stats.toolCalls).toBe(0)
      expect(read.stats.tokens.input).toBe(0)
    }
    expect(insights.size).toBe(0)
  })

  test('working time: a turn runs from its start to its end, an open one to now, a dead session to its last event', () => {
    const at = (m: number) => new Date(NOW.getTime() + m * 60_000)
    const events = [
      { kind: 'session_started', at: at(0) },
      { kind: 'turn_started', at: at(1) },
      { kind: 'turn_ended', at: at(4) },
      { kind: 'turn_started', at: at(10) },
    ]
    expect(workingOf(events, at(20), null)).toEqual({ workingMs: (3 + 10) * 60_000, turns: 2 })
    expect(workingOf(events, at(20), at(12))).toEqual({ workingMs: (3 + 2) * 60_000, turns: 2 })
    expect(workingOf([], at(20), null)).toEqual({ workingMs: 0, turns: 0 })
  })
})
