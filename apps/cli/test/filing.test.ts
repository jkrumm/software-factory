import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FACTS_EXAMPLE, FACTS_KEYS, FILING, NewIssueBody } from '@software-factory/contract'
import { run } from '../src/run.ts'

let server: ReturnType<typeof Bun.serve>
let dir: string
let answer: { status: number; body: unknown } = { status: 200, body: {} }
let calls = 0
let sentBody = ''

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-cli-filing-')
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      calls++
      sentBody = await request.text()
      return Response.json(answer.body, { status: answer.status })
    },
  })
})

afterAll(async () => {
  await server.stop(true)
  await rm(dir, { recursive: true, force: true })
})

async function cli(argv: string[]) {
  let out = ''
  let err = ''
  const code = await run(argv, {
    env: { FACTORY_URL: server.url.href },
    out: (text) => {
      out += text
    },
    err: (text) => {
      err += text
    },
    stdin: () => Promise.resolve(''),
    readFile: (path) => Bun.file(path).text(),
  })
  return { code, out, err }
}

const errorLine = (text: string) => JSON.parse(text).error as { kind: string; message: string; hint: string }
const filed = { status: 200, body: { issue: 'issue_1', state: 'open', filed: true } }

describe('the filing contract', () => {
  test('its example parses with the server body schema', () => {
    expect(NewIssueBody.safeParse({ repo: 'r', title: 't', facts: FACTS_EXAMPLE }).success).toBe(true)
    expect(Object.keys(FACTS_EXAMPLE)).toEqual(FACTS_KEYS.map((k) => k.key))
  })

  test('issue new --help carries the keys, the example, the factory path and FACTORY_TOKEN', async () => {
    const { code, out } = await cli(['issue', 'new', '--help'])
    expect(code).toBe(0)
    for (const { key } of FACTS_KEYS) expect(out).toContain(key)
    expect(out).toContain(JSON.stringify(FACTS_EXAMPLE, null, 2))
    expect(out).toContain('factory issue new --repo <repo> --title <title> --facts @file')
    expect(out).toContain('factory signal file --from agent:<your repo> --repo <that repo>')
    // the friction route: one signal on software-factory, never an Issue filed by the agent
    expect(out).toContain('factory signal file --from agent:<your repo> --repo software-factory')
    expect(out).toContain('Never file that Issue yourself')
    expect(out).toContain('FACTORY_TOKEN')
    expect(out).toContain('not markdown')
    expect(out).not.toMatch(/\brd\b/)
  })

  test('every hand-written verb answers --help with its usage line, exit 0', async () => {
    for (const [argv, usage] of [
      [['plan', 'schema', '--help'], 'usage: factory plan schema'],
      [['plan', 'check', '--help'], 'usage: factory plan check [file]'],
      [['deploy-lock', '--help'], 'usage: factory deploy-lock --project <name> -- <cmd>'],
      [['role', 'get', '--help'], 'usage: factory role get <role>'],
    ] as const) {
      const { code, out } = await cli([...argv])
      expect(code).toBe(0)
      expect(out).toContain(usage)
    }
  })

  test('other commands keep their help', async () => {
    expect((await cli(['issue', 'close', '--help'])).out).not.toContain('factory issue new --repo')
  })

  test('issue schema prints the guide in plain and the contract in json, without the network', async () => {
    calls = 0
    const plain = await cli(['issue', 'schema'])
    expect(plain.code).toBe(0)
    expect(plain.out).toContain('factory issue new --repo <repo> --title <title> --facts @file')
    expect(plain.out).not.toMatch(/\brd\b/)
    const json = await cli(['issue', 'schema', '--format', 'json'])
    const contract = JSON.parse(json.out)
    expect(contract.facts.keys.map((k: { key: string }) => k.key)).toEqual(FACTS_KEYS.map((k) => k.key))
    expect(contract.facts.example).toEqual(FACTS_EXAMPLE)
    expect(calls).toBe(0)
  })

  test('markdown in --facts is exit 2 and the hint names the keys and issue schema', async () => {
    const file = join(dir, 'facts.md')
    await writeFile(file, '# Why\n\nbecause\n')
    const result = await cli(['issue', 'new', '--repo', 'r', '--title', 't', '--facts', `@${file}`])
    expect(result.code).toBe(2)
    const error = errorLine(result.err)
    expect(error.message).toBe('issue new: --facts is not JSON')
    for (const word of ['why', 'what', 'change', 'acceptance', 'factory issue schema'])
      expect(error.hint).toContain(word)
  })

  test('the contract names the seat, and --seat must be a JSON object', async () => {
    expect(NewIssueBody.safeParse({ repo: 'r', title: 't', seat: FILING.seat.example }).success).toBe(true)
    const plain = await cli(['issue', 'schema'])
    expect(plain.out).toContain('--seat')
    const array = await cli(['issue', 'new', '--repo', 'r', '--title', 't', '--seat', '[1]'])
    expect(array.code).toBe(2)
    expect(errorLine(array.err).message).toBe('issue new: --seat must be a JSON object, got array')
  })

  test('--facts that is JSON but not an object is exit 2', async () => {
    const array = await cli(['issue', 'new', '--repo', 'r', '--title', 't', '--facts', '[1]'])
    expect(array.code).toBe(2)
    expect(errorLine(array.err).message).toBe('issue new: --facts must be a JSON object, got array')
    expect(errorLine(array.err).hint).toContain('factory issue schema')
    const text = await cli(['issue', 'new', '--repo', 'r', '--title', 't', '--facts', '"x"'])
    expect(errorLine(text.err).message).toContain('got string')
    const nothing = await cli(['issue', 'new', '--repo', 'r', '--title', 't', '--facts', 'null'])
    expect(errorLine(nothing.err).message).toContain('got null')
  })

  test('a 401 names the token and secrets-run, never rd', async () => {
    answer = { status: 401, body: { error: 'a bearer token is required', code: 'unauthorized' } }
    const filing = await cli(['issue', 'new', '--repo', 'r', '--title', 't'])
    expect(filing.code).toBe(3)
    expect(errorLine(filing.err).hint).toContain('secrets-run')
    expect(errorLine(filing.err).hint).not.toMatch(/\brd\b/)
    const other = await cli(['issue', 'list'])
    expect(errorLine(other.err).hint).toContain('set FACTORY_TOKEN')
    expect(errorLine(other.err).hint).not.toMatch(/\brd\b/)
  })

  test('a 422 on issue new points to issue schema', async () => {
    answer = { status: 422, body: { error: 'facts must be an object', code: 'invalid_body' } }
    const result = await cli(['issue', 'new', '--repo', 'r', '--title', 't'])
    expect(result.code).toBe(2)
    expect(errorLine(result.err).message).toBe('facts must be an object')
    expect(errorLine(result.err).hint).toContain('factory issue schema')
  })

  test('--text @file is sent in the body', async () => {
    const file = join(dir, 'text.md')
    await writeFile(file, 'some prose')
    answer = filed
    const result = await cli(['issue', 'new', '--repo', 'r', '--title', 't', '--text', `@${file}`])
    expect(result.code).toBe(0)
    expect(JSON.parse(sentBody)).toEqual({ repo: 'r', title: 't', text: 'some prose' })
  })
})
