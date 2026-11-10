import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { FILING, PLAN_LIMITS } from '@software-factory/contract'
import * as z from 'zod'
import { run } from '../src/run.ts'

let server: ReturnType<typeof Bun.serve>
let seen: { url: string; body: string }[] = []

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      seen.push({ url: request.url, body: await request.text() })
      return Response.json({ error: 'stub', code: 'stub' }, { status: 500 })
    },
  })
})

afterAll(async () => {
  await server.stop(true)
})

async function cli(argv: string[]) {
  seen = []
  let out = ''
  let err = ''
  const code = await run(argv, {
    env: { FACTORY_URL: server.url.href, FACTORY_TOKEN: 't' },
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

describe('help and validation derived from the contract', () => {
  test('issue new --help shows --after as an Issue id with its limit', async () => {
    const { out } = await cli(['issue', 'new', '--help'])
    expect(out).toContain('--after <issue-id>  repeatable  at most 20  issue_<n> or a bare <n>')
  })

  test('planning after normalises bare numbers to Issue ids', async () => {
    await cli(['planning', 'after', '--issue', '559', '--after', '560'])
    expect(JSON.parse(seen[0]?.body ?? 'null')).toEqual({ issue: 'issue_559', after: ['issue_560'] })
    await cli(['planning', 'after', '--issue', 'issue_559', '--after', '560', '--after', 'issue_561'])
    expect(JSON.parse(seen[0]?.body ?? 'null')).toEqual({ issue: 'issue_559', after: ['issue_560', 'issue_561'] })
  })

  test('issue new --schema prints a JSON Schema the documented example validates against', async () => {
    const result = await cli(['issue', 'new', '--schema'])
    expect(result.code).toBe(0)
    expect(seen).toEqual([])
    const body = z.fromJSONSchema(JSON.parse(result.out))
    expect(body.safeParse({ repo: 'r', title: 't', facts: FILING.facts.example }).success).toBe(true)
    expect(body.safeParse({ repo: 'r' }).success).toBe(false)
  })

  test('21 --after ids fail client-side with exit 2 and send nothing', async () => {
    const after = Array.from({ length: 21 }, (_, i) => ['--after', String(i + 1)]).flat()
    const result = await cli(['issue', 'new', '--repo', 'r', '--title', 't', ...after])
    expect(result.code).toBe(2)
    expect(JSON.parse(result.err).error.message).toContain('after: at most 20 items (got 21)')
    expect(seen).toEqual([])
  })

  test('a missing required field is named client-side', async () => {
    const result = await cli(['issue', 'new', '--title', 't'])
    expect(result.code).toBe(2)
    expect(JSON.parse(result.err).error.message).toContain('repo: required')
    expect(seen).toEqual([])
  })

  test('a command without a body has no --schema', async () => {
    const result = await cli(['project', 'show', '--schema'])
    expect(result.code).toBe(2)
    expect(result.err).toContain('takes no body')
  })

  test('planning after takes the numbers the owner types for both flags', async () => {
    await cli(['planning', 'after', '--issue', '650', '--after', '651'])
    expect(JSON.parse(seen[0]?.body ?? 'null')).toEqual({ issue: 'issue_650', after: ['issue_651'] })
  })

  test('a query flag that names an Issue is sent as issue_<n>', async () => {
    await cli(['decision', 'list', '--issue', '12'])
    expect(new URL(seen[0]?.url ?? '').searchParams.get('issue')).toBe('issue_12')
    await cli(['decision', 'list', '--issue', 'issue_13'])
    expect(new URL(seen[0]?.url ?? '').searchParams.get('issue')).toBe('issue_13')
    expect((await cli(['decision', 'list', '--help'])).out).toContain('--issue <issue-id>  issue_<n> or a bare <n>')
  })

  test('door route-set and route-remove normalise --issue', async () => {
    await cli(['door', 'route-set', '--source', 'alert', '--monitor', 'm', '--repo', 'r', '--issue', '12'])
    expect(JSON.parse(seen[0]?.body ?? 'null').issue).toBe('issue_12')
    await cli(['door', 'route-remove', '--source', 'alert', '--monitor', 'm', '--issue', '12'])
    expect(JSON.parse(seen[0]?.body ?? 'null').issue).toBe('issue_12')
  })

  test('project show --help states the plan limits', async () => {
    const { out } = await cli(['project', 'show', '--help'])
    expect(out).toContain(
      `at most ${PLAN_LIMITS.maxBytes / 1024} KiB, at most ${PLAN_LIMITS.maxAliases} YAML aliases, at most ${PLAN_LIMITS.maxAfter} "after" keys per row`,
    )
  })
})
