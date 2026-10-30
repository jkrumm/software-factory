import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { EXIT } from '../src/exit.ts'

const BIN = join(import.meta.dir, '..', 'bin', 'factory.ts')

const SPAWNS = [
  { key: 'b', status: 'started', account: 'a', resumeAt: null, attempts: 1, session: 'pane-b', error: null },
  {
    key: 'a',
    status: 'waiting',
    account: null,
    resumeAt: '2026-10-30T14:00:00.000Z',
    attempts: 0,
    session: null,
    error: null,
  },
]

let fake: ReturnType<typeof Bun.serve>
let status = 200
let odd = ''

beforeAll(() => {
  fake = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const path = new URL(req.url).pathname
      if (odd === 'null') return Response.json(null)
      if (odd === 'empty' && path === '/spawns') return Response.json({ spawns: [] })
      if (path === '/health') {
        return status === 200
          ? Response.json({ status: 'ok', version: 'abc123' })
          : Response.json({ error: 'database down' }, { status })
      }
      if (path === '/spawns') return Response.json({ spawns: SPAWNS })
      return Response.json({ error: 'not found' }, { status: 404 })
    },
  })
})
afterAll(() => fake.stop(true))

/** The binary as a caller runs it: a process, its stdout, its stderr, its exit code. */
async function factory(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    env: { ...process.env, FACTORY_URL: String(fake.url), ...env },
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
    expect(JSON.parse(r.stdout)).toEqual({ status: 'ok', version: 'abc123' })
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
    status = 503
    try {
      const r = await factory(['health'])
      expect(r.code).toBe(EXIT.general)
      expect(JSON.parse(r.stderr)).toMatchObject({
        error: { kind: 'general', message: 'database down', details: { status: 503 } },
      })
    } finally {
      status = 200
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
    expect(r.stdout).toBe('b\tstarted\ta\t-\t1\tpane-b\na\twaiting\t-\t2026-10-30T14:00:00.000Z\t0\t-\n')
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
