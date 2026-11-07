import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Health } from '@software-factory/contract'
import * as z from 'zod'
import { FactoryError } from '../src/exit.ts'
import { type Operation, runOperation } from '../src/operation.ts'
import { run } from '../src/run.ts'

const healthy: Health = {
  status: 'ok',
  version: 'dev',
  reason: null,
  heartbeat: { ok: true, reason: null, tickAt: null, queueMovedAt: null },
}

let server: ReturnType<typeof Bun.serve>
let dir: string
let answer: { status: number; body: unknown } = { status: 200, body: healthy }
let seen: { url: string; method: string; body: string } | undefined

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-cli-')
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      seen = { url: request.url, method: request.method, body: await request.text() }
      return Response.json(answer.body, { status: answer.status })
    },
  })
})

afterAll(async () => {
  await server.stop(true)
  await rm(dir, { recursive: true, force: true })
})

async function cli(argv: string[], env: Record<string, string> = {}) {
  let out = ''
  let err = ''
  const code = await run(argv, {
    env: { FACTORY_URL: server.url.href, ...env },
    out: (text) => {
      out += text
    },
    err: (text) => {
      err += text
    },
  })
  return { code, out, err }
}

const errorOf = (text: string) =>
  z.object({ error: z.object({ kind: z.string(), message: z.string() }) }).parse(JSON.parse(text)).error

describe('hand-written verbs', () => {
  test('version prints {"version"} in json and the bare version in plain', async () => {
    expect(await cli(['version'])).toEqual({ code: 0, out: '{"version":"0.0.0"}\n', err: '' })
    expect(await cli(['version', '--format', 'plain'])).toEqual({ code: 0, out: '0.0.0\n', err: '' })
  })

  test('role get prints exactly {"role","tier","effort"}; role list the table', async () => {
    const file = join(dir, 'roles.json')
    await writeFile(file, JSON.stringify({ roles: { lead: { tier: 'opus', effort: 'max' } } }))
    const env = { FACTORY_ROLES_FILE: file }
    expect(await cli(['role', 'get', 'lead'], env)).toEqual({
      code: 0,
      out: '{"role":"lead","tier":"opus","effort":"max"}\n',
      err: '',
    })
    expect((await cli(['role', 'list', '--format', 'plain'], env)).out).toBe('lead\topus\tmax\n')
  })

  test("the tracked table's lead is read without FACTORY_ROLES_FILE", async () => {
    const result = await cli(['role', 'get', 'lead'])
    expect(result.code).toBe(0)
    expect(Object.keys(JSON.parse(result.out))).toEqual(['role', 'tier', 'effort'])
  })

  test('an unknown role is exit 4, an unusable table exit 1', async () => {
    const unknown = await cli(['role', 'get', 'nobody'])
    expect(unknown.code).toBe(4)
    expect(errorOf(unknown.err).kind).toBe('not_found')
    expect((await cli(['role', 'list'], { FACTORY_ROLES_FILE: join(dir, 'missing.json') })).code).toBe(1)
  })

  test('an unknown command, flag or format is exit 2 with nothing on stdout', async () => {
    for (const argv of [['bogus'], ['version', '--nope'], ['version', '--format', 'xml'], ['role', 'get']]) {
      const result = await cli(argv)
      expect(result.code).toBe(2)
      expect(result.out).toBe('')
      expect(errorOf(result.err).kind).toBe('usage')
    }
  })

  test('--help lists the generated commands', async () => {
    expect((await cli(['--help'])).out).toContain('health get')
  })
})

describe('a generated command', () => {
  test('health get prints the body that parses with the contract', async () => {
    answer = { status: 200, body: healthy }
    expect(await cli(['health', 'get'])).toEqual({ code: 0, out: `${JSON.stringify(healthy)}\n`, err: '' })
    expect((await cli(['health', 'get', '--format', 'plain'])).out).toBe(
      'status\tok\nversion\tdev\nreason\t-\nheartbeat.ok\ttrue\nheartbeat.reason\t-\nheartbeat.tickAt\t-\nheartbeat.queueMovedAt\t-\n',
    )
  })

  test('a 2xx body the contract refuses is exit 9', async () => {
    answer = { status: 200, body: { status: 'fine' } }
    const result = await cli(['health', 'get'])
    expect(result.code).toBe(9)
    expect(result.out).toBe('')
    expect(errorOf(result.err).kind).toBe('contract_mismatch')
  })

  test('a declared 503 prints its body and exits 1', async () => {
    const down = { ...healthy, status: 'unhealthy', reason: 'db', heartbeat: { ...healthy.heartbeat, ok: false } }
    answer = { status: 503, body: down }
    const result = await cli(['health', 'get'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.out)).toEqual(down)
  })

  test("an undeclared status is its kind with the server's ErrorBody message", async () => {
    answer = { status: 404, body: { error: 'no such route', code: 'not_found' } }
    const result = await cli(['health', 'get'])
    expect(result.code).toBe(4)
    expect(errorOf(result.err).message).toBe('no such route')
  })

  test('an unreachable server is exit 7', async () => {
    const result = await cli(['health', 'get'], { FACTORY_URL: 'http://127.0.0.1:9' })
    expect(result.code).toBe(7)
  })
})

describe('runOperation', () => {
  const Echo = z.object({ ok: z.boolean() })
  const op: Operation = {
    operationId: 'issue.note',
    command: ['issue', 'note'],
    method: 'POST',
    path: '/issues/{id}/notes',
    summary: '',
    pathParams: ['id'],
    queryParams: ['wake'],
    body: true,
    responses: { 200: Echo },
  }
  const io = (out: string[]) => ({
    env: { FACTORY_URL: server.url.href },
    out: (t: string) => void out.push(t),
    err: () => {},
  })

  test('path parameters are positionals, query parameters flags, the body --body JSON', async () => {
    answer = { status: 200, body: { ok: true } }
    const out: string[] = []
    await runOperation(op, { args: ['a b'], flags: { wake: 'yes', body: '{"text":"hi"}' }, format: 'json' }, io(out))
    expect(out).toEqual(['{"ok":true}\n'])
    expect(seen).toEqual({
      url: `${server.url.href}issues/a%20b/notes?wake=yes`,
      method: 'POST',
      body: '{"text":"hi"}',
    })
  })

  test('a missing positional or body, or a body that is not JSON, is a usage error before any call', async () => {
    for (const invocation of [
      { args: [], flags: { body: '{}' } },
      { args: ['1'], flags: {} },
      { args: ['1'], flags: { body: '{' } },
    ]) {
      const kind = await runOperation(op, { ...invocation, format: 'json' }, io([])).then(
        () => 'resolved',
        (error: unknown) => (error instanceof FactoryError ? error.kind : 'other'),
      )
      expect(kind).toBe('usage')
    }
  })
})
