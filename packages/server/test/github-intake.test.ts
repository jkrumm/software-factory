import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessResult } from '../src/exec.ts'
import { GithubIntake } from '../src/intake/github.ts'
import { parseManifest } from '../src/projects/manifest.ts'
import { TEST_REPO, TEST_ROOT } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

const SECOND_REPO = join(TEST_ROOT, 'second')
const IU_REPO = join(TEST_ROOT, 'IuRoot', 'gh')
mkdirSync(SECOND_REPO, { recursive: true })
mkdirSync(IU_REPO, { recursive: true })
const TOKEN = 'ghp_secret_token_value'

let db: TestDb
const clock = new FakeClock()

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(() => db.reset())

const logged: unknown[][] = []
let errors: ReturnType<typeof spyOn>
beforeEach(() => {
  logged.length = 0
  errors = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args)
  })
})
afterEach(() => errors.mockRestore())

const project = async (name: string, repo: string, yaml = 'signals:\n  github: {}') => {
  const parsed = parseManifest(`apiVersion: factory/v2\nname: ${name}\n${yaml}`)
  if (!parsed.ok) throw new Error(parsed.message)
  await db.sql`
    INSERT INTO factory.projects (name, repo, manifest, make_targets, synced_at, created_at)
    VALUES (${name}, ${repo}, ${JSON.stringify(parsed.manifest)}::text::jsonb, NULL, ${clock.now()}, ${clock.now()})`
}

const item = (number: number, title: string, extra: Record<string, unknown> = {}) => ({
  number,
  title,
  body: 'it crashes',
  html_url: `https://github.com/o/r/issues/${number}`,
  labels: [{ name: 'factory' }],
  user: { login: 'someone' },
  ...extra,
})

interface Call {
  url: string
  headers: Record<string, string>
}

function setup(
  options: { token?: string | undefined; remotes?: Record<string, string>; answer?: (url: string) => Response } = {},
) {
  const calls: Call[] = []
  let items: unknown[] = []
  const fetchFake = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const text = String(url)
    calls.push({ url: text, headers: init?.headers as Record<string, string> })
    return Promise.resolve(options.answer?.(text) ?? Response.json(items))
  }
  const remotes = options.remotes ?? { [TEST_REPO]: 'https://github.com/o/r.git' }
  const run = (cmd: string[]): Promise<ProcessResult> => {
    const url = remotes[cmd[2] ?? '']
    return Promise.resolve(url === undefined ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `${url}\n` })
  }
  const intake = new GithubIntake({
    sql: db.sql,
    now: () => clock.now(),
    roots: [TEST_ROOT],
    token: 'token' in options ? options.token : TOKEN,
    everyMs: 300_000,
    fetch: fetchFake as typeof fetch,
    run,
  })
  const pass = async () => {
    clock.advance(300_000)
    intake.kick()
    await intake.settled()
  }
  return {
    calls,
    intake,
    pass,
    serve: (next: unknown[]) => {
      items = next
    },
  }
}

// oxlint-disable-next-line typescript/no-explicit-any -- rows of whichever table a test reads
const rows = async (table: string): Promise<Record<string, any>[]> => [
  ...(await db.sql.unsafe(`SELECT * FROM factory.${table} ORDER BY 1, 2`)),
]

describe('the GitHub label source', () => {
  test('a labelled issue becomes one Issue with its facts; the next pass files nothing', async () => {
    await project('r', TEST_REPO)
    const gh = setup()
    gh.serve([item(7, 'Crash on start')])
    await gh.pass()
    const [issue, ...rest] = await rows('issues')
    expect(rest).toEqual([])
    expect(issue).toMatchObject({ source: 'github', source_key: 'o/r#7', title: 'Crash on start', repo: TEST_REPO })
    expect(issue?.facts).toMatchObject({
      source: 'github',
      monitor: 'o/r#7',
      status: 'event',
      details: {
        url: 'https://github.com/o/r/issues/7',
        number: 7,
        labels: ['factory'],
        author: 'someone',
        body: 'it crashes',
      },
    })
    expect(issue?.title).not.toContain('someone')
    await gh.pass()
    expect(await rows('issues')).toHaveLength(1)
  })

  test('the request carries the label, the headers and the token, and the token is never logged', async () => {
    await project('r', TEST_REPO, 'signals:\n  github: {label: needs fix}')
    const gh = setup({ answer: () => new Response('boom', { status: 500 }) })
    await gh.pass()
    expect(gh.calls).toHaveLength(1)
    expect(gh.calls[0]?.url).toBe(
      'https://api.github.com/repos/o/r/issues?labels=needs%20fix&state=open&per_page=50&sort=created&direction=asc',
    )
    expect(gh.calls[0]?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'software-factory',
    })
    expect(JSON.stringify(logged)).not.toContain(TOKEN)
    expect(JSON.stringify(logged)).not.toContain('boom')
  })

  test('pull requests are ignored', async () => {
    await project('r', TEST_REPO)
    const gh = setup()
    gh.serve([item(1, 'A PR', { pull_request: { url: 'x' } }), item(2, 'An issue')])
    await gh.pass()
    expect((await rows('issues')).map((r) => r.source_key)).toEqual(['o/r#2'])
  })

  test('two GitHub issues with one normalized title: the second is a signal on the first', async () => {
    await project('r', TEST_REPO)
    const gh = setup()
    gh.serve([item(1, 'Crash on start (v1)'), item(2, 'crash on START v22!')])
    await gh.pass()
    expect(await rows('issues')).toHaveLength(1)
    expect(await rows('issue_inbox')).toMatchObject([{ kind: 'signal' }])
    expect(await rows('door_issues')).toMatchObject([{ repeats: 1 }])
  })

  test('a closed Issue and the same problem within 24 h is a repeat, not a new Issue', async () => {
    await project('r', TEST_REPO)
    const gh = setup()
    gh.serve([item(1, 'Crash on start')])
    await gh.pass()
    await db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'done', closed_at = ${clock.now()}`
    gh.serve([item(1, 'Crash on start'), item(2, 'Crash on start')])
    await gh.pass()
    expect(await rows('issues')).toHaveLength(1)
    expect(await rows('door_issues')).toMatchObject([{ repeats: 1 }])
  })

  test('no token: the source is off and nothing is fetched', async () => {
    await project('r', TEST_REPO)
    const gh = setup({ token: undefined })
    await gh.pass()
    expect(gh.calls).toEqual([])
    expect(JSON.stringify(logged)).toContain('FACTORY_GITHUB_TOKEN not set')
  })

  test('a repo in IuRoot is never polled', async () => {
    await project('iu', IU_REPO)
    const gh = setup({ remotes: { [IU_REPO]: 'https://github.com/o/iu.git' } })
    await gh.pass()
    expect(gh.calls).toEqual([])
    expect(await rows('issues')).toEqual([])
  })

  test('a paused project or one without signals.github is not polled', async () => {
    await project('r', TEST_REPO, '')
    await project('s', SECOND_REPO)
    await db.sql`UPDATE factory.projects SET paused = true WHERE name = 's'`
    const gh = setup({ remotes: { [TEST_REPO]: 'https://github.com/o/r', [SECOND_REPO]: 'https://github.com/o/s' } })
    await gh.pass()
    expect(gh.calls).toEqual([])
  })

  test('only github.com remotes over https or ssh are polled', async () => {
    await project('r', TEST_REPO)
    await project('s', SECOND_REPO)
    const gh = setup({
      remotes: { [TEST_REPO]: 'https://git.example.com/o/r.git', [SECOND_REPO]: 'git@github.com:o/s.git' },
    })
    await gh.pass()
    expect(gh.calls.map((c) => c.url.split('/issues')[0])).toEqual(['https://api.github.com/repos/o/s'])
    expect(logged.length).toBe(1)
  })

  test('the first pass waits 30 s, then the poll keeps its spacing', async () => {
    await project('r', TEST_REPO)
    const gh = setup()
    const kick = async () => {
      gh.intake.kick()
      await gh.intake.settled()
    }
    await kick()
    expect(gh.calls).toHaveLength(0)
    clock.advance(30_000)
    await kick()
    expect(gh.calls).toHaveLength(1)
    clock.advance(60_000)
    await kick()
    expect(gh.calls).toHaveLength(1)
    clock.advance(240_000)
    await kick()
    expect(gh.calls).toHaveLength(2)
  })

  test('an HTTP 500 does not throw and the next project is still polled', async () => {
    await project('r', TEST_REPO)
    await project('s', SECOND_REPO)
    const gh = setup({
      remotes: { [TEST_REPO]: 'https://github.com/o/r', [SECOND_REPO]: 'https://github.com/o/s' },
      answer: (url) => (url.includes('/o/r/') ? new Response('', { status: 500 }) : Response.json([item(3, 'Second')])),
    })
    await gh.pass()
    expect(gh.calls).toHaveLength(2)
    expect((await rows('issues')).map((r) => r.source_key)).toEqual(['o/s#3'])
    expect(logged).toContainEqual(['github intake', { repo: 'o/r', status: 500 }])
  })

  test('a full page of 50 logs one line and still files them all', async () => {
    await project('r', TEST_REPO)
    const gh = setup()
    // Titles differ in letters only: digits do not count towards the fingerprint.
    const word = (n: number) => String.fromCharCode(97 + Math.floor(n / 26), 97 + (n % 26))
    gh.serve(Array.from({ length: 50 }, (_, n) => item(n + 1, `Problem ${word(n)}`)))
    await gh.pass()
    expect(await rows('issues')).toHaveLength(50)
    expect(logged).toHaveLength(1)
    expect(JSON.stringify(logged)).toContain('full page')
  })
})
