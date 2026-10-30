import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT } from '../src/exit.ts'

const BIN = join(import.meta.dir, '..', 'bin', 'factory.ts')

const ROLE = { role: 'worker', tier: 'sonnet', effort: 'high', hold: null } as const
const SPAWNS = [
  { key: 'b', status: 'started', account: 'a', resumeAt: null, attempts: 1, session: 'pane-b', error: null, ...ROLE },
  {
    ...ROLE,
    key: 'a',
    status: 'waiting',
    account: null,
    resumeAt: '2026-10-30T14:00:00.000Z',
    attempts: 0,
    session: null,
    error: null,
  },
]

const SESSION = {
  id: 'sess-1',
  state: 'working',
  wait: null,
  turn: 3,
  lastEventAt: '2026-10-30T12:00:00.000Z',
  spawn: 'sess-1',
  pane: 'w1:p1',
  claudeSessionId: 'c-1',
  transcriptPath: '/t/c-1.jsonl',
  cwd: '/w',
  herdrStatus: 'working',
  herdrSeenAt: '2026-10-30T12:00:00.000Z',
}
const QUOTA = {
  account: 'me',
  enabled: true,
  authOk: true,
  fiveHourUsed: 23,
  weeklyUsed: 45,
  fiveHourResetsAt: '2026-10-30T16:40:00.000Z',
  weeklyResetsAt: '2026-11-05T06:00:00.000Z',
  exhaustedUntil: null,
  sampledAt: '2026-10-30T14:00:00.000Z',
  readAt: '2026-10-30T14:01:00.000Z',
  fresh: true,
}
const queueCalls: { method: string; project: string | null; state?: string }[] = []
const DEAD = { ...SESSION, id: 'old', state: 'dead', pane: null }
const sessionCalls: { id: string; body: unknown }[] = []

let fake: ReturnType<typeof Bun.serve>
let sock: ReturnType<typeof Bun.serve>
let sockDir: string
const SOCKET = () => join(sockDir, 's.sock')
let status = 200
let odd = ''
const TOKEN = 'cli-test-token-0123456789'

beforeAll(() => {
  // The server's unix socket: what a session in a pane reaches, with no token.
  sockDir = mkdtempSync('/tmp/factory-cli-')
  sock = Bun.serve({
    unix: SOCKET(),
    fetch: async (req) => {
      const [, , id, sub] = new URL(req.url).pathname.split('/')
      if (sub !== 'wait' || req.method !== 'POST' || !id) return Response.json({ error: 'not found' }, { status: 404 })
      sessionCalls.push({ id, body: await req.json() })
      return Response.json({ ...SESSION, id })
    },
  })
  fake = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url)
      const path = url.pathname
      if (odd === 'null') return Response.json(null)
      if (odd === 'proxy-503') return new Response('upstream down', { status: 503 })
      if (odd === 'old-health' && path === '/health') return Response.json({ status: 'ok', version: 'abc123' })
      if (odd === 'empty' && path === '/spawns') return Response.json({ spawns: [] })
      if (odd === 'drift' && (path === '/spawns' || path.endsWith('/requeue')))
        return Response.json({ spawns: [{ key: 1 }], key: 1 })
      if (path === '/health') {
        const health = (state: 'ok' | 'unhealthy') => ({
          status: state,
          version: 'abc123',
          reason: state === 'ok' ? null : 'no successful tick for 20s (limit 15s)',
          tick: { lastSuccessAt: '2026-10-30T12:00:00.000Z', lastError: null },
        })
        if (status === 200) return Response.json(health('ok'))
        if (status === 503) return Response.json(health('unhealthy'), { status })
        return Response.json({ error: 'database down' }, { status })
      }
      if (path.startsWith('/spawns/') && path.endsWith('/requeue') && req.method === 'POST') {
        if (req.headers.get('authorization') !== `Bearer ${TOKEN}`)
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        const key = decodeURIComponent(path.split('/')[2] ?? '')
        if (key === 'running')
          return Response.json({ error: 'spawn is started; only a failed spawn can be re-queued' }, { status: 409 })
        if (key === 'unknown') return Response.json({ error: 'unknown spawn' }, { status: 404 })
        return Response.json({
          key,
          status: 'queued',
          account: 'a',
          resumeAt: null,
          attempts: 0,
          session: null,
          error: null,
          ...ROLE,
        })
      }
      if (path === '/queue') {
        if (req.headers.get('authorization') !== `Bearer ${TOKEN}`)
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        const body = req.method === 'PUT' ? ((await req.json()) as { state: string; project?: string }) : undefined
        queueCalls.push({
          method: req.method,
          project: body?.project ?? url.searchParams.get('project'),
          state: body?.state,
        })
        const project = body ? (body.project ?? null) : url.searchParams.get('project')
        const state = body?.state ?? 'pace'
        return Response.json({
          scope: { project },
          state,
          effective: state === 'run' ? 'run' : 'drain',
          setAt: '2026-10-30T12:00:00.000Z',
          scopes: [{ project: null, state: 'drain', setAt: '2026-10-30T11:00:00.000Z' }],
        })
      }
      if (path === '/quota' || path === '/quota/refresh') {
        if (req.headers.get('authorization') !== `Bearer ${TOKEN}`)
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        return Response.json({ quota: [QUOTA], refreshed: path.endsWith('refresh') && req.method === 'POST' })
      }
      if (path.startsWith('/sessions')) {
        if (req.headers.get('authorization') !== `Bearer ${TOKEN}`)
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        if (odd === 'drift') return Response.json({ sessions: [{ id: 1 }], id: 1 })
        const [, , id] = path.split('/')
        if (!id) return Response.json({ sessions: url.searchParams.get('all') ? [SESSION, DEAD] : [SESSION] })
        if (id === 'nope') return Response.json({ error: 'unknown session' }, { status: 404 })
        return Response.json({ ...SESSION, id })
      }
      if (path === '/spawns') {
        if (req.headers.get('authorization') !== `Bearer ${TOKEN}`)
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        return Response.json({ spawns: SPAWNS })
      }
      return Response.json({ error: 'not found' }, { status: 404 })
    },
  })
})
afterAll(() => {
  fake.stop(true)
  sock.stop(true)
  rmSync(sockDir, { recursive: true, force: true })
})

/** The binary as a caller runs it: a process, its stdout, its stderr, its exit code. */
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

describe('factory version', () => {
  test('prints one JSON line on stdout and needs no server', async () => {
    const r = await factory(['version'], { FACTORY_URL: 'http://127.0.0.1:1' })
    expect(r).toMatchObject({ code: EXIT.ok, stderr: '' })
    expect(JSON.parse(r.stdout)).toEqual({ version: '0.0.0' })
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
  })

  test('--format plain is the bare value', async () => {
    expect((await factory(['--format', 'plain', 'version'])).stdout).toBe('0.0.0\n')
    expect((await factory(['version', '--format=plain'])).stdout).toBe('0.0.0\n')
  })
})

describe('factory health', () => {
  test('prints the server answer', async () => {
    const r = await factory(['health'])
    expect(r).toMatchObject({ code: EXIT.ok, stderr: '' })
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'ok', version: 'abc123', reason: null })
  })

  test('plain', async () => {
    expect((await factory(['health', '--format', 'plain'])).stdout).toBe('ok\tabc123\n')
  })

  test('an unreachable server is a network error: one JSON line on stderr, nothing on stdout', async () => {
    const r = await factory(['health'], { FACTORY_URL: 'http://127.0.0.1:1' })
    expect(r).toMatchObject({ code: EXIT.network, stdout: '' })
    expect(JSON.parse(r.stderr)).toMatchObject({ error: { kind: 'network' } })
    expect(r.stderr.trim().split('\n')).toHaveLength(1)
  })

  test('a 5xx is general', async () => {
    status = 500
    try {
      const r = await factory(['health'])
      expect(r.code).toBe(EXIT.general)
      expect(JSON.parse(r.stderr)).toMatchObject({
        error: { kind: 'general', message: 'database down', details: { status: 500 } },
      })
    } finally {
      status = 200
    }
  })

  test('an unhealthy server (503 with the health body) is general, and says why; the body is still printed', async () => {
    status = 503
    try {
      const r = await factory(['health'])
      expect(r.code).toBe(EXIT.general)
      expect(JSON.parse(r.stdout)).toMatchObject({
        status: 'unhealthy',
        reason: 'no successful tick for 20s (limit 15s)',
      })
      expect(JSON.parse(r.stderr)).toMatchObject({
        error: { kind: 'general', message: 'server is not ok: unhealthy (no successful tick for 20s (limit 15s))' },
      })
    } finally {
      status = 200
    }
  })

  test('a 503 that is not a health body is an outage (general), not a drifted contract', async () => {
    odd = 'proxy-503'
    try {
      const r = await factory(['health'])
      expect(r.code).toBe(EXIT.general)
      expect(JSON.parse(r.stderr)).toMatchObject({ error: { kind: 'general', details: { status: 503 } } })
    } finally {
      odd = ''
    }
  })

  test('a 404 is not_found, a 401 is auth', async () => {
    status = 404
    expect((await factory(['health'])).code).toBe(EXIT.not_found)
    status = 401
    expect((await factory(['health'])).code).toBe(EXIT.auth)
    status = 200
  })
})

describe('factory spawn list', () => {
  test('json', async () => {
    const r = await factory(['spawn', 'list'])
    expect(r).toMatchObject({ code: EXIT.ok, stderr: '' })
    expect(JSON.parse(r.stdout)).toEqual({ spawns: SPAWNS })
  })

  test('plain is one tab-separated line per spawn', async () => {
    const r = await factory(['spawn', 'list', '--format', 'plain'])
    expect(r.stdout).toBe(
      'b\tstarted\ta\t-\t1\tpane-b\tworker\t-\na\twaiting\t-\t2026-10-30T14:00:00.000Z\t0\t-\tworker\t-\n',
    )
  })
})

describe('factory spawn requeue', () => {
  test('prints the re-queued spawn', async () => {
    const r = await factory(['spawn', 'requeue', 'flaky'])
    expect(r).toMatchObject({ code: EXIT.ok, stderr: '' })
    expect(JSON.parse(r.stdout)).toMatchObject({ key: 'flaky', status: 'queued', attempts: 0 })
    expect((await factory(['spawn', 'requeue', 'flaky', '--format', 'plain'])).stdout).toBe(
      'flaky\tqueued\ta\t-\t0\t-\tworker\t-\n',
    )
  })

  test('a spawn that is not failed is conflict (5), an unknown one not_found (4)', async () => {
    const conflict = await factory(['spawn', 'requeue', 'running'])
    expect(conflict).toMatchObject({ code: EXIT.conflict, stdout: '' })
    expect(JSON.parse(conflict.stderr)).toMatchObject({
      error: { kind: 'conflict', message: expect.stringContaining('only a failed spawn') },
    })
    expect((await factory(['spawn', 'requeue', 'unknown'])).code).toBe(EXIT.not_found)
  })

  test('needs a key, and the token', async () => {
    expect((await factory(['spawn', 'requeue'])).code).toBe(EXIT.usage)
    expect((await factory(['spawn', 'requeue', 'a', 'b'])).code).toBe(EXIT.usage)
    expect((await factory(['spawn', 'requeue', 'x'], { FACTORY_TOKEN: '' })).code).toBe(EXIT.auth)
  })
})

describe('usage errors', () => {
  test.each([
    [['frobnicate']],
    [['spawn']],
    [['spawn', 'list', '--nope']],
    [['--format', 'yaml', 'version']],
    [['--format']],
  ])('%p exits 2 with one JSON line on stderr and nothing on stdout', async (args) => {
    const r = await factory(args)
    expect(r).toMatchObject({ code: EXIT.usage, stdout: '' })
    expect(JSON.parse(r.stderr)).toMatchObject({ error: { kind: 'usage' } })
  })

  test('--help and no command print help on stdout, exit 0', async () => {
    for (const args of [['--help'], []]) {
      const r = await factory(args)
      expect(r).toMatchObject({ code: EXIT.ok, stderr: '' })
      expect(r.stdout).toContain('usage: factory')
    }
  })
})

describe('factory session', () => {
  test('list prints the sessions with their derived state; --all asks for the dead too', async () => {
    const r = await factory(['session', 'list'])
    expect(r).toMatchObject({ code: EXIT.ok, stderr: '' })
    expect(JSON.parse(r.stdout).sessions.map((s: { id: string }) => s.id)).toEqual(['sess-1'])
    expect(JSON.parse((await factory(['session', 'list', '--all'])).stdout).sessions).toHaveLength(2)
    expect((await factory(['session', 'list', '--format', 'plain'])).stdout).toBe(
      'sess-1\tworking\t-\t3\tw1:p1\tc-1\t2026-10-30T12:00:00.000Z\n',
    )
  })

  test('get prints one session; an unknown one is 4', async () => {
    expect(JSON.parse((await factory(['session', 'get', 'sess-1'])).stdout)).toMatchObject({ id: 'sess-1', turn: 3 })
    expect((await factory(['session', 'get', 'nope'])).code).toBe(EXIT.not_found)
    expect((await factory(['session', 'get'])).code).toBe(EXIT.usage)
  })

  // A session in a pane has FACTORY_SESSION and the socket, and no token.
  const pane = () => ({ FACTORY_TOKEN: '', FACTORY_URL: 'http://127.0.0.1:1', FACTORY_SOCKET: SOCKET() })

  test('wait --on declares a wait for $FACTORY_SESSION, --done ends it: through the socket, without a token', async () => {
    sessionCalls.length = 0
    expect((await factory(['session', 'wait', '--on', 'workers'], { ...pane(), FACTORY_SESSION: 'mine' })).code).toBe(
      EXIT.ok,
    )
    expect((await factory(['session', 'wait', '--done', '--session', 'other'], pane())).code).toBe(EXIT.ok)
    expect(sessionCalls).toEqual([
      { id: 'mine', body: { on: 'workers' } },
      { id: 'other', body: { done: true } },
    ])
  })

  test.each([
    [['session', 'wait']],
    [['session', 'wait', '--on', 'friday']],
    [['session', 'wait', '--on', 'deploy', '--done']],
  ])('%p is a usage error and sends nothing', async (args) => {
    sessionCalls.length = 0
    const r = await factory(args, { ...pane(), FACTORY_SESSION: 'mine' })
    expect(r).toMatchObject({ code: EXIT.usage, stdout: '' })
    expect(sessionCalls).toEqual([])
  })

  test('wait without a session to name is a usage error', async () => {
    expect((await factory(['session', 'wait', '--on', 'owner'], { ...pane(), FACTORY_SESSION: '' })).code).toBe(
      EXIT.usage,
    )
    // And a socket nobody listens on is a network error.
    const r = await factory(['session', 'wait', '--on', 'owner'], {
      ...pane(),
      FACTORY_SESSION: 's',
      FACTORY_SOCKET: '/tmp/nobody-listens.sock',
    })
    expect(r.code).toBe(EXIT.network)
  })

  test('a body that drifted from the contract is exit 9', async () => {
    odd = 'drift'
    try {
      expect((await factory(['session', 'list'])).code).toBe(EXIT.contract_mismatch)
    } finally {
      odd = ''
    }
  })
})

describe('the exit-code table', () => {
  test("is agw's, unchanged", () => {
    expect(EXIT).toEqual({
      ok: 0,
      general: 1,
      usage: 2,
      auth: 3,
      not_found: 4,
      conflict: 5,
      confirmation_required: 6,
      network: 7,
      rate_limited: 8,
      contract_mismatch: 9,
      pending: 10,
    })
  })
})

describe('answers that are not the contract', () => {
  test('a non-object /health body is contract_mismatch (9)', async () => {
    odd = 'null'
    try {
      const r = await factory(['health'])
      expect(r).toMatchObject({ code: EXIT.contract_mismatch, stdout: '' })
      expect(JSON.parse(r.stderr)).toMatchObject({ error: { kind: 'contract_mismatch' } })
    } finally {
      odd = ''
    }
  })

  test.each([
    ['spawn', 'list'],
    ['spawn', 'requeue', 'flaky'],
  ])('a body that drifted from the contract on %p is exit 9', async (...args) => {
    odd = 'drift'
    try {
      const r = await factory(args.flat() as string[])
      expect(r).toMatchObject({ code: EXIT.contract_mismatch, stdout: '' })
      expect(JSON.parse(r.stderr)).toMatchObject({
        error: { kind: 'contract_mismatch', hint: 'the server and the CLI are from different releases' },
      })
    } finally {
      odd = ''
    }
  })

  test('a health body from an older release (no tick record) is exit 9', async () => {
    odd = 'old-health'
    try {
      expect((await factory(['health'])).code).toBe(EXIT.contract_mismatch)
    } finally {
      odd = ''
    }
  })

  test('an empty queue prints nothing in plain', async () => {
    odd = 'empty'
    try {
      expect(await factory(['spawn', 'list', '--format', 'plain'])).toMatchObject({ stdout: '', code: EXIT.ok })
      expect(JSON.parse((await factory(['spawn', 'list'])).stdout)).toEqual({ spawns: [] })
    } finally {
      odd = ''
    }
  })
})

describe('the token', () => {
  test('spawn list without FACTORY_TOKEN is auth (3) and never contacts the server', async () => {
    const r = await factory(['spawn', 'list'], { FACTORY_TOKEN: '', FACTORY_URL: 'http://127.0.0.1:1' })
    expect(r).toMatchObject({ code: EXIT.auth, stdout: '' })
    expect(JSON.parse(r.stderr)).toMatchObject({ error: { kind: 'auth', message: 'no FACTORY_TOKEN set' } })
  })

  test('a token the server refuses is auth (3)', async () => {
    const r = await factory(['spawn', 'list'], { FACTORY_TOKEN: 'another-token-0123456789' })
    expect(r.code).toBe(EXIT.auth)
    expect(JSON.parse(r.stderr)).toMatchObject({ error: { kind: 'auth', details: { status: 401 } } })
  })

  test('health and version do not need one', async () => {
    expect((await factory(['health'], { FACTORY_TOKEN: '' })).code).toBe(EXIT.ok)
    expect((await factory(['version'], { FACTORY_TOKEN: '' })).code).toBe(EXIT.ok)
  })
})

describe('factory role', () => {
  // This is the interface rd reads: exactly these three fields, no server, no token.
  test('get prints {role, tier, effort} and needs neither server nor token', async () => {
    const r = await factory(['role', 'get', 'worker', '--format', 'json'], {
      FACTORY_URL: 'http://127.0.0.1:1',
      FACTORY_TOKEN: '',
    })
    expect(r).toMatchObject({ code: EXIT.ok, stderr: '' })
    expect(r.stdout).toBe('{"role":"worker","tier":"sonnet","effort":"high"}\n')
  })

  test('plain is tier and effort on one tab-separated line with the role', async () => {
    const r = await factory(['role', 'get', 'lead', '--format', 'plain'])
    expect(r.stdout).toBe('lead\topus\thigh\n')
  })

  test('list prints every role of the table', async () => {
    const r = await factory(['role', 'list'])
    expect(r.code).toBe(EXIT.ok)
    const { roles } = JSON.parse(r.stdout) as { roles: { role: string; tier: string; effort: string }[] }
    expect(roles.map((x) => x.role)).toEqual([
      'mother',
      'lead',
      'wave',
      'worker',
      'mechanical',
      'implementer',
      'verifier',
      'Explore',
    ])
  })

  test('an unknown role is not_found (4) with the roles named', async () => {
    const r = await factory(['role', 'get', 'nobody'])
    expect(r).toMatchObject({ code: EXIT.not_found, stdout: '' })
    expect(r.stderr).toContain('unknown role nobody')
  })

  // rd branches on this: an unknown role is a usage error to report, not a failure to ignore.
  test('an unknown role answers error.kind not_found on stderr, nothing on stdout, whatever the format', async () => {
    for (const format of ['json', 'plain']) {
      const r = await factory(['role', 'get', 'nobody', '--format', format])
      expect(r).toMatchObject({ code: 4, stdout: '' })
      expect(r.code).toBe(EXIT.not_found)
      expect(JSON.parse(r.stderr).error.kind).toBe('not_found')
    }
  })

  test('FACTORY_ROLES_FILE points at another table; an unusable one is a failure', async () => {
    const dir = mkdtempSync('/tmp/factory-roles-')
    try {
      const good = join(dir, 'roles.json')
      await Bun.write(good, JSON.stringify({ roles: { solo: { tier: 'haiku', effort: 'max' } } }))
      const r = await factory(['role', 'get', 'solo'], { FACTORY_ROLES_FILE: good })
      expect(JSON.parse(r.stdout)).toEqual({ role: 'solo', tier: 'haiku', effort: 'max' })

      const bad = join(dir, 'bad.json')
      await Bun.write(bad, JSON.stringify({ roles: { solo: { tier: 'gpt-9000', effort: 'max' } } }))
      expect(await factory(['role', 'get', 'solo'], { FACTORY_ROLES_FILE: bad })).toMatchObject({ code: EXIT.general })
      expect(await factory(['role', 'get', 'solo'], { FACTORY_ROLES_FILE: join(dir, 'missing.json') })).toMatchObject({
        code: EXIT.general,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a usage mistake is exit 2', async () => {
    expect((await factory(['role', 'get'])).code).toBe(EXIT.usage)
    expect((await factory(['role'])).code).toBe(EXIT.usage)
  })
})

describe('factory queue', () => {
  test('get without a project asks for the global scope', async () => {
    queueCalls.length = 0
    const r = await factory(['queue', 'get'])
    expect(r.code).toBe(EXIT.ok)
    expect(JSON.parse(r.stdout)).toMatchObject({ scope: { project: null }, state: 'pace', effective: 'drain' })
    expect(queueCalls).toEqual([{ method: 'GET', project: null, state: undefined }])
  })

  test('get --project sends the absolute path', async () => {
    queueCalls.length = 0
    await factory(['queue', 'get', '--project', '/work/repo', '--format', 'plain'])
    expect(queueCalls).toEqual([{ method: 'GET', project: '/work/repo', state: undefined }])
  })

  test('set sends the state, and the project when given; a relative path is made absolute', async () => {
    queueCalls.length = 0
    const r = await factory(['queue', 'set', 'drain', '--project', '/work/repo', '--format', 'plain'])
    expect(r.stdout).toBe('/work/repo\tdrain\tdrain\t2026-10-30T12:00:00.000Z\n')
    await factory(['queue', 'set', 'run'])
    expect(queueCalls).toEqual([
      { method: 'PUT', project: '/work/repo', state: 'drain' },
      { method: 'PUT', project: null, state: 'run' },
    ])
  })

  test('a state that is not run, pace or drain is exit 2 and sends nothing', async () => {
    queueCalls.length = 0
    expect((await factory(['queue', 'set', 'pause'])).code).toBe(EXIT.usage)
    expect((await factory(['queue', 'set'])).code).toBe(EXIT.usage)
    expect(queueCalls).toEqual([])
  })

  test('it needs the token', async () => {
    expect((await factory(['queue', 'get'], { FACTORY_TOKEN: '' })).code).toBe(EXIT.auth)
  })
})

describe('factory quota', () => {
  test('get prints the readings', async () => {
    const r = await factory(['quota', 'get', '--format', 'plain'])
    expect(r.stdout).toBe('me\t23\t45\t2026-10-30T16:40:00.000Z\t2026-11-05T06:00:00.000Z\tfresh\tauth ok\n')
  })

  test('refresh asks the server to read the picker now', async () => {
    const r = await factory(['quota', 'refresh'])
    expect(r.code).toBe(EXIT.ok)
    expect(JSON.parse(r.stdout).quota).toHaveLength(1)
  })
})
