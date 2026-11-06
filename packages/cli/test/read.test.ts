import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { EXIT } from '../src/exit.ts'
import { insightsLine } from '../src/read.ts'

const BIN = join(import.meta.dir, '..', 'bin', 'factory.ts')
const TOKEN = 'read-test-token-0123456789'

const INSIGHTS = {
  startedAt: '2026-11-06T10:00:00.000Z',
  endedAt: null,
  elapsedMs: 3_600_000,
  workingMs: 40 * 60_000,
  turns: 5,
  toolCalls: 12,
  subagents: 3,
  tokens: { input: 100_000, output: 100_000, cacheRead: 900_000, cacheWrite: 100_000 },
  models: ['m'],
  attempts: 1,
  partial: false,
}
const QUOTA = {
  account: 'a1',
  fiveHourUsed: 40,
  weeklyUsed: 10,
  fiveHourResetsAt: null,
  weeklyResetsAt: null,
  exhaustedUntil: null,
  fresh: true,
}
const CARD = {
  id: 7,
  filedTitle: 'Fix the thing in the repo',
  title: 'Fix the thing',
  summary: 'Working on it.',
  about: 'Keeps the login stable.',
  state: 'working',
  reason: null,
  outcome: null,
  phase: null,
  repo: '/work/repo',
  repoName: 'repo',
  visible: false,
  kind: null,
  size: null,
  lead: 'lead-1',
  account: 'a1',
  quota: QUOTA,
  insights: INSIGHTS,
  createdAt: '2026-11-06T10:00:00.000Z',
  updatedAt: '2026-11-06T10:30:00.000Z',
  closedAt: null,
  waitingOnOwner: false,
}
const SESSION = {
  id: 'lead-1',
  issue: 7,
  parent: null,
  role: 'lead',
  title: 'Lead',
  summary: 'Leading.',
  state: 'working',
  wait: null,
  account: 'a1',
  quota: QUOTA,
  model: null,
  turn: 2,
  terminal: null,
  transcriptPath: null,
  repo: '/work/repo',
  visible: false,
  since: null,
  lastActivityAt: '2026-11-06T10:30:00.000Z',
  insights: INSIGHTS,
}
const DETAIL = {
  ...CARD,
  timeline: [{ at: '2026-11-06T10:00:00.000Z', kind: 'filed', text: 'Filed.', session: null }],
  evidence: [],
  asks: [],
  sessions: [SESSION],
}
const ASK = {
  id: 'decision:1',
  kind: 'question',
  repo: null,
  session: null,
  short: 'Which way?',
  text: 'Which way should it go?',
  source: 'decision',
  at: '2026-11-06T10:00:00.000Z',
  summary: 'Which way it should go.',
  issue: null,
  stale: false,
}
const QUEUED = {
  ...ASK,
  id: 'queue:1',
  kind: 'human',
  short: 'Review the notes',
  summary: 'Read the release notes.',
  source: 'queue',
  stale: true,
}
const HEALTH = {
  id: 'health:x:1',
  kind: 'silent',
  text: 'quiet',
  short: 'A quiet lead',
  summary: 'The lead has been quiet.',
  repo: null,
  since: '2026-11-06T09:00:00.000Z',
}

const frame = (id: string, event: string, data: unknown) =>
  `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const issueFrame = (n: number, to: string) =>
  frame(`i${n}.s0`, 'issue', {
    issue: 7,
    kind: 'state',
    from: 'working',
    to,
    at: `2026-11-06T10:00:0${n}.000Z`,
    text: `moved to ${to}`,
  })

const requests: { path: string; search: string; lastEventId: string | null }[] = []
let streamPlan: (call: number, req: Request) => Response = () => new Response('', { status: 500 })
let streamCalls = 0
let fake: ReturnType<typeof Bun.serve>
let detail: unknown = DETAIL

const json = (body: unknown, status = 200) => Response.json(body, { status })

beforeAll(() => {
  fake = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url)
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return json({ error: 'unauthorized' }, 401)
      requests.push({ path: url.pathname, search: url.search, lastEventId: req.headers.get('last-event-id') })
      switch (url.pathname) {
        case '/v1/overview':
          return json({
            version: 'v1',
            now: 'n',
            builtAt: 'b',
            counts: { working: 1, waiting: 0, queued: 2, watching: 0, asks: 1, humanQueue: 0, health: 1 },
            asks: [ASK],
            humanQueue: [QUEUED],
            health: [HEALTH],
            accounts: [QUOTA],
            queue: { effective: 'run', spawns: [] },
          })
        case '/v1/issues':
          return json({ issues: [CARD] })
        case '/v1/issues/7':
          return json(detail)
        case '/v1/sessions':
          return json({ sessions: [SESSION] })
        case '/v1/sessions/lead-1':
          return json(SESSION)
        case '/v1/asks':
          return json({ asks: [ASK], humanQueue: [QUEUED] })
        case '/v1/health':
          return json({ health: [HEALTH] })
        case '/v1/accounts':
          return json({ accounts: [QUOTA] })
        case '/v1/stream':
          return streamPlan(++streamCalls, req)
        default:
          return json({ error: 'unknown' }, 404)
      }
    },
  })
})
afterAll(async () => {
  await fake.stop(true)
})

async function factory(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    env: { ...process.env, FACTORY_URL: String(fake.url), FACTORY_TOKEN: TOKEN, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  return { stdout, stderr, code }
}

describe('insightsLine', () => {
  test('reads as people say it', () => {
    expect(insightsLine(INSIGHTS)).toBe('12 tool calls · 3 subagents · 1.2M tokens · 40 min working')
    expect(
      insightsLine({
        ...INSIGHTS,
        toolCalls: 1,
        subagents: 1,
        workingMs: 20_000,
        tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toBe('1 tool call · 1 subagent · 5 tokens · 20 s working')
  })
})

describe('factory read', () => {
  test('json prints the parsed body of each resource', async () => {
    for (const [args, expected] of [
      [['read', 'issues'], { issues: [CARD] }],
      [['read', 'issue', '7'], DETAIL],
      [['read', 'sessions'], { sessions: [SESSION] }],
      [['read', 'session', 'lead-1'], SESSION],
      [['read', 'asks'], { asks: [ASK], humanQueue: [QUEUED] }],
      [['read', 'health'], { health: [HEALTH] }],
      [['read', 'accounts'], { accounts: [QUOTA] }],
    ] as const) {
      const r = await factory([...args])
      expect(r).toMatchObject({ code: EXIT.ok, stderr: '' })
      expect(JSON.parse(r.stdout)).toEqual(expected as unknown as Record<string, unknown>)
    }
    const overview = await factory(['read', 'overview'])
    expect(JSON.parse(overview.stdout).counts.queued).toBe(2)
  })

  test('filters become the query', async () => {
    requests.length = 0
    await factory(['read', 'issues', '--state', 'all', '--limit', '5'])
    await factory(['read', 'sessions', '--issue', '7', '--role', 'lead', '--live'])
    expect(requests.map((r) => r.search)).toEqual(['?state=all&limit=5', '?issue=7&role=lead&live=1'])
  })

  test('plain prints a row per item with the insights and no ids in the prose', async () => {
    const issues = await factory(['--format', 'plain', 'read', 'issues'])
    expect(issues.stdout).toBe(
      '7\tworking\trepo\tFix the thing\tWorking on it.\t12 tool calls · 3 subagents · 1.2M tokens · 40 min working\n',
    )
    const sessions = await factory(['--format', 'plain', 'read', 'sessions'])
    expect(sessions.stdout.split('\t').slice(0, 5)).toEqual(['lead-1', 'working', 'lead', 'Lead', 'Leading.'])
    const one = await factory(['--format', 'plain', 'read', 'issue', '7'])
    expect(one.stdout).toContain('timeline\n2026-11-06T10:00:00.000Z\tfiled\tFiled.')
    const overview = await factory(['--format', 'plain', 'read', 'overview'])
    expect(overview.stdout).toContain('1 working · 0 waiting · 2 queued')
    expect(overview.stdout).toContain('1 asks · 0 human queue · 1 health')
    expect(overview.stdout).toContain(
      'ask\tWhich way?\tWhich way it should go.\t2026-11-06T10:00:00.000Z\tquestion\t-\t\n',
    )
    expect(overview.stdout).toContain('human queue\tReview the notes\tRead the release notes.')
    const asks = await factory(['--format', 'plain', 'read', 'asks'])
    expect(asks.stdout).toContain('\thuman\t-\tstale\n')
    const health = await factory(['--format', 'plain', 'read', 'health'])
    expect(health.stdout).toBe('A quiet lead\tThe lead has been quiet.\t2026-11-06T09:00:00.000Z\tsilent\t-\n')
    expect(overview.stdout).toContain('account\ta1\t5h 40%\tweek 10%\tavailable\tfresh')
  })

  test('errors keep the exit table', async () => {
    expect((await factory(['read', 'issues'], { FACTORY_TOKEN: '' })).code).toBe(EXIT.auth)
    expect((await factory(['read', 'issues'], { FACTORY_TOKEN: 'wrong' })).code).toBe(EXIT.auth)
    expect((await factory(['read', 'session', 'nope'])).code).toBe(EXIT.not_found)
    expect((await factory(['read', 'bogus'])).code).toBe(EXIT.usage)
    expect((await factory(['read', 'issue', 'x'])).code).toBe(EXIT.usage)
    expect((await factory(['read', 'issues', '--state', 'x'])).code).toBe(EXIT.usage)
    expect((await factory(['read', 'asks'], { FACTORY_URL: 'http://127.0.0.1:1' })).code).toBe(EXIT.network)
  })

  test('a body that is not the schema is exit 9', async () => {
    detail = { ...DETAIL, state: 'nonsense' }
    const r = await factory(['read', 'issue', '7'])
    detail = DETAIL
    expect(r.code).toBe(EXIT.contract_mismatch)
  })
})

describe('factory follow', () => {
  const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } })

  test('prints one JSON object per frame, reconnects with Last-Event-ID, and --until-closed exits 0', async () => {
    streamCalls = 0
    requests.length = 0
    streamPlan = (call) => {
      if (call === 1)
        return sse(
          `${frame('i1.s0', 'hello', { version: 'v1', cursor: 'i1.s0' })}: keepalive\n\n${issueFrame(2, 'waiting')}`,
        )
      return sse(issueFrame(3, 'closed'))
    }
    const r = await factory(['follow', '--issue', '7', '--until-closed'])
    expect(r).toMatchObject({ code: EXIT.ok, stderr: '' })
    const lines = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.map((l) => [l.event, l.id])).toEqual([
      ['hello', 'i1.s0'],
      ['issue', 'i2.s0'],
      ['issue', 'i3.s0'],
    ])
    expect(lines[2].data).toMatchObject({ issue: 7, to: 'closed' })
    const streams = requests.filter((q) => q.path === '/v1/stream')
    expect(streams.map((q) => [q.search, q.lastEventId])).toEqual([
      ['?issue=7', null],
      ['?issue=7', 'i2.s0'],
    ])
  })

  test('plain prints a time and the frame words', async () => {
    streamPlan = () => sse(`${issueFrame(2, 'closed')}`)
    const r = await factory(['--format', 'plain', 'follow', '--issue', '7', '--until-closed'])
    expect(r.stdout).toBe('10:00:02\t7\tmoved to closed\n')
  })

  test('--until-closed on an Issue that is already closed exits 0 at once', async () => {
    detail = { ...DETAIL, state: 'closed' }
    streamCalls = 0
    const r = await factory(['follow', '--issue', '7', '--until-closed'])
    detail = DETAIL
    expect(r).toMatchObject({ code: EXIT.ok, stdout: '' })
    expect(streamCalls).toBe(0)
  })

  test('410 says so on stderr and exits with the status table code', async () => {
    streamPlan = () => json({ error: 'unknown cursor' }, 410)
    const r = await factory(['follow', '--since', 'i99.s99'])
    expect(r.code).toBe(EXIT.general)
    expect(r.stderr).toContain('unknown cursor')
    expect(r.stderr).toContain('read the resources again')
  })

  test('usage and auth errors', async () => {
    expect((await factory(['follow', '--until-closed'])).code).toBe(EXIT.usage)
    expect((await factory(['follow'], { FACTORY_TOKEN: '' })).code).toBe(EXIT.auth)
    expect((await factory(['follow'], { FACTORY_URL: 'http://127.0.0.1:1' })).code).toBe(EXIT.network)
  })

  test('an unparsable frame is exit 9', async () => {
    streamPlan = () => sse(frame('i1.s0', 'issue', { issue: 'x' }))
    expect((await factory(['follow'])).code).toBe(EXIT.contract_mismatch)
  })

  test('SIGTERM ends a quiet stream with exit 0', async () => {
    streamPlan = () => sse(frame('i1.s0', 'hello', { version: 'v1', cursor: 'i1.s0' }))
    const proc = Bun.spawn(['bun', BIN, 'follow'], {
      env: { ...process.env, FACTORY_URL: String(fake.url), FACTORY_TOKEN: TOKEN },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // The fake ends each stream at once, so the CLI is in its backoff sleep: the signal must wake it.
    const reader = proc.stdout.getReader()
    await reader.read()
    proc.kill('SIGTERM')
    expect(await proc.exited).toBe(EXIT.ok)
  })
})
