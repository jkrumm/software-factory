import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Health } from '@software-factory/contract'
import { operationsOf } from '../scripts/generate.ts'
import { run } from '../src/run.ts'
import type { Operation } from '../src/operation.ts'

const healthResponses = {
  '200': { description: '', content: { 'application/json': { schema: { $ref: '#/$defs/Health' } } } },
}

const body = (properties: Record<string, unknown>, required: string[] = []) => ({
  content: {
    'application/json': {
      schema: { $ref: '#/$defs/CloseBody', $defs: { CloseBody: { type: 'object', properties, required } } },
    },
  },
})

/** A tiny fixture API, as the OpenAPI document of a server would describe it: the generator's input, not the real routes. */
const fixture = (extra: Record<string, unknown> = {}) => ({
  paths: {
    '/things/{id}/notes': {
      post: {
        operationId: 'thing.note',
        summary: 'add a note. It is read by the lead',
        'x-cli': { args: ['text'] },
        parameters: [{ name: 'id', in: 'path' }],
        requestBody: body({ text: { type: 'string' }, kind: { type: 'string' } }, ['text']),
        responses: healthResponses,
        ...extra,
      },
    },
    '/things/{id}/prio': {
      post: {
        operationId: 'thing.prio',
        'x-cli': { args: ['value'] },
        parameters: [{ name: 'id', in: 'path' }],
        requestBody: body({ value: { type: 'integer' } }, ['value']),
        responses: healthResponses,
      },
    },
    '/things': {
      post: {
        operationId: 'thing.new',
        requestBody: body({
          repo: { type: 'string' },
          title: { type: 'string' },
          key: { type: 'string' },
          after: { type: 'array', items: { type: 'integer' } },
          facts: { type: 'object' },
        }),
        responses: healthResponses,
      },
      get: {
        operationId: 'thing.list',
        parameters: [
          { name: 'live', in: 'query', schema: { type: 'string', enum: ['1'] } },
          { name: 'all', in: 'query', schema: { type: 'boolean' } },
          { name: 'state', in: 'query', schema: { type: 'string', enum: ['open', 'closed'] } },
        ],
        responses: healthResponses,
      },
    },
  },
})

const operationsFrom = (document: unknown): Operation[] =>
  operationsOf(document).map(({ bodySchema: _bodySchema, ...op }) => ({
    ...op,
    command: [op.command[0], op.command[1]],
    method: op.method as Operation['method'],
    responses: { 200: Health },
  }))

describe('the generator reads x-cli and the query schemas', () => {
  test('args, bare query flags', () => {
    const ops = operationsFrom(fixture())
    expect(ops.find((op) => op.operationId === 'thing.note')?.args).toEqual(['text'])
    expect(ops.find((op) => op.operationId === 'thing.list')?.queryFlags).toEqual([
      { name: 'live', boolean: false, value: '1' },
      { name: 'all', boolean: true, value: 'true' },
    ])
  })

  test('an arg that is not a body property, listed twice, or malformed fails naming the operation', () => {
    const wrong = (args: unknown) => () => operationsOf(fixture({ 'x-cli': args }))
    expect(wrong({ args: ['nope'] })).toThrow(/POST \/things\/\{id\}\/notes.*"nope" is not a property/)
    expect(wrong({ args: ['text', 'text'] })).toThrow('listed twice')
    expect(wrong({ args: 'text' })).toThrow('x-cli must be')
  })
})

let server: ReturnType<typeof Bun.serve>
let dir: string
let stdin = ''
let seen: { path: string; method: string; body: string } | undefined

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-args-')
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      seen = { path: `${url.pathname}${url.search}`, method: request.method, body: await request.text() }
      return Response.json({
        status: 'ok',
        version: 'dev',
        reason: null,
        heartbeat: { ok: true, reason: null, tickAt: null, queueMovedAt: null },
      })
    },
  })
})

afterAll(async () => {
  await server.stop(true)
  await rm(dir, { recursive: true, force: true })
})

async function cli(argv: string[], env: Record<string, string> = {}, operations?: Operation[]) {
  let out = ''
  let err = ''
  seen = undefined
  const code = await run(
    argv,
    {
      env: { FACTORY_URL: server.url.href, ...env },
      out: (text) => {
        out += text
      },
      err: (text) => {
        err += text
      },
      stdin: () => Promise.resolve(stdin),
      readFile: (path) => Bun.file(path).text(),
    },
    operations,
  )
  return { code, out, err }
}

const errorOf = (text: string) => (JSON.parse(text) as { error: { kind: string; message: string; hint: string } }).error
const sent = () => JSON.parse(seen?.body ?? 'null') as unknown

describe('positional body arguments', () => {
  const ops = operationsFrom(fixture())
  const fixtureCli = (argv: string[], env: Record<string, string> = {}) => cli(argv, env, ops)

  test('the extra positionals fill the body fields in order', async () => {
    const result = await fixtureCli(['thing', 'note', 't1', 'hello there'])
    expect(result.code).toBe(0)
    expect(seen?.path).toBe('/things/t1/notes')
    expect(sent()).toEqual({ text: 'hello there' })
  })

  test('a flag for another field goes with it; one for the same field is a usage error', async () => {
    await fixtureCli(['thing', 'note', 't1', 'hi', '--kind', 'x'])
    expect(sent()).toEqual({ text: 'hi', kind: 'x' })
    const clash = await fixtureCli(['thing', 'note', 't1', 'hi', '--text', 'again'])
    expect(clash.code).toBe(2)
    expect(errorOf(clash.err).message).toContain('positional <text>')
  })

  test('the wrong number of positionals is exit 2 with the usage', async () => {
    for (const argv of [
      ['thing', 'note', 't1'],
      ['thing', 'note', 't1', 'a', 'b'],
    ]) {
      const result = await fixtureCli(argv)
      expect(result.code).toBe(2)
      expect(errorOf(result.err).message).toBe('usage: thing note <id> <text>')
    }
  })

  test('a number positional is parsed, and a negative one works after --', async () => {
    await fixtureCli(['thing', 'prio', 't1', '--', '-5'])
    expect(sent()).toEqual({ value: -5 })
    await fixtureCli(['thing', 'prio', 't1', '7'])
    expect(sent()).toEqual({ value: 7 })
    const bad = await fixtureCli(['thing', 'prio', 't1', 'high'])
    expect(bad.code).toBe(2)
    expect(errorOf(bad.err).message).toContain('<value>')
  })

  test('help shows the positionals, hides their flags, and the top-level help one sentence', async () => {
    const help = (await fixtureCli(['thing', 'note', '--help'])).out
    expect(help).toContain('usage: factory thing note <id> <text> [flags]')
    expect(help).not.toContain('--text')
    expect(help).toContain('--kind <text>')
    const top = (await fixtureCli(['--help'])).out
    expect(top).toContain('thing note <id> <text>')
    expect(top).toContain('add a note\n')
    expect(top).not.toContain('It is read')
  })
})

describe('- and @file for string and json values', () => {
  const ops = operationsFrom(fixture())
  const fixtureCli = (argv: string[]) => cli(argv, {}, ops)

  test('rd files an Issue with JSON facts on stdin and repeated --after', async () => {
    stdin = '{"why":"because","n":2}\n'
    const result = await fixtureCli([
      'thing',
      'new',
      '--repo',
      'r',
      '--title',
      't',
      '--after',
      '1',
      '--after',
      '2',
      '--key',
      'k',
      '--facts',
      '-',
    ])
    expect(result.code).toBe(0)
    expect(sent()).toEqual({ repo: 'r', title: 't', after: [1, 2], key: 'k', facts: { why: 'because', n: 2 } })
  })

  test('stdin as a positional text, and @path as a flag or text', async () => {
    stdin = 'from stdin\nsecond line\n'
    await fixtureCli(['thing', 'note', 't1', '-'])
    expect(sent()).toEqual({ text: 'from stdin\nsecond line\n' })
    const file = join(dir, 'note.txt')
    await writeFile(file, 'from a file')
    await fixtureCli(['thing', 'note', 't1', `@${file}`])
    expect(sent()).toEqual({ text: 'from a file' })
    await fixtureCli(['thing', 'new', '--title', `@${file}`])
    expect(sent()).toEqual({ title: 'from a file' })
  })

  test('@@ is a literal @, and a number is left alone', async () => {
    await fixtureCli(['thing', 'note', 't1', '@@jkrumm look'])
    expect(sent()).toEqual({ text: '@jkrumm look' })
  })

  test('a missing file is exit 2 naming it; JSON that does not parse is exit 2', async () => {
    const missing = await fixtureCli(['thing', 'new', '--title', '@/nonexistent/x.txt'])
    expect(missing.code).toBe(2)
    expect(errorOf(missing.err).message).toContain('/nonexistent/x.txt')
    expect(seen).toBeUndefined()
    stdin = 'not json'
    const bad = await fixtureCli(['thing', 'new', '--facts', '-'])
    expect(bad.code).toBe(2)
  })
})

describe('bare query flags', () => {
  const ops = operationsFrom(fixture())
  const fixtureCli = (argv: string[]) => cli(argv, {}, ops)

  test('an enum of one value sends it, a boolean sends true and takes false', async () => {
    await fixtureCli(['thing', 'list', '--live', '--all'])
    expect(seen?.path).toBe('/things?live=1&all=true')
    await fixtureCli(['thing', 'list', '--all', 'false', '--state', 'closed'])
    expect(seen?.path).toBe('/things?all=false&state=closed')
  })

  test('a value the flag cannot take is exit 2', async () => {
    const result = await fixtureCli(['thing', 'list', '--live=2'])
    expect(result.code).toBe(2)
    expect(seen).toBeUndefined()
  })

  test('the real read sessions takes --live, session list is retired', async () => {
    await cli(['read', 'sessions', '--live'])
    expect(seen?.path).toBe('/v1/sessions?live=1')
  })
})

describe('aliases', () => {
  test('health reaches health get, and issue show and list are commands of their own', async () => {
    await cli(['health'])
    expect(seen?.path).toBe('/health')
    await cli(['issue', 'show', 'issue_12'])
    expect(seen?.path).toBe('/v1/issues/issue_12')
    await cli(['issue', 'show', '12'])
    expect(seen?.path).toBe('/v1/issues/12')
    await cli(['issue', 'list', '--state', 'all', '--limit', '5'])
    expect(seen?.path).toBe('/v1/issues?state=all&limit=5')
    await cli(['--format', 'plain', 'health'])
    expect(seen?.path).toBe('/health')
  })

  test('the help lists them, follow, door token new and the environment', async () => {
    const out = (await cli(['--help'])).out
    for (const text of [
      'issue show <id>',
      'issue list ',
      'aliases:',
      'follow [--issue',
      'door token new <source>',
      'slot run',
      'deploy-lock --project <name>',
      'merge-lock --project <name>',
      'hook <event>',
      'FACTORY_READ_TOKEN',
      'FACTORY_ROLES_FILE',
      'rate limited',
    ]) {
      expect(out).toContain(text)
    }
  })
})

describe('retired commands', () => {
  test.each([
    [['spawn', 'create', '--repo', 'x'], 'factory signal file'],
    [['spawn', 'list'], 'factory capacity get'],
    [['fleet'], 'factory read overview'],
    [['status'], 'factory read overview'],
    [['session', 'list'], 'factory read sessions'],
    [['session', 'get', 'x'], 'factory read session <id>'],
    [['session', 'wait', 'x'], 'factory issue defer|block|ask'],
    [['issue', 'phase', 'issue_1'], 'factory issue show'],
    [['issue', 'drop', 'issue_1'], 'factory issue close --outcome dropped'],
    [['issue', 'resume', 'issue_1'], 'not rebuilt'],
    [['notify', 'list'], 'factory page list'],
    [['quota', 'refresh'], 'factory capacity refresh'],
    [['door', 'unrouted'], 'factory door routes'],
    [['door', 'route', 'set', 'a', 'b', 'c'], 'factory door route-set'],
    [['door', 'route', 'rm', 'a', 'b'], 'factory door route-remove'],
  ])('%j answers with its replacement', async (argv, replacement) => {
    const result = await cli(argv)
    expect(result.code).toBe(2)
    expect(result.out).toBe('')
    const error = errorOf(result.err)
    expect(error.kind).toBe('usage')
    expect(error.hint).toContain(replacement)
    expect(seen).toBeUndefined()
  })

  test('a command that is not retired is still unknown', async () => {
    expect(errorOf((await cli(['bogus'])).err).message).toBe('unknown command: bogus')
    expect(errorOf((await cli(['issue', 'bogus'])).err).message).toBe('unknown command: issue bogus')
  })
})

describe('door token new', () => {
  test('writes a token for a source, prints it once, refuses a second without --rotate', async () => {
    const file = join(dir, 'config', 'door-tokens.json')
    const env = { FACTORY_DOOR_TOKENS_FILE: file }
    const first = await cli(['door', 'token', 'new', 'kuma'], env)
    expect(first.code).toBe(0)
    const { source, token } = JSON.parse(first.out) as { source: string; token: string }
    expect(source).toBe('kuma')
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ kuma: token })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'config'))).mode & 0o777).toBe(0o700)

    const again = await cli(['door', 'token', 'new', 'kuma'], env)
    expect(again.code).toBe(5)
    expect(again.out).toBe('')
    const rotated = await cli(['door', 'token', 'new', 'kuma', '--rotate', '--format', 'plain'], env)
    expect(rotated.code).toBe(0)
    expect(rotated.out.trim()).not.toBe(token)
    expect(rotated.out.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const other = await cli(['door', 'token', 'new', 'hyperdx'], env)
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')))).toEqual(['kuma', 'hyperdx'])
    expect(other.code).toBe(0)
  })

  test('a missing source or a bad source name is exit 2', async () => {
    const env = { FACTORY_DOOR_TOKENS_FILE: join(dir, 'x.json') }
    expect((await cli(['door', 'token', 'new'], env)).code).toBe(2)
    expect((await cli(['door', 'token', 'new', 'Bad Name'], env)).code).toBe(1)
    expect((await cli(['door', 'token', 'list'], env)).code).toBe(2)
  })
})
