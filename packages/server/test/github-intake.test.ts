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
  created_at: '2026-11-02T10:00:00Z',
  ...extra,
})

interface Call {
  url: string
  headers: Record<string, string>
  method: string
  body: string | undefined
}

function setup(
  options: {
    token?: string | undefined
    remotes?: Record<string, string>
    answer?: (url: string, call: Call) => Response
  } = {},
) {
  const calls: Call[] = []
  let items: unknown[] = []
  const fetchFake = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const text = String(url)
    const call: Call = {
      url: text,
      headers: init?.headers as Record<string, string>,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    return Promise.resolve(options.answer?.(text, call) ?? Response.json(items))
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

const AUTHOR = 'jkrumm'
const SINCE = '2026-11-01'
const AUTHOR_YAML = `signals:\n  github: {author: ${AUTHOR}, since: '${SINCE}'}`
const mine = (number: number, title: string, extra: Record<string, unknown> = {}) =>
  item(number, title, { labels: [], user: { login: AUTHOR }, created_at: '2026-11-05T10:00:00Z', ...extra })

/** The label query answers `labelled`, the author query `own`; other calls (write-back) answer through `rest`. */
function authorWorld(rest: (url: string, call: Call) => Response = () => Response.json([])) {
  const world = { labelled: [] as unknown[], own: [] as unknown[] }
  const answer = (url: string, call: Call): Response => {
    if (call.method === 'GET' && url.includes('/issues?labels=')) return Response.json(world.labelled)
    if (call.method === 'GET' && url.includes('/issues?creator=')) return Response.json(world.own)
    return rest(url, call)
  }
  return { world, answer }
}

describe('the GitHub author mode', () => {
  test("the owner's new issue files once without a label; a replay files nothing", async () => {
    await project('r', TEST_REPO, AUTHOR_YAML)
    const { world, answer } = authorWorld()
    world.own = [mine(5, 'Add dark mode')]
    const gh = setup({ answer })
    await gh.pass()
    expect(gh.calls.map((c) => c.url)).toContain(
      `https://api.github.com/repos/o/r/issues?creator=${AUTHOR}&state=open&since=2026-11-01T00:00:00.000Z&per_page=50&sort=created&direction=desc`,
    )
    const [issue, ...rest] = await rows('issues')
    expect(rest).toEqual([])
    expect(issue).toMatchObject({ source: 'github', source_key: 'o/r#5', repo: TEST_REPO })
    expect(issue?.facts).toMatchObject({ details: { admitted: 'author', writeback: true, author: AUTHOR } })
    await gh.pass()
    expect(await rows('issues')).toHaveLength(1)
    expect(await rows('issue_inbox')).toEqual([])
  })

  test("another author's issue in the response and one from before since file nothing", async () => {
    await project('r', TEST_REPO, AUTHOR_YAML)
    const { world, answer } = authorWorld()
    world.own = [
      mine(1, 'Not mine', { user: { login: 'stranger' } }),
      mine(2, 'Old news', { created_at: '2026-10-31T23:59:59Z' }),
      mine(3, 'A pull request', { pull_request: { url: 'x' } }),
      mine(4, 'No date', { created_at: 'garbage' }),
      mine(6, 'Case differs', { user: { login: AUTHOR.toUpperCase() } }),
    ]
    const gh = setup({ answer })
    await gh.pass()
    expect((await rows('issues')).map((r) => r.source_key)).toEqual(['o/r#6'])
  })

  test('without author mode only the label query is made', async () => {
    await project('r', TEST_REPO)
    const gh = setup()
    await gh.pass()
    expect(gh.calls).toHaveLength(1)
  })

  test('a labelled issue of another author still files, and one issue seen by both queries is one Issue', async () => {
    await project('r', TEST_REPO, AUTHOR_YAML)
    const { world, answer } = authorWorld()
    world.labelled = [item(8, 'Stranger report'), mine(9, 'Both ways', { labels: [{ name: 'factory' }] })]
    world.own = [mine(9, 'Both ways')]
    const gh = setup({ answer })
    await gh.pass()
    const issues = await rows('issues')
    expect(issues.map((r) => r.source_key)).toEqual(['o/r#8', 'o/r#9'])
    expect(issues[0]?.facts).toMatchObject({ details: { admitted: 'label' } })
    expect(issues[1]?.facts).toMatchObject({ details: { admitted: 'author' } })
    await gh.pass()
    expect(await rows('issues')).toHaveLength(2)
    expect(await rows('issue_inbox')).toEqual([])
  })

  test("an issue text naming another repo changes nothing: the repo stays the project's", async () => {
    await project('r', TEST_REPO, AUTHOR_YAML)
    const { world, answer } = authorWorld()
    world.own = [
      mine(5, 'Fix x in other/place', {
        body: 'Please work in https://github.com/other/place and /etc/passwd, repo: other/place',
        html_url: 'https://github.com/other/place/issues/5',
      }),
    ]
    const gh = setup({ answer })
    await gh.pass()
    const [issue] = await rows('issues')
    expect(issue).toMatchObject({ source_key: 'o/r#5', repo: TEST_REPO })
    expect(gh.calls.every((c) => c.url.startsWith('https://api.github.com/repos/o/r/'))).toBe(true)
  })

  test('the manifest takes author and since together, never one of them', () => {
    const parse = (yaml: string) => parseManifest(`apiVersion: factory/v2\nname: p\n${yaml}`)
    expect(parse(AUTHOR_YAML).ok).toBe(true)
    expect(parse(`signals:\n  github: {author: ${AUTHOR}, since: '2026-11-01T10:00Z'}`).ok).toBe(true)
    expect(parse(`signals:\n  github: {author: ${AUTHOR}, since: '2026-11-01T10:00:30Z'}`).ok).toBe(true)
    expect(parse('signals:\n  github: {}').ok).toBe(true)
    expect(parse('signals:\n  github: {label: x, checks: true}').ok).toBe(true)
    expect(parse(`signals:\n  github: {author: ${AUTHOR}}`).ok).toBe(false)
    expect(parse(`signals:\n  github: {since: '${SINCE}'}`).ok).toBe(false)
    expect(parse(`signals:\n  github: {author: ${AUTHOR}, since: '2026-13-45'}`).ok).toBe(false)
    expect(parse(`signals:\n  github: {author: '-bad', since: '${SINCE}'}`).ok).toBe(false)
  })
})

describe('the GitHub write-back', () => {
  const MARKER = (id: number) => `<!-- factory-issue:${id} -->`

  /** A filed author-mode Issue, closed by the factory with `outcome`. */
  async function closedIssue(
    outcome: string,
    options: { found?: 'own' | 'labelled' | 'stranger'; summary?: string } = {},
  ) {
    const { found = 'own', summary = 'Added dark mode.\nSecond line stays home.' } = options
    await project('r', TEST_REPO, AUTHOR_YAML)
    const { world, answer } = authorWorld()
    if (found === 'own') world.own = [mine(5, 'Add dark mode')]
    if (found === 'labelled') world.labelled = [mine(5, 'Add dark mode', { labels: [{ name: 'factory' }] })]
    if (found === 'stranger') world.labelled = [item(5, 'Add dark mode')]
    const writes: Call[] = []
    const state = { comments: [] as unknown[], status: 200 }
    const gh = setup({
      answer: (url, call) => {
        if (!url.startsWith('https://api.github.com/repos/o/r/issues/5')) return answer(url, call)
        if (call.method !== 'GET') writes.push(call)
        if (state.status !== 200) return new Response('secret body', { status: state.status })
        if (call.method === 'GET') {
          const page = Number(new URL(url).searchParams.get('page') ?? 1)
          return Response.json(state.comments.slice((page - 1) * 100, page * 100))
        }
        return Response.json({}, { status: call.method === 'POST' ? 201 : 200 })
      },
    })
    await gh.pass()
    const [issue] = await rows('issues')
    if (!issue) throw new Error('not filed')
    await db.sql`UPDATE factory.issues SET state = 'closed', outcome = ${outcome}, closed_at = ${clock.now()} WHERE id = ${issue.id}`
    await db.sql`
      INSERT INTO factory.issue_events (issue_id, key, kind, at, payload)
      VALUES (${issue.id}, 'ship-key', 'ship', ${clock.now()}, ${JSON.stringify({ summary })}::text::jsonb)`
    return { gh, writes, state, id: Number(issue.id) }
  }

  test('a done Issue gets one comment with the marker and a close; the next pass does nothing', async () => {
    const { gh, writes, id } = await closedIssue('done')
    await gh.pass()
    expect(writes.map((w) => w.method)).toEqual(['POST', 'PATCH'])
    expect(JSON.parse(writes[0]?.body ?? '{}')).toEqual({
      body: `${MARKER(id)}\nDone by the factory. Added dark mode.`,
    })
    expect(JSON.parse(writes[1]?.body ?? '{}')).toEqual({ state: 'closed', state_reason: 'completed' })
    expect(await rows('issue_events')).toContainEqual(
      expect.objectContaining({ key: `github_writeback:${id}`, kind: 'github_writeback' }),
    )
    await gh.pass()
    expect(writes).toHaveLength(2)
  })

  test('a marker already on the issue posts no second comment', async () => {
    const { gh, writes, state, id } = await closedIssue('done')
    state.comments = [{ body: `earlier\n${MARKER(id)}\nDone.` }]
    await gh.pass()
    expect(writes.map((w) => w.method)).toEqual(['PATCH'])
  })

  test('a marker on the second page of comments posts no second comment', async () => {
    const { gh, writes, state, id } = await closedIssue('done')
    state.comments = [...Array.from({ length: 100 }, () => ({ body: 'noise' })), { body: MARKER(id) }]
    await gh.pass()
    expect(writes.map((w) => w.method)).toEqual(['PATCH'])
  })

  test("a stranger's labelled issue gets the comment but is not closed on GitHub", async () => {
    const { gh, writes, id } = await closedIssue('done', { found: 'stranger' })
    expect((await rows('issues'))[0]?.facts).toMatchObject({ details: { admitted: 'label', writeback: true } })
    await gh.pass()
    expect(writes.map((w) => w.method)).toEqual(['POST'])
    expect(writes[0]?.body).toContain(MARKER(id))
  })

  test("the owner's issue found by the label query is admitted as author and closed", async () => {
    const { gh, writes } = await closedIssue('done', { found: 'labelled' })
    expect((await rows('issues'))[0]?.facts).toMatchObject({ details: { admitted: 'author' } })
    await gh.pass()
    expect(writes.map((w) => w.method)).toEqual(['POST', 'PATCH'])
  })

  test('another outcome comments but does not close the GitHub issue', async () => {
    const { gh, writes } = await closedIssue('dropped')
    await gh.pass()
    expect(writes.map((w) => w.method)).toEqual(['POST'])
    expect(writes[0]?.body).toContain('Closed by the factory without a change: dropped.')
  })

  test('a 403 is marked, logged in one line without the token or body, and not retried', async () => {
    const { gh, writes, state, id } = await closedIssue('done')
    state.status = 403
    logged.length = 0
    await gh.pass()
    expect(logged).toHaveLength(1)
    expect(JSON.stringify(logged)).not.toContain(TOKEN)
    expect(JSON.stringify(logged)).not.toContain('secret body')
    expect((await rows('issue_events')).find((e) => e.key === `github_writeback:${id}`)?.payload).toEqual({
      result: 'refused-403',
    })
    state.status = 200
    await gh.pass()
    expect(writes).toHaveLength(0)
  })

  test('a 500 is retried next pass', async () => {
    const { gh, writes, state } = await closedIssue('done')
    state.status = 500
    await gh.pass()
    expect(await rows('issue_events')).not.toContainEqual(expect.objectContaining({ kind: 'github_writeback' }))
    state.status = 200
    await gh.pass()
    expect(writes.map((w) => w.method)).toEqual(['POST', 'PATCH'])
  })

  test('an Issue without writeback is untouched', async () => {
    await project('r', TEST_REPO)
    const gh = setup()
    gh.serve([item(7, 'Old style')])
    await gh.pass()
    await db.sql`
      UPDATE factory.issues SET state = 'closed', outcome = 'done', closed_at = ${clock.now()},
        facts = jsonb_set(facts, '{details}', (facts->'details') - 'writeback')`
    gh.calls.length = 0
    await gh.pass()
    expect(gh.calls.every((c) => c.method === 'GET')).toBe(true)
    expect(gh.calls.some((c) => c.url.includes('/issues/7'))).toBe(false)
  })
})

const SHA1 = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

/** A default branch whose head, check runs and commit statuses a test sets; the label poll finds no issues. */
function checksWorld() {
  const world = { sha: SHA1, runs: [] as unknown[], statuses: [] as unknown[], branch: 'main' }
  const answer = (url: string): Response => {
    if (url === 'https://api.github.com/repos/o/r') return Response.json({ default_branch: world.branch })
    if (url.includes('/check-runs')) return Response.json({ check_runs: world.runs })
    if (url.includes('/status')) return Response.json({ sha: world.sha, statuses: world.statuses })
    return Response.json([])
  }
  const run = (name: string, conclusion: string | null, status = 'completed') => ({
    name,
    head_sha: world.sha,
    status,
    conclusion,
    html_url: `https://github.com/o/r/actions/runs/${name}`,
  })
  return { world, answer, run }
}

const CHECKS = 'signals:\n  github: {checks: true}'

describe('the GitHub red checks source', () => {
  test('a failed check on the default branch head files one Issue; the next pass files nothing', async () => {
    await project('r', TEST_REPO, CHECKS)
    const { world, answer, run } = checksWorld()
    world.runs = [run('ci', 'failure'), run('lint', 'success')]
    const gh = setup({ answer })
    await gh.pass()
    expect(gh.calls.map((c) => c.url)).toContain(
      'https://api.github.com/repos/o/r/commits/main/check-runs?filter=latest&per_page=100',
    )
    expect(gh.calls.map((c) => c.url)).toContain('https://api.github.com/repos/o/r/commits/main/status?per_page=100')
    expect(gh.calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true)
    const [issue, ...rest] = await rows('issues')
    expect(rest).toEqual([])
    expect(issue).toMatchObject({ source: 'checks', repo: TEST_REPO, title: 'Failing check "ci" on o/r (main)' })
    expect(issue?.facts).toMatchObject({
      source: 'checks',
      monitor: 'o/r:ci',
      status: 'down',
      details: { check: 'ci', kind: 'check_run', result: 'failure', sha: SHA1, branch: 'main' },
    })
    expect(await rows('door_issues')).toMatchObject([{ source: 'checks', monitor: 'o/r:ci' }])
    await gh.pass()
    expect(await rows('issues')).toHaveLength(1)
    expect(await rows('issue_inbox')).toEqual([])
    expect(JSON.stringify(logged)).not.toContain(TOKEN)
  })

  test('the same check red on a new sha is one Issue and one signal', async () => {
    await project('r', TEST_REPO, CHECKS)
    const { world, answer, run } = checksWorld()
    world.runs = [run('ci', 'failure')]
    const gh = setup({ answer })
    await gh.pass()
    world.sha = SHA2
    world.runs = [run('ci', 'timed_out')]
    await gh.pass()
    await gh.pass()
    expect(await rows('issues')).toHaveLength(1)
    expect(await rows('issue_inbox')).toMatchObject([{ kind: 'signal', payload: { regression: true, status: 'down' } }])
    expect(await rows('door_issues')).toHaveLength(1)
  })

  test('a green check with no episode files nothing; the green of an open episode closes nothing', async () => {
    await project('r', TEST_REPO, CHECKS)
    const { world, answer, run } = checksWorld()
    world.runs = [run('ci', 'success')]
    const gh = setup({ answer })
    await gh.pass()
    expect(await rows('issues')).toEqual([])
    expect(await rows('issue_inbox')).toEqual([])
    expect(await rows('intake_seen')).toEqual([])

    world.runs = [run('ci', 'failure')]
    await gh.pass()
    world.sha = SHA2
    world.runs = [run('ci', 'success')]
    await gh.pass()
    await gh.pass()
    const issues = await rows('issues')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.state).not.toBe('closed')
    expect(await rows('issue_inbox')).toMatchObject([{ kind: 'signal', payload: { regression: false, status: 'up' } }])
  })

  test('an up heals a pending down: nothing is filed', async () => {
    await project('r', TEST_REPO, `${CHECKS}\nheal:\n  - {when: checks.down, grace: 5m}`)
    const { world, answer, run } = checksWorld()
    world.runs = [run('ci', 'failure')]
    const gh = setup({ answer })
    await gh.pass()
    expect(await rows('issues')).toEqual([])
    expect(await rows('intake_pending')).toMatchObject([{ source: 'checks', subject: 'o/r:ci' }])
    await gh.pass()
    expect(await rows('intake_pending')).toHaveLength(1)

    world.sha = SHA2
    world.runs = [run('ci', 'success')]
    await gh.pass()
    expect(await rows('intake_pending')).toEqual([])
    expect(await rows('issues')).toEqual([])
  })

  test('running, neutral, skipped, cancelled and stale checks say nothing', async () => {
    await project('r', TEST_REPO, CHECKS)
    const { world, answer, run } = checksWorld()
    world.runs = [
      run('queued', null, 'queued'),
      run('running', null, 'in_progress'),
      run('neutral', 'neutral'),
      run('skipped', 'skipped'),
      run('cancelled', 'cancelled'),
      run('stale', 'stale'),
    ]
    world.statuses = [{ context: 'ext', state: 'pending', target_url: null }]
    const gh = setup({ answer })
    await gh.pass()
    expect(await rows('issues')).toEqual([])
    expect(await rows('intake_pending')).toEqual([])
  })

  test('a failing commit status is a down, under its context', async () => {
    await project('r', TEST_REPO, CHECKS)
    const { world, answer } = checksWorld()
    world.statuses = [
      { context: 'ci/legacy', state: 'error', target_url: 'https://ci.example.com/1' },
      { context: 'ci/ok', state: 'success', target_url: null },
    ]
    const gh = setup({ answer })
    await gh.pass()
    const [issue, ...rest] = await rows('issues')
    expect(rest).toEqual([])
    expect(issue?.facts).toMatchObject({
      monitor: 'o/r:ci/legacy',
      details: { kind: 'status', result: 'error', sha: SHA1, url: 'https://ci.example.com/1' },
    })
  })

  test('without checks: true, only the label is polled', async () => {
    await project('r', TEST_REPO)
    const { world, answer, run } = checksWorld()
    world.runs = [run('ci', 'failure')]
    const gh = setup({ answer })
    await gh.pass()
    expect(gh.calls.map((c) => c.url)).toHaveLength(1)
    expect(gh.calls[0]?.url).toContain('/issues?labels=')
    expect(await rows('issues')).toEqual([])
  })

  test('a repo in IuRoot is never polled for checks', async () => {
    await project('iu', IU_REPO, CHECKS)
    const gh = setup({ remotes: { [IU_REPO]: 'https://github.com/o/iu.git' } })
    await gh.pass()
    expect(gh.calls).toEqual([])
  })

  test('a failing request is one line without the token or the body, and the next project is still polled', async () => {
    await project('r', TEST_REPO, CHECKS)
    await project('s', SECOND_REPO, CHECKS)
    const { world, answer, run } = checksWorld()
    const gh = setup({
      remotes: { [TEST_REPO]: 'https://github.com/o/r', [SECOND_REPO]: 'https://github.com/o/s' },
      answer: (url) => {
        if (url.startsWith('https://api.github.com/repos/o/r')) return new Response('boom', { status: 500 })
        if (url === 'https://api.github.com/repos/o/s') return Response.json({ default_branch: 'trunk' })
        if (url.includes('/commits/trunk/check-runs'))
          return Response.json({ check_runs: [{ ...run('ci', 'failure'), head_sha: SHA2 }] })
        if (url.includes('/commits/trunk/status')) return Response.json({ sha: SHA2, statuses: [] })
        return answer(url)
      },
    })
    world.runs = []
    await gh.pass()
    expect((await rows('issues')).map((r) => r.facts.monitor)).toEqual(['o/s:ci'])
    expect(logged).toContainEqual(['github intake', { repo: 'o/r', step: 'repo', status: 500 }])
    expect(JSON.stringify(logged)).not.toContain(TOKEN)
    expect(JSON.stringify(logged)).not.toContain('boom')
  })
})
