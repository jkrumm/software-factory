import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { bearer, type Caller } from '../harness.ts'
import { REQUESTS, RETIRED, type ClientRequest } from './requests.ts'
import { addWorkRepo, call, fieldsOf, startClientsWorld, type VerbsWorld } from './support.ts'

/**
 * Group C, the recorded requests: what the Herdr board, Hermes, Iris, agw and the repo's own scripts ask of the factory,
 * replayed against the real server over HTTP or the CLI exactly as the client does it, with the token it holds, on a
 * world seeded through real flows (an Issue working with a lead, an open Decision, an open Errand, a held signal, a
 * closed Issue, a health line, a work repo).
 *
 * Argo: the sweep found no call to the factory (`grep -rn "7793\|FACTORY_\|/v1/\|factory read"` over
 * ~/SourceRoot/argo finds nothing), so it has no request here.
 */
let v: VerbsWorld
let working = ''
let deciding = ''
let errand = ''
let closed = ''
let workIssue = ''
let heldSignal = ''
const number = (issue: string) => issue.slice('issue_'.length)

const DECISION = [
  '--attempt',
  '1',
  '--question',
  'Which way do we fix the checkout hang?',
  '--recommendation',
  'Ship the quick fix',
  '--checked',
  'the submit handler',
  '--options',
  JSON.stringify([
    { label: 'Ship the quick fix', reversible: true, cost: 'one hour' },
    { label: 'Redesign the form', reversible: false, cost: 'two days' },
  ]),
  '--no-answer',
  JSON.stringify({ consequence: 'the quick fix ships', default: 'Ship the quick fix', waitMinutes: 600 }),
]

const started = async (title: string) => {
  const issue = await v.w.admitted(title)
  await v.w.tick()
  return issue
}
const lead = (issue: string) => ({ FACTORY_SESSION: `lead-${number(issue)}-1` })

const http = (
  path: string,
  options: { as?: Caller | 'none'; method?: string; body?: object; headers?: Record<string, string> } = {},
) => {
  const as = options.as ?? 'owner'
  return fetch(`${v.w.server.url}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(as === 'none' ? {} : bearer(as)),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
}

beforeAll(async () => {
  v = await startClientsWorld({ FACTORY_STREAM_POLL_MS: '50' })
  working = await started('the checkout page hangs on submit')
  deciding = await started('the cache key collides')
  errand = await started('the printer needs a cable')
  closed = await started('an old thing that is done')

  const asked = await call(v, ['issue', 'ask', deciding, ...DECISION], 'agent', lead(deciding))
  if (asked.code !== 0) throw new Error(`ask: ${asked.err}`)
  const raised = await call(
    v,
    ['errand', 'raise', errand, '--attempt', '1', '--summary', 'plug it in', '--detail', 'the cable'],
    'agent',
    lead(errand),
  )
  if (raised.code !== 0) throw new Error(`errand: ${raised.err}`)
  const done = await call(
    v,
    ['issue', 'close', closed, '--attempt', '1', '--outcome', 'done', '--reason', 'nothing to deploy'],
    'agent',
    lead(closed),
  )
  if (done.code !== 0) throw new Error(`close: ${done.err}`)

  const held = await call(v, [
    'signal',
    'file',
    '--from',
    'feedback:example',
    '--title',
    'Export is broken',
    '--text',
    'it does nothing',
  ])
  heldSignal = String((held.json as { signal: string }).signal)
  const doorStart = await call(v, ['door', 'report', '--kind', 'start', '--sources', 'kuma'], 'machine')
  if (doorStart.code !== 0) throw new Error(`door start: ${doorStart.err}`)
  // Three refused POSTs and none accepted since: the door's source shows as a health line.
  for (let i = 0; i < 3; i++) {
    const refused = await call(v, ['door', 'report', '--kind', 'refused', '--source', 'kuma'], 'machine')
    if (refused.code !== 0) throw new Error(`door report: ${refused.err}`)
  }

  await addWorkRepo(v, 'chat')
  const filed = await call(v, [
    'issue',
    'new',
    '--repo',
    'chat',
    '--title',
    'Rotate the payroll export key',
    '--key',
    'work-1',
    '--text',
    'the secret text',
  ])
  workIssue = String((filed.json as { issue: string }).issue)
  const synced = await call(v, ['project', 'sync'])
  if (synced.code !== 0) throw new Error(`sync: ${synced.err}`)
}, 120_000)

afterAll(async () => {
  await v.stop()
})

const fill = (text: string) => text.replaceAll('{n}', number(working)).replaceAll('{d}', number(deciding))

function check(label: string, body: unknown, request: Pick<ClientRequest, 'root' | 'nested' | 'each'>): void {
  const problems: string[] = []
  const add = (where: string, problem: string[]) => problems.push(...problem.map((text) => `${where}${text}`))
  if (request.root) add('', fieldsOf(body, request.root))
  for (const [key, fields] of Object.entries(request.nested ?? {})) {
    add(`${key}.`, fieldsOf((body as Record<string, unknown>)[key], fields))
  }
  for (const [key, fields] of Object.entries(request.each ?? {})) {
    const items = (body as Record<string, unknown>)[key]
    if (!Array.isArray(items) || items.length === 0) {
      problems.push(`${key}: no items to check (seed it)`)
      continue
    }
    for (const item of items) add(`${key}[].`, fieldsOf(item, fields))
  }
  expect({ label, problems }).toEqual({ label, problems: [] })
}

describe('recorded requests', () => {
  for (const request of REQUESTS) {
    test(`${request.client} ${request.source}: ${request.call}`, async () => {
      if (request.via === 'cli') {
        const ran = await call(v, (request.argv ?? []).map(fill), request.token)
        expect({ call: request.call, code: ran.code, err: ran.err }).toEqual({ call: request.call, code: 0, err: '' })
        check(request.call, ran.json, request)
        return
      }
      const http_ = request.http
      if (!http_) throw new Error('no http call')
      const response = await http(fill(http_.path), { as: request.token, method: http_.method })
      expect(response.status).toBe(200)
      check(request.call, await response.json(), request)
    })
  }
})

describe('retired commands', () => {
  for (const retired of RETIRED) {
    test(`${retired.client} ${retired.source}: factory ${retired.argv.join(' ')} is exit 2 and names ${retired.hint}`, async () => {
      const ran = await call(v, retired.argv)
      expect(ran.code).toBe(2)
      expect(JSON.stringify(ran.error)).toContain(retired.hint)
    })
  }
})

describe('the ids legacy clients read', () => {
  test('cards carry the number as id and issue_<n> as ref; both forms answer', async () => {
    const cards = (await (await http('/v1/issues')).json()) as { issues: { id: number; ref: string }[] }
    const card = cards.issues.find((c) => c.ref === working)
    expect(card?.id).toBe(Number(number(working)))
    const asks = (await (await http('/v1/asks')).json()) as {
      asks: { issue: number | null; issueRef: string | null }[]
    }
    expect(asks.asks.some((ask) => ask.issue === Number(number(deciding)) && ask.issueRef === deciding)).toBe(true)
    for (const id of [number(working), working]) {
      const response = await http(`/v1/issues/${id}`)
      expect(response.status).toBe(200)
      expect(((await response.json()) as { ref: string }).ref).toBe(working)
    }
  })
})

describe('Hermes', () => {
  test('the read token reads; a write is 403 forbidden (exit 3)', async () => {
    const filed = await call(
      v,
      ['signal', 'file', '--from', 'owner:hermes', '--repo', 'example', '--title', 'Do a thing'],
      'read',
    )
    expect({ code: filed.code, kind: filed.error?.code }).toEqual({ code: 3, kind: 'forbidden' })
    // hermes-agent/skills/fleet/SKILL.md:58: `factory issue new --repo ~/SourceRoot/<repo> --title "…" --facts -` with no write token
    const issue = await call(
      v,
      ['issue', 'new', '--repo', 'example', '--title', 'Do a thing', '--facts', '{"a":1}'],
      'read',
    )
    expect({ code: issue.code, kind: issue.error?.code }).toEqual({ code: 3, kind: 'forbidden' })
  })

  test('filing as `owner:hermes` under the owner token is a stored owner signal', async () => {
    const filed = await call(v, [
      'signal',
      'file',
      '--from',
      'owner:hermes',
      '--repo',
      'example',
      '--title',
      'Hermes asks for a cache purge',
    ])
    expect(filed.code).toBe(0)
    const signals = (await (await http('/v1/signals')).json()) as {
      signals: { id: string; trust: string; source: string }[]
    }
    expect(signals.signals.find((s) => s.id === (filed.json as { signal: string }).signal)).toMatchObject({
      source: 'owner:hermes',
      trust: 'owner',
    })
  })
})

describe('Hermes, filing with the signal token', () => {
  test('the patched skill files `owner:hermes` under FACTORY_SIGNAL_TOKEN: a stored owner signal; the same token reads nothing', async () => {
    const filed = await call(
      v,
      ['signal', 'file', '--from', 'owner:hermes', '--repo', 'example', '--title', 'Hermes files with its own token'],
      'signal',
    )
    expect(filed.code).toBe(0)
    const signals = (await (await http('/v1/signals')).json()) as {
      signals: { id: string; trust: string; source: string }[]
    }
    expect(signals.signals.find((s) => s.id === (filed.json as { signal: string }).signal)).toMatchObject({
      source: 'owner:hermes',
      trust: 'owner',
    })
    const read = await call(v, ['read', 'overview'], 'signal')
    expect({ code: read.code, kind: read.error?.code }).toEqual({ code: 3, kind: 'forbidden' })
  })
})

describe('Iris', () => {
  test('GET /v1/issues/{n}: the open question is the last ask without an answer, with its options', async () => {
    const detail = (await (await http(`/v1/issues/${number(deciding)}`)).json()) as {
      asks: { options: string[]; answer: string | null }[]
    }
    const open = detail.asks.findLast((ask) => ask.answer == null)
    expect(open?.options).toEqual(['Ship the quick fix', 'Redesign the form'])
  })

  // iris/server/src/adapters/factory-http.ts:182: POST /issues/{n}/answer {id, answer}, parsed as {issue: int, state, duplicate}
  test('POST /issues/{n}/answer answers the Decision; the answer reaches the lead; a repeat is not a second answer', async () => {
    const before =
      v.w.terminals().find((t) => t.labels['factory.key'] === `lead-${number(deciding)}-1`)?.sent.length ?? 0
    const answered = await http(`/issues/${number(deciding)}/answer`, {
      method: 'POST',
      body: { id: 'iris-call-1', answer: 'Ship the quick fix' },
    })
    expect(answered.status).toBe(200)
    const ack = (await answered.json()) as {
      decision: { id: string; answer: string | null }
      issue: { id: string; state: string } | null
    }
    expect(fieldsOf(ack, { decision: 'object', issue: 'object|null' })).toEqual([])
    expect(ack.decision.answer).toBe('Ship the quick fix')
    // The new ack is {decision, issue: {id, state, ...}}: Iris' AnswerAck wants {issue: number, state, duplicate} (package 9).

    await v.w.tick()
    const terminal = v.w.terminals().find((t) => t.labels['factory.key'] === `lead-${number(deciding)}-1`)
    expect((terminal?.sent ?? []).slice(before).join('\n')).toContain('Ship the quick fix')

    const again = await http(`/issues/${number(deciding)}/answer`, {
      method: 'POST',
      body: { id: 'iris-call-1', answer: 'Ship the quick fix' },
    })
    // A second answer finds no open Decision: 409 no_open_decision where the old ack said `duplicate: true` (package 9: Iris).
    expect(again.status).toBe(409)
    expect(((await again.json()) as { code: string }).code).toBe('no_open_decision')
  })

  test('GET /v1/stream: hello, then issue events, and a resume loses and doubles nothing', async () => {
    const first = frames(await http('/v1/stream', { headers: { accept: 'text/event-stream' } }))
    const hello = await first.until((frame) => frame.event === 'hello')
    expect(hello.id).toMatch(/^\d+\.\d+$/)
    expect(JSON.parse(hello.data)).toMatchObject({ version: 'v1', cursor: hello.id })

    const filed = await call(v, [
      'issue',
      'new',
      '--repo',
      'example',
      '--title',
      'Stream the first change',
      '--key',
      'stream-1',
    ])
    expect(filed.code).toBe(0)
    const issue = await first.until((frame) => frame.event === 'issue')
    expect(JSON.parse(issue.data)).toMatchObject({ kind: 'issue', ref: expect.stringMatching(/^issue_\d+$/) })
    await first.close()
    const seen = first.seen.filter((frame) => frame.event !== 'hello').map((frame) => frame.id)
    const last = seen.at(-1) ?? ''

    await call(v, ['issue', 'new', '--repo', 'example', '--title', 'Stream the second change', '--key', 'stream-2'])
    const all = (await (await http(`/v1/changes?since=${hello.id}&limit=500`)).json()) as {
      changes: { cursor: string }[]
      cursor: string
    }
    const second = frames(await http(`/v1/stream?since=${last}`, { headers: { accept: 'text/event-stream' } }))
    await second.until((frame) => frame.id === all.cursor)
    await second.close()
    const resumed = second.seen.filter((frame) => frame.event !== 'hello').map((frame) => frame.id)
    expect([...seen, ...resumed]).toEqual(all.changes.map((change) => change.cursor))
    expect(new Set([...seen, ...resumed]).size).toBe(seen.length + resumed.length)

    // Last-Event-ID resumes the same way
    const header = frames(await http('/v1/stream', { headers: { accept: 'text/event-stream', 'last-event-id': last } }))
    await header.until((frame) => frame.id === all.cursor)
    await header.close()
    expect(header.seen.filter((frame) => frame.event !== 'hello').map((frame) => frame.id)).toEqual(resumed)
  }, 60_000)
})

describe('the repo scripts', () => {
  test('scripts/verify.sh: GET /spawns without a token is 401, `factory health` is exit 0', async () => {
    expect((await http('/spawns', { as: 'none' })).status).toBe(401)
    const health = await call(v, ['health'])
    expect(health.code).toBe(0)
    expect(health.json).toMatchObject({ status: 'ok', version: 'scenario' })
  })
})

describe('auth', () => {
  test('no token is 401 on every route but /health, the stream and an unknown path included', async () => {
    const routes: [string, string][] = [
      ['GET', '/v1/overview'],
      ['GET', '/v1/issues/1'],
      ['GET', '/v1/stream'],
      ['GET', '/v1/errands'],
      ['GET', '/projects'],
      ['GET', '/capacity'],
      ['GET', '/queue'],
      ['GET', '/issues/1/quality'],
      ['GET', '/nowhere'],
      ['GET', '/v1/nowhere'],
      ['POST', '/issues'],
      ['POST', '/issues/1/answer'],
      ['POST', '/signals'],
      ['POST', '/signals/alerts'],
      ['POST', '/door/reports'],
      ['POST', '/v1/issues/1/close'],
      ['POST', '/v1/sessions/lead-1-1/note'],
      ['POST', '/v1/loops/leads/run'],
      ['PUT', '/slots/x'],
      ['PUT', '/queue'],
      ['DELETE', '/slots/x'],
      ['PATCH', '/issues'],
    ]
    for (const [method, path] of routes) {
      const response = await http(path, { as: 'none', method })
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 401 })
    }
    expect((await http('/health', { as: 'none' })).status).toBe(200)
    expect((await http('/v1/overview', { headers: { authorization: 'Bearer not-a-token-at-all-0000' } })).status).toBe(
      401,
    )
  })

  test('the read token passes GET /v1/* and the stream, and is 403 on a write and on a GET outside /v1', async () => {
    for (const path of [
      '/v1/overview',
      '/v1/issues',
      `/v1/issues/${number(working)}`,
      '/v1/asks',
      '/v1/sessions?live=1',
      '/v1/needs',
      '/v1/signals',
      '/v1/health',
    ]) {
      expect({ path, status: (await http(path, { as: 'read' })).status }).toEqual({ path, status: 200 })
    }
    const stream = await http('/v1/stream', { as: 'read' })
    expect(stream.status).toBe(200)
    await stream.body?.cancel()
    for (const [method, path] of [
      ['POST', '/issues'],
      ['POST', '/signals'],
      ['POST', '/issues/1/note'],
      ['POST', '/v1/issues/1/close'],
      ['PUT', '/queue'],
      ['GET', '/projects'],
      ['GET', '/capacity'],
      ['GET', '/v1/errands'],
    ] as const) {
      const response = await http(path, { as: 'read', method, body: method === 'GET' ? undefined : {} })
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 403 })
    }
  })

  test('signal trust follows the token, never the claimed from', async () => {
    const claimed = await call(
      v,
      ['signal', 'file', '--from', 'owner:impostor', '--repo', 'example', '--title', 'I am the owner'],
      'agent',
      lead(working),
    )
    expect({ code: claimed.code, kind: claimed.error?.code }).toEqual({ code: 3, kind: 'trust_refused' })

    const agent = await call(v, [
      'signal',
      'file',
      '--from',
      'agent:example',
      '--title',
      'A note from the owner token about an agent',
    ])
    expect(agent.code).toBe(0)
    const own = await call(
      v,
      ['signal', 'file', '--from', 'agent:example', '--title', 'A follow-up from a lead'],
      'agent',
      lead(working),
    )
    expect(own.code).toBe(0)
    const signals = (await (await http('/v1/signals')).json()) as { signals: { id: string; trust: string }[] }
    for (const filed of [agent, own]) {
      const id = (filed.json as { signal: string }).signal
      expect(signals.signals.find((s) => s.id === id)?.trust).toBe('agent')
    }
  })

  test('the door token is accepted on signal alert and door report, and refused elsewhere', async () => {
    const route = await call(v, ['door', 'route-set', '--source', 'kuma', '--monitor', 'billing', '--repo', 'example'])
    expect(route.code).toBe(0)
    const alert = JSON.stringify({
      source: 'kuma',
      monitor: 'billing',
      event: 'down-9',
      status: 'down',
      title: 'billing is down',
      facts: {},
    })
    expect((await call(v, ['signal', 'alert', '--body', alert], 'machine')).code).toBe(0)
    expect((await call(v, ['door', 'report', '--kind', 'accepted', '--source', 'kuma'], 'machine')).code).toBe(0)
    for (const args of [
      ['signal', 'file', '--from', 'agent:example', '--title', 'x'],
      ['issue', 'new', '--repo', 'example', '--title', 'x'],
      ['read', 'overview'],
      ['issue', 'close', working, '--attempt', '1', '--outcome', 'done', '--reason', 'x'],
      ['queue', 'set', 'drain'],
    ]) {
      const refused = await call(v, args, 'machine')
      expect({ args, code: refused.code, kind: refused.error?.code }).toEqual({ args, code: 3, kind: 'forbidden' })
    }
    // the alert's signal is stored with the machine's trust
    const signals = (await (await http('/v1/signals')).json()) as { signals: { source: string; trust: string }[] }
    expect(signals.signals.find((s) => s.source === 'kuma')?.trust).toBe('machine')
  })

  test('an agent token cannot read the owner-only errand list or file an owner verb', async () => {
    expect((await http('/v1/errands', { as: 'agent' })).status).toBe(403)
    expect((await http('/v1/overview', { as: 'agent' })).status).toBe(200)
  })
})

describe('work-repo redaction', () => {
  const TEXTS = ['Rotate the payroll export key', 'the secret text']

  test('the owner reads the work repo Issue in full', async () => {
    for (const path of ['/v1/overview', '/v1/issues', '/v1/needs']) {
      const text = await (await http(path)).text()
      if (path !== '/v1/needs') expect(text).toContain('Rotate the payroll export key')
    }
    const detail = (await (await http(`/v1/issues/${number(workIssue)}`)).json()) as { title: string; visible: boolean }
    expect(detail).toMatchObject({ title: 'Rotate the payroll export key', visible: true })
  })

  test('the read token sees no title or summary text of it', async () => {
    for (const path of [
      '/v1/overview',
      '/v1/issues',
      '/v1/needs',
      `/v1/issues/${number(workIssue)}`,
      '/v1/sessions',
      '/v1/signals',
    ]) {
      const response = await http(path, { as: 'read' })
      expect({ path, status: response.status }).toEqual({ path, status: 200 })
      const text = await response.text()
      for (const secret of TEXTS) expect({ path, leaked: text.includes(secret) }).toEqual({ path, leaked: false })
    }
    const cards = (await (await http('/v1/issues', { as: 'read' })).json()) as {
      issues: { id: number; title: string; visible: boolean }[]
    }
    expect(cards.issues.find((c) => c.id === Number(number(workIssue)))).toMatchObject({
      title: `Issue #${number(workIssue)}`,
      visible: true,
    })
    // a personal repo's text is still read
    expect(cards.issues.find((c) => c.id === Number(number(working)))?.title).toBe('The checkout page hangs on submit')
  })

  test('the held signal of outside text is redacted for the read token and read by the owner', async () => {
    const owner = (await (await http('/v1/signals')).json()) as { signals: { id: string; redacted: boolean }[] }
    const read = (await (await http('/v1/signals', { as: 'read' })).json()) as {
      signals: { id: string; text: string; redacted: boolean }[]
    }
    expect(owner.signals.find((s) => s.id === heldSignal)).toBeDefined()
    expect(read.signals.find((s) => s.id === heldSignal)).toMatchObject({ text: '', redacted: true })
  })
})

interface Frame {
  id: string | null
  event: string | null
  data: string
}

/** The frames of an open stream, read as they arrive. */
function frames(response: Response) {
  if (!response.body) throw new Error('the stream has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const seen: Frame[] = []
  return {
    seen,
    async until(done: (frame: Frame) => boolean, timeoutMs = 15_000): Promise<Frame> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const end = buffer.indexOf('\n\n')
        if (end >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (block.startsWith(':')) continue
          const frame: Frame = { id: null, event: null, data: '' }
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) frame.id = line.slice(4)
            if (line.startsWith('event: ')) frame.event = line.slice(7)
            if (line.startsWith('data: ')) frame.data += line.slice(6)
          }
          seen.push(frame)
          if (done(frame)) return frame
          continue
        }
        if (Date.now() > deadline) throw new Error(`timed out; frames so far: ${JSON.stringify(seen)}`)
        const next = await Promise.race([reader.read(), Bun.sleep(500).then(() => null)])
        if (next === null) continue
        if (next.done) throw new Error('the stream ended')
        buffer += decoder.decode(next.value, { stream: true })
      }
    },
    close: () => reader.cancel(),
  }
}
