import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Health } from '@software-factory/contract'
import * as z from 'zod'
import { FactoryError } from '../src/exit.ts'
import { type BodyField, LONG_OPERATION_TIMEOUT_MS, type Operation, runOperation, timeoutOf } from '../src/operation.ts'
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
const stdinText = ''
let seen: { url: string; method: string; body: string; authorization: string | null } | undefined

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-cli-')
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      seen = {
        url: request.url,
        method: request.method,
        body: await request.text(),
        authorization: request.headers.get('authorization'),
      }
      return Response.json(answer.body, { status: answer.status })
    },
  })
})

afterAll(async () => {
  await server.stop(true)
  await rm(dir, { recursive: true, force: true })
})

const files = {
  stdin: () => Promise.resolve(stdinText),
  readFile: (path: string) => Bun.file(path).text(),
}

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
    ...files,
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

  // The one failure with data on stdout: the Uptime pusher and verify.sh read the Health body of a 503.
  test('a 503 health prints its Health body on stdout, the error line on stderr, and exits 1', async () => {
    const down = { ...healthy, status: 'unhealthy', reason: 'db', heartbeat: { ...healthy.heartbeat, ok: false } }
    answer = { status: 503, body: down }
    const result = await cli(['health', 'get'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.out)).toEqual(down)
    expect(errorOf(result.err).kind).toBe('general')
  })

  test('a declared ErrorBody is stderr only: code, message and details {status, ...details}', async () => {
    answer = {
      status: 422,
      body: {
        error: 'a Decision needs: recommendation',
        code: 'missing_field',
        details: { fields: ['recommendation'] },
      },
    }
    const result = await cli(['issue', 'ask', 'issue_1', '--attempt', '1'])
    expect(result.code).toBe(2)
    expect(result.out).toBe('')
    expect(JSON.parse(result.err)).toEqual({
      error: {
        kind: 'usage',
        code: 'missing_field',
        message: 'a Decision needs: recommendation',
        hint: '',
        details: { status: 422, fields: ['recommendation'] },
      },
    })
  })

  test("an undeclared status is its kind with the server's ErrorBody message", async () => {
    answer = { status: 404, body: { error: 'no such route', code: 'not_found' } }
    const result = await cli(['health', 'get'])
    expect(result.code).toBe(4)
    expect(result.out).toBe('')
    expect(errorOf(result.err).message).toBe('no such route')
  })

  test('a 401 is exit 3 with a hint to set the token', async () => {
    answer = { status: 401, body: { error: 'a bearer token is required', code: 'unauthorized' } }
    const result = await cli(['health', 'get'])
    expect(result.code).toBe(3)
    expect(JSON.parse(result.err).error).toMatchObject({ kind: 'auth', code: 'unauthorized', details: { status: 401 } })
    expect(JSON.parse(result.err).error.hint).toContain('FACTORY_TOKEN')
  })

  test('the bearer is FACTORY_TOKEN, else FACTORY_READ_TOKEN, else nothing', async () => {
    answer = { status: 200, body: healthy }
    await cli(['health', 'get'], { FACTORY_TOKEN: 'owner-t', FACTORY_READ_TOKEN: 'read-t' })
    expect(seen?.authorization).toBe('Bearer owner-t')
    await cli(['health', 'get'], { FACTORY_READ_TOKEN: 'read-t' })
    expect(seen?.authorization).toBe('Bearer read-t')
    await cli(['health', 'get'])
    expect(seen?.authorization).toBeNull()
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
    queryFlags: [],
    body: true,
    bodyFields: [],
    args: [],
    responses: { 200: Echo },
  }
  const io = (out: string[]) => ({
    env: { FACTORY_URL: server.url.href },
    out: (t: string) => void out.push(t),
    err: () => {},
    ...files,
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
      authorization: null,
    })
  })

  test('the ship and a loop pass wait past the transport default; the rest keep it', () => {
    const named = (operationId: string): Operation => ({ ...op, operationId })
    expect(timeoutOf(named('issue.ship'))).toBe(LONG_OPERATION_TIMEOUT_MS)
    expect(timeoutOf(named('loop.run'))).toBe(LONG_OPERATION_TIMEOUT_MS)
    expect(timeoutOf(named('issue.note'))).toBeUndefined()
  })

  test('a missing positional or body, or a body that is not JSON, is a usage error before any call', async () => {
    for (const invocation of [
      { args: [], flags: { body: '{}' } },
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

describe('body flags', () => {
  const Echo = z.object({ ok: z.boolean() })
  const field = (name: string, kind: BodyField['kind'], over: Partial<BodyField> = {}): BodyField => ({
    name,
    flag: name,
    kind,
    repeatable: false,
    required: false,
    untyped: false,
    ...over,
  })
  const op: Operation = {
    operationId: 'thing.make',
    command: ['thing', 'make'],
    method: 'POST',
    path: '/things/{id}',
    summary: '',
    pathParams: ['id'],
    queryParams: [],
    queryFlags: [],
    body: true,
    args: [],
    bodyFields: [
      field('text', 'string'),
      field('count', 'number'),
      field('attempt', 'integer'),
      field('urgent', 'boolean'),
      field('commit', 'string', { repeatable: true }),
      field('sizes', 'number', { repeatable: true }),
      field('options', 'json'),
      field('question', 'json', { untyped: true }),
    ],
    responses: { 200: Echo },
  }
  const io = { env: { FACTORY_URL: '' }, out: () => {}, err: () => {}, ...files }
  const call = async (flags: Record<string, string | boolean | string[]>) => {
    answer = { status: 200, body: { ok: true } }
    await runOperation(op, { args: ['t1'], flags, format: 'json' }, { ...io, env: { FACTORY_URL: server.url.href } })
    return JSON.parse(seen?.body ?? 'null')
  }
  const refused = (flags: Record<string, string | boolean | string[]>) =>
    call(flags).then(
      () => 'resolved',
      (error: unknown) => (error instanceof FactoryError ? error.kind : 'other'),
    )

  test('each kind maps to its JSON type', async () => {
    expect(
      await call({
        text: 'hi',
        count: '1.5',
        attempt: '3',
        urgent: 'true',
        commit: ['a', 'b'],
        sizes: ['1', '2'],
        options: '[{"label":"x"}]',
      }),
    ).toEqual({
      text: 'hi',
      count: 1.5,
      attempt: 3,
      urgent: true,
      commit: ['a', 'b'],
      sizes: [1, 2],
      options: [{ label: 'x' }],
    })
  })

  test('a repeatable flag given once is a list of one', async () => {
    expect(await call({ commit: 'a' })).toEqual({ commit: ['a'] })
  })

  test('an untyped property is JSON only when it is an object or an array, else the text', async () => {
    expect(await call({ question: 'Which db?' })).toEqual({ question: 'Which db?' })
    expect(await call({ question: '123' })).toEqual({ question: '123' })
    expect(await call({ question: 'true' })).toEqual({ question: 'true' })
    expect(await call({ question: '{"a":1}' })).toEqual({ question: { a: 1 } })
    expect(await call({ question: '["x"]' })).toEqual({ question: ['x'] })
    expect(await call({ question: '{broken' })).toEqual({ question: '{broken' })
  })

  test('an object or array property must be JSON, a number must be a number', async () => {
    expect(await refused({ options: 'not json' })).toBe('usage')
    expect(await refused({ count: 'many' })).toBe('usage')
    expect(await refused({ attempt: '1.5' })).toBe('usage')
    expect(await refused({ urgent: 'maybe' })).toBe('usage')
    expect(await refused({ sizes: ['1', 'x'] })).toBe('usage')
  })

  test('flags override the keys of --body and the rest of --body is kept', async () => {
    expect(await call({ body: '{"text":"from body","extra":1}', text: 'from flag' })).toEqual({
      text: 'from flag',
      extra: 1,
    })
  })

  test("no flag and no --body sends an empty object: a missing required field is the server's to refuse", async () => {
    expect(await call({})).toEqual({})
  })

  test('flags with a --body that is not an object are a usage error', async () => {
    expect(await refused({ body: '[1]', text: 'x' })).toBe('usage')
  })
})

describe('the command line of a generated command', () => {
  const sent = () => JSON.parse(seen?.body ?? 'null')

  test('flags after the positionals build the body', async () => {
    answer = { status: 200, body: { ok: true } }
    await cli(['issue', 'close', 'issue_7', '--attempt', '2', '--outcome', 'done', '--reason', 'it works'])
    expect(seen?.url).toBe(`${server.url.href}v1/issues/issue_7/close`)
    expect(sent()).toEqual({ attempt: 2, outcome: 'done', reason: 'it works' })
  })

  test('a repeatable flag collects every value', async () => {
    answer = { status: 200, body: { ok: true } }
    await cli(['planning', 'settle', '--issue', 'issue_1', '--after', 'issue_2', '--after', 'issue_3'])
    expect(sent()).toEqual({ issue: 'issue_1', after: ['issue_2', 'issue_3'] })
  })

  test('a boolean flag alone is true, and takes true or false', async () => {
    answer = { status: 200, body: { ok: true } }
    await cli(['decision', 'worth-asking', 'decision_1', '--worth'])
    expect(sent()).toEqual({ worth: true })
    await cli(['decision', 'worth-asking', 'decision_1', '--worth', 'false'])
    expect(sent()).toEqual({ worth: false })
    expect(seen?.url).toBe(`${server.url.href}v1/decisions/decision_1/worth-asking`)
  })

  test('--format may come before the command', async () => {
    answer = { status: 200, body: healthy }
    const result = await cli(['--format', 'plain', 'health', 'get'])
    expect(result.out.startsWith('status\tok')).toBe(true)
  })

  test('an unknown flag for the command is exit 2 naming the command, and sends nothing', async () => {
    seen = undefined
    const result = await cli(['issue', 'close', 'issue_7', '--bogus', 'x'])
    expect(result.code).toBe(2)
    expect(errorOf(result.err).message).toContain('issue close')
    expect(seen).toBeUndefined()
  })

  test("another command does not know this command's flags", async () => {
    const result = await cli(['health', 'get', '--attempt', '1'])
    expect(result.code).toBe(2)
  })

  test('a flag that is not a number is exit 2', async () => {
    const result = await cli(['issue', 'close', 'issue_7', '--attempt', 'two'])
    expect(result.code).toBe(2)
    expect(errorOf(result.err).message).toContain('--attempt')
  })

  test('<command> --help prints the usage with the flags and their marks, on stdout', async () => {
    const result = await cli(['issue', 'close', '--help'])
    expect(result.code).toBe(0)
    expect(result.err).toBe('')
    expect(result.out).toContain('usage: factory issue close <id> [flags]')
    expect(result.out).toContain('--attempt <integer>  required')
    expect(result.out).toContain('--call <text>\n')
    expect(result.out).toContain('--body <json>')
    const defer = await cli(['issue', 'defer', '-h'])
    expect(defer.out).toContain('--after <text>  repeatable')
  })

  test('the top-level help lists commands, not their flags', async () => {
    const out = (await cli(['--help'])).out
    expect(out).toContain('issue close <id>')
    expect(out).not.toContain('--attempt')
  })
})
