import { describe, expect, test } from 'bun:test'
import { githubPoller } from '../../src/adapters/intake/github.ts'
import type { ProcessResult } from '../../src/adapters/intake/process.ts'
import type { Received, RepoSignals } from '../../src/domains/intake/model.ts'
import type { IntakeSink, ProjectSignals, SubjectState, Writeback } from '../../src/domains/intake/ports.ts'
import { fingerprintOf } from '../../src/domains/intake/rules.ts'
import { issueId } from '../../src/kernel/ids.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'

const TOKEN = 'ghp_secret_token_value'
const API = 'http://github.test'

interface Call {
  url: string
  method: string
  headers: Headers
  body: string | undefined
}

const project = (extra: Partial<RepoSignals> = {}): RepoSignals => ({
  repo: 'r',
  work: false,
  host: null,
  sources: ['github', 'checks'],
  github: { label: 'factory', author: null, since: null, checks: false },
  launchd: [],
  heal: [],
  ...extra,
})

const withGithub = (github: Partial<NonNullable<RepoSignals['github']>>, extra: Partial<RepoSignals> = {}) =>
  project({ github: { label: 'factory', author: null, since: null, checks: false, ...github }, ...extra })

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

const AUTHOR = 'jkrumm'
const SINCE = '2026-11-01'
const mine = (number: number, title: string, extra: Record<string, unknown> = {}) =>
  item(number, title, { labels: [], user: { login: AUTHOR }, created_at: '2026-11-05T10:00:00Z', ...extra })
const stranger = (number: number, title: string, extra: Record<string, unknown> = {}) =>
  item(number, title, { labels: [], ...extra })

function setup(
  options: {
    projects?: RepoSignals[]
    token?: string | null
    remotes?: Record<string, string>
    answer?: (url: string, call: Call) => Response | undefined
    subjects?: SubjectState[]
    writebacks?: Writeback[]
    receive?: 'fail'
    apiUrl?: string | null
  } = {},
) {
  const calls: Call[] = []
  const logged: string[] = []
  const received: Received[] = []
  const wroteBack: { issueId: string; result: string }[] = []
  const world = { labelled: [] as unknown[], own: [] as unknown[], everyone: [] as unknown[] }

  const fetchFake = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const text = String(url)
    const call: Call = {
      url: text,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    const forced = options.answer?.(text, call)
    if (forced) return Promise.resolve(forced)
    if (call.method === 'GET' && text.includes('/issues?labels=')) return Promise.resolve(Response.json(world.labelled))
    if (call.method === 'GET' && text.includes('/issues?creator=')) return Promise.resolve(Response.json(world.own))
    if (call.method === 'GET' && text.includes('/issues?state=open'))
      return Promise.resolve(Response.json(world.everyone))
    return Promise.resolve(Response.json([]))
  }) as typeof fetch

  const remotes = options.remotes ?? { '/src/r': 'https://github.com/o/r.git' }
  const run = (command: readonly string[]): Promise<ProcessResult> => {
    const url = remotes[command[2] ?? '']
    return Promise.resolve(url === undefined ? { exit: 1, stdout: '' } : { exit: 0, stdout: `${url}\n` })
  }

  const sink: IntakeSink = {
    receive(value) {
      received.push(value)
      if (options.receive === 'fail') return Promise.resolve(err(portError('unreadable', 'store down')))
      return Promise.resolve(ok({ outcome: 'filed', detail: 'new', issue: null, signal: null, reason: null }))
    },
    subjects: (_source, prefix) =>
      Promise.resolve(ok((options.subjects ?? []).filter((state) => state.subject.startsWith(prefix)))),
    pendingWritebacks: () => Promise.resolve(ok(options.writebacks ?? [])),
    wroteBack(id, result) {
      wroteBack.push({ issueId: id, result })
      return Promise.resolve(ok(undefined))
    },
  }
  const projects: ProjectSignals = {
    find: () => Promise.resolve(ok(null)),
    polled: () => Promise.resolve(ok(options.projects ?? [project()])),
  }
  const poller = githubPoller({
    sink,
    projects,
    sourceRoot: '/src',
    token: 'token' in options ? (options.token ?? null) : TOKEN,
    ...(options.apiUrl === null ? {} : { apiUrl: options.apiUrl ?? API }),
    fetch: fetchFake,
    run,
    log: (line) => logged.push(line),
  })
  return { poller, calls, logged, received, wroteBack, world }
}

const subjectsOf = (received: Received[]) => received.map((r) => r.alert?.subject)

describe('the GitHub label source', () => {
  test('a labelled issue becomes one request signal with the envelope and facts; urls come from the api base', async () => {
    const gh = setup({ apiUrl: null })
    gh.world.labelled = [item(7, 'Crash on start')]
    await gh.poller.pass()
    expect(gh.calls[0]?.url).toBe(
      'https://api.github.com/repos/o/r/issues?labels=factory&state=open&per_page=50&sort=created&direction=asc',
    )
    const [first, ...rest] = gh.received
    expect(rest).toEqual([])
    expect(first?.signal).toEqual({
      source: 'github',
      kind: 'request',
      origin: 'github',
      trust: 'machine',
      repo: 'r',
      fingerprint: fingerprintOf('o/r', 'Crash on start'),
      title: 'Crash on start',
      text: 'it crashes',
      link: 'https://github.com/o/r/issues/7',
      madeBy: null,
      probe: false,
    })
    expect(first?.alert).toEqual({
      subject: 'o/r#7',
      event: 'labeled',
      status: 'event',
      facts: {
        url: 'https://github.com/o/r/issues/7',
        number: 7,
        labels: ['factory'],
        author: 'someone',
        body: 'it crashes',
        admitted: 'label',
        writeback: true,
      },
    })
    expect(first?.signal.title).not.toContain('someone')
  })

  test('the request carries the label, the headers and the token, and a failure logs one line without them', async () => {
    const gh = setup({
      projects: [withGithub({ label: 'needs fix' })],
      answer: () => new Response('boom', { status: 500 }),
    })
    await gh.poller.pass()
    expect(gh.calls[0]?.url).toBe(
      `${API}/repos/o/r/issues?labels=needs%20fix&state=open&per_page=50&sort=created&direction=asc`,
    )
    expect(gh.calls[0]?.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(gh.calls[0]?.headers.get('Accept')).toBe('application/vnd.github+json')
    expect(gh.calls[0]?.headers.get('X-GitHub-Api-Version')).toBe('2022-11-28')
    expect(gh.calls[0]?.headers.get('User-Agent')).toBe('software-factory')
    expect(gh.received).toEqual([])
    // the label query and the open-issues query each fail once
    expect(gh.logged).toEqual(['github intake: o/r issues 500', 'github intake: o/r issues 500'])
    const text = gh.logged.join('\n')
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('boom')
  })

  test('pull requests are ignored', async () => {
    const gh = setup()
    gh.world.labelled = [item(1, 'A PR', { pull_request: { url: 'x' } }), item(2, 'An issue')]
    gh.world.everyone = [stranger(3, 'Another PR', { pull_request: { url: 'x' } })]
    await gh.poller.pass()
    expect(subjectsOf(gh.received)).toEqual(['o/r#2'])
  })

  test('no token: the source is off with one line and nothing is fetched', async () => {
    const gh = setup({ token: null })
    await gh.poller.pass()
    expect(gh.poller.enabled).toBe(false)
    expect(gh.calls).toEqual([])
    expect(gh.logged).toEqual(['github intake is off: FACTORY_GITHUB_TOKEN not set'])
  })

  test('a work repo is never polled, and neither is a project without github', async () => {
    const gh = setup({
      projects: [withGithub({ checks: true }, { work: true }), project({ github: null })],
    })
    await gh.poller.pass()
    expect(gh.calls).toEqual([])
    expect(gh.received).toEqual([])
  })

  test('only github.com remotes over https or ssh are polled', async () => {
    const gh = setup({
      projects: [project({ repo: 'r' }), project({ repo: 's' }), project({ repo: 't' })],
      remotes: {
        '/src/r': 'https://git.example.com/o/r.git',
        '/src/s': 'git@github.com:o/s.git',
        '/src/t': 'https://github.com/../x',
      },
    })
    await gh.poller.pass()
    expect(new Set(gh.calls.map((c) => c.url.split('/issues')[0]))).toEqual(new Set([`${API}/repos/o/s`]))
    expect(gh.logged).toEqual(['github intake: a project has no github.com origin and is skipped'])
  })

  test('an HTTP 500 does not throw and the next project is still polled', async () => {
    const gh = setup({
      projects: [project({ repo: 'r' }), project({ repo: 's' })],
      remotes: { '/src/r': 'https://github.com/o/r', '/src/s': 'https://github.com/o/s' },
      answer: (url) => {
        if (url.includes('/repos/o/r/')) return new Response('', { status: 500 })
        return url.includes('/issues?labels=') ? Response.json([item(3, 'Second')]) : undefined
      },
    })
    await gh.poller.pass()
    expect(subjectsOf(gh.received)).toEqual(['o/s#3'])
    expect(gh.logged).toContain('github intake: o/r issues 500')
  })

  test('a full page of 50 logs one line and hands all of them over', async () => {
    const gh = setup()
    const word = (n: number) => String.fromCharCode(97 + Math.floor(n / 26), 97 + (n % 26))
    gh.world.labelled = Array.from({ length: 50 }, (_, n) => item(n + 1, `Problem ${word(n)}`))
    await gh.poller.pass()
    expect(gh.received).toHaveLength(50)
    expect(gh.logged).toHaveLength(1)
    expect(gh.logged[0]).toContain('a full page')
  })

  test('a sink that cannot file is one line and the pass goes on', async () => {
    const gh = setup({ receive: 'fail' })
    gh.world.labelled = [item(1, 'First problem'), item(2, 'Second thing')]
    await gh.poller.pass()
    expect(gh.received).toHaveLength(2)
    expect(gh.logged).toEqual([
      'github intake: o/r#1 not filed (unreadable)',
      'github intake: o/r#2 not filed (unreadable)',
    ])
  })

  test('an issue text naming another repo changes nothing: the repo stays the project', async () => {
    const gh = setup({ projects: [withGithub({ author: AUTHOR, since: SINCE })] })
    gh.world.own = [
      mine(5, 'Fix x in other/place', {
        body: 'Please work in https://github.com/other/place and /etc/passwd, repo: other/place',
        html_url: 'https://github.com/other/place/issues/5',
      }),
    ]
    await gh.poller.pass()
    expect(gh.received.map((r) => r.signal.repo)).toEqual(['r'])
    expect(gh.calls.every((c) => c.url.startsWith(`${API}/repos/o/r/`))).toBe(true)
  })
})

describe('the held outside issues', () => {
  test('another author issue without the label is handed over as outside, to be held', async () => {
    const gh = setup()
    gh.world.everyone = [stranger(11, 'Please add a thing', { body: 'hello' })]
    await gh.poller.pass()
    expect(gh.calls.map((c) => c.url)).toContain(
      `${API}/repos/o/r/issues?state=open&per_page=50&sort=created&direction=desc`,
    )
    const [first, ...rest] = gh.received
    expect(rest).toEqual([])
    expect(first?.signal).toMatchObject({
      source: 'github',
      kind: 'request',
      origin: 'github',
      trust: 'outside',
      repo: 'r',
      title: 'Please add a thing',
      text: 'hello',
    })
    expect(first?.alert).toMatchObject({ subject: 'o/r#11', event: 'seen', status: 'event' })
    expect(first?.alert?.facts).toEqual({
      url: 'https://github.com/o/r/issues/11',
      number: 11,
      labels: [],
      author: 'someone',
      body: 'hello',
      writeback: false,
    })
  })

  test('an issue the label or author query admitted is not handed over again, and a labelled one is never outside', async () => {
    const gh = setup({ projects: [withGithub({ author: AUTHOR, since: SINCE })] })
    gh.world.labelled = [item(1, 'Labelled one')]
    gh.world.own = [mine(2, 'Mine one')]
    gh.world.everyone = [
      item(1, 'Labelled one'),
      mine(2, 'Mine one'),
      item(3, 'Labelled but unseen', { labels: [{ name: 'Factory' }] }),
      stranger(4, 'Stranger one'),
    ]
    await gh.poller.pass()
    expect(gh.received.map((r) => [r.alert?.subject, r.signal.trust])).toEqual([
      ['o/r#1', 'machine'],
      ['o/r#2', 'machine'],
      ['o/r#4', 'outside'],
    ])
  })

  test('the owner issue from before since is neither filed nor held: the backlog is never read in', async () => {
    const gh = setup({ projects: [withGithub({ author: AUTHOR, since: SINCE })] })
    gh.world.own = [mine(2, 'Old news', { created_at: '2026-10-31T23:59:59Z' })]
    gh.world.everyone = [mine(2, 'Old news', { created_at: '2026-10-31T23:59:59Z' })]
    await gh.poller.pass()
    expect(gh.received).toEqual([])
  })
})

describe('the loop guard marker', () => {
  test('a body with the marker sets madeBy; a body without it does not', async () => {
    const gh = setup()
    gh.world.labelled = [
      item(1, 'Loop made', { body: 'text\n<!-- factory-loop:deps-weekly -->' }),
      item(2, 'Person made', { body: 'text <!-- factory-loop: -->' }),
    ]
    await gh.poller.pass()
    expect(gh.received.map((r) => r.signal.madeBy)).toEqual(['deps-weekly', null])
  })

  test('an outside issue with the marker carries it too', async () => {
    const gh = setup()
    gh.world.everyone = [stranger(1, 'Sneaky', { body: '<!-- factory-loop:x -->' })]
    await gh.poller.pass()
    expect(gh.received[0]?.signal).toMatchObject({ trust: 'outside', madeBy: 'x' })
  })
})

describe('the GitHub author mode', () => {
  const authorMode = () => setup({ projects: [withGithub({ author: AUTHOR, since: SINCE })] })

  test("the owner's new issue comes in without a label as admitted by author", async () => {
    const gh = authorMode()
    gh.world.own = [mine(5, 'Add dark mode')]
    await gh.poller.pass()
    expect(gh.calls.map((c) => c.url)).toContain(
      `${API}/repos/o/r/issues?creator=${AUTHOR}&state=open&since=2026-11-01T00:00:00.000Z&per_page=50&sort=created&direction=desc`,
    )
    const [first, ...rest] = gh.received
    expect(rest).toEqual([])
    expect(first?.signal).toMatchObject({ trust: 'machine', repo: 'r' })
    expect(first?.alert).toMatchObject({ subject: 'o/r#5', event: 'opened' })
    expect(first?.alert?.facts).toMatchObject({ admitted: 'author', writeback: true, author: AUTHOR })
  })

  test("another author's issue in the response and one from before since are not admitted", async () => {
    const gh = authorMode()
    gh.world.own = [
      mine(1, 'Not mine', { user: { login: 'stranger' } }),
      mine(2, 'Old news', { created_at: '2026-10-31T23:59:59Z' }),
      mine(3, 'A pull request', { pull_request: { url: 'x' } }),
      mine(4, 'No date', { created_at: 'garbage' }),
      mine(6, 'Case differs', { user: { login: AUTHOR.toUpperCase() } }),
    ]
    await gh.poller.pass()
    expect(subjectsOf(gh.received)).toEqual(['o/r#6'])
    expect(gh.received[0]?.alert?.facts).toMatchObject({ admitted: 'author' })
  })

  test('without author mode only the label and the open-issues queries are made', async () => {
    const gh = setup()
    await gh.poller.pass()
    expect(gh.calls).toHaveLength(2)
    expect(gh.calls.some((c) => c.url.includes('creator='))).toBe(false)
  })

  test('an author without since is not author mode', async () => {
    const gh = setup({ projects: [withGithub({ author: AUTHOR })] })
    await gh.poller.pass()
    expect(gh.calls.some((c) => c.url.includes('creator='))).toBe(false)
  })

  test("a labelled issue of another author is admitted by label; one seen by both queries is one subject, the owner's", async () => {
    const gh = authorMode()
    gh.world.labelled = [item(8, 'Stranger report'), mine(9, 'Both ways', { labels: [{ name: 'factory' }] })]
    gh.world.own = [mine(9, 'Both ways')]
    await gh.poller.pass()
    expect(
      gh.received.map((r) => [
        r.alert?.subject,
        r.alert?.event,
        (r.alert?.facts as { admitted: string } | undefined)?.admitted,
      ]),
    ).toEqual([
      ['o/r#8', 'labeled', 'label'],
      ['o/r#9', 'labeled', 'author'],
    ])
  })
})

const SHA1 = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

/** A default branch whose head, check runs and commit statuses a test sets; the issue queries answer nothing. */
function checksWorld() {
  const world = { sha: SHA1, runs: [] as unknown[], statuses: [] as unknown[], branch: 'main' }
  const answer = (url: string): Response | undefined => {
    if (url === `${API}/repos/o/r`) return Response.json({ default_branch: world.branch })
    if (url.includes('/check-runs')) return Response.json({ check_runs: world.runs })
    if (url.includes('/status')) return Response.json({ sha: world.sha, statuses: world.statuses })
    return undefined
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

const WITH_CHECKS = withGithub({ checks: true })
const open = (subject: string): SubjectState => ({ subject, open: true, since: new Date('2026-11-06T00:00:00Z') })

describe('the GitHub red checks source', () => {
  test('a failed check on the default branch head is one down alert; green checks with no episode say nothing', async () => {
    const { world, answer, run } = checksWorld()
    world.runs = [run('ci', 'failure'), run('lint', 'success')]
    const gh = setup({ projects: [WITH_CHECKS], answer })
    await gh.poller.pass()
    expect(gh.calls.map((c) => c.url)).toContain(`${API}/repos/o/r/commits/main/check-runs?filter=latest&per_page=100`)
    expect(gh.calls.map((c) => c.url)).toContain(`${API}/repos/o/r/commits/main/status?per_page=100`)
    expect(gh.calls.every((c) => c.headers.get('Authorization') === `Bearer ${TOKEN}`)).toBe(true)
    const checks = gh.received.filter((r) => r.signal.source === 'checks')
    expect(checks).toHaveLength(1)
    expect(checks[0]?.signal).toMatchObject({
      kind: 'alert',
      origin: 'github',
      trust: 'machine',
      repo: 'r',
      title: 'Failing check "ci" on o/r (main)',
      link: 'https://github.com/o/r/actions/runs/ci',
    })
    expect(checks[0]?.alert).toEqual({
      subject: 'o/r:ci',
      event: `down@${SHA1}:ci`,
      status: 'down',
      facts: {
        check: 'ci',
        kind: 'check_run',
        result: 'failure',
        sha: SHA1,
        branch: 'main',
        url: 'https://github.com/o/r/actions/runs/ci',
      },
    })
    expect(gh.logged.join('\n')).not.toContain(TOKEN)
  })

  test('the green of an open subject is an up on the new sha; the green of a closed one is not sent', async () => {
    const { world, answer, run } = checksWorld()
    world.sha = SHA2
    world.runs = [run('ci', 'success'), run('lint', 'success')]
    const gh = setup({
      projects: [WITH_CHECKS],
      answer,
      subjects: [open('o/r:ci'), { ...open('o/r:lint'), open: false }, open('o/other:ci')],
    })
    await gh.poller.pass()
    const checks = gh.received.filter((r) => r.signal.source === 'checks')
    expect(checks.map((r) => [r.alert?.subject, r.alert?.event, r.alert?.status])).toEqual([
      ['o/r:ci', `up@${SHA2}:ci`, 'up'],
    ])
    expect(checks[0]?.signal.title).toBe('Passing check "ci" on o/r (main)')
  })

  test('running, neutral, skipped, cancelled and stale checks say nothing', async () => {
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
    const gh = setup({ projects: [WITH_CHECKS], answer, subjects: [open('o/r:neutral'), open('o/r:ext')] })
    await gh.poller.pass()
    expect(gh.received.filter((r) => r.signal.source === 'checks')).toEqual([])
  })

  test('a failing commit status is a down under its context', async () => {
    const { world, answer } = checksWorld()
    world.statuses = [
      { context: 'ci/legacy', state: 'error', target_url: 'https://ci.example.com/1' },
      { context: 'ci/ok', state: 'success', target_url: null },
    ]
    const gh = setup({ projects: [WITH_CHECKS], answer })
    await gh.poller.pass()
    const checks = gh.received.filter((r) => r.signal.source === 'checks')
    expect(checks).toHaveLength(1)
    expect(checks[0]?.alert).toMatchObject({
      subject: 'o/r:ci/legacy',
      event: `down@${SHA1}:ci/legacy`,
      status: 'down',
      facts: { kind: 'status', result: 'error', sha: SHA1, url: 'https://ci.example.com/1' },
    })
  })

  test('without checks: true, the checks are not read', async () => {
    const { world, answer, run } = checksWorld()
    world.runs = [run('ci', 'failure')]
    const gh = setup({ answer })
    await gh.poller.pass()
    expect(gh.calls.some((c) => c.url.includes('/commits/'))).toBe(false)
    expect(gh.received.filter((r) => r.signal.source === 'checks')).toEqual([])
  })

  test('a failing request is one line without the token or the body, and the next project is still polled', async () => {
    const { world, answer, run } = checksWorld()
    world.runs = []
    const gh = setup({
      projects: [withGithub({ checks: true }, { repo: 'r' }), withGithub({ checks: true }, { repo: 's' })],
      remotes: { '/src/r': 'https://github.com/o/r', '/src/s': 'https://github.com/o/s' },
      answer: (url) => {
        if (url.startsWith(`${API}/repos/o/r`) && !url.includes('/issues')) return new Response('boom', { status: 500 })
        if (url === `${API}/repos/o/s`) return Response.json({ default_branch: 'trunk' })
        if (url.includes('/commits/trunk/check-runs')) {
          return Response.json({ check_runs: [{ ...run('ci', 'failure'), head_sha: SHA2 }] })
        }
        if (url.includes('/commits/trunk/status')) return Response.json({ sha: SHA2, statuses: [] })
        return answer(url)
      },
    })
    await gh.poller.pass()
    expect(gh.received.filter((r) => r.signal.source === 'checks').map((r) => r.alert?.subject)).toEqual(['o/s:ci'])
    expect(gh.logged).toEqual(['github intake: o/r repo 500'])
    const text = gh.logged.join('\n')
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('boom')
  })
})

describe('the GitHub write-back', () => {
  const ID = issueId(12)
  const MARKER = `<!-- factory-issue:${ID} -->`
  const back = (extra: Partial<Writeback> = {}): Writeback => ({
    issueId: ID,
    subject: 'o/r#5',
    outcome: 'done',
    admitted: 'author',
    summary: 'Added dark mode.\nSecond line stays home.',
    ...extra,
  })

  function writeSetup(writeback: Writeback) {
    const writes: Call[] = []
    const state = { comments: [] as unknown[], status: 200 }
    const gh = setup({
      projects: [],
      writebacks: [writeback],
      answer: (url, call) => {
        if (!url.startsWith(`${API}/repos/o/r/issues/5`)) return undefined
        if (call.method !== 'GET') writes.push(call)
        if (state.status !== 200) return new Response('secret body', { status: state.status })
        if (call.method === 'GET') {
          const page = Number(new URL(url).searchParams.get('page') ?? 1)
          return Response.json(state.comments.slice((page - 1) * 100, page * 100))
        }
        return Response.json({}, { status: call.method === 'POST' ? 201 : 200 })
      },
    })
    return { gh, writes, state }
  }

  test('a done author-admitted Issue gets one comment with the marker and a close, and the result is recorded', async () => {
    const { gh, writes } = writeSetup(back())
    await gh.poller.pass()
    expect(writes.map((w) => w.method)).toEqual(['POST', 'PATCH'])
    expect(JSON.parse(writes[0]?.body ?? '{}')).toEqual({ body: `${MARKER}\nDone by the factory. Added dark mode.` })
    expect(JSON.parse(writes[1]?.body ?? '{}')).toEqual({ state: 'closed', state_reason: 'completed' })
    expect(gh.wroteBack).toEqual([{ issueId: ID, result: 'written' }])
    expect(gh.logged).toEqual([])
  })

  test('a done Issue without a summary gets the plain sentence; a long first line is clipped to 300', async () => {
    const plain = writeSetup(back({ summary: null }))
    await plain.gh.poller.pass()
    expect(JSON.parse(plain.writes[0]?.body ?? '{}')).toEqual({ body: `${MARKER}\nDone by the factory.` })
    const long = writeSetup(back({ summary: 'x'.repeat(500) }))
    await long.gh.poller.pass()
    const sentence = (JSON.parse(long.writes[0]?.body ?? '{}') as { body: string }).body
    expect(sentence).toBe(`${MARKER}\nDone by the factory. ${'x'.repeat(300)}`)
  })

  test('a marker already on the issue posts no second comment, also on the second page of comments', async () => {
    const first = writeSetup(back())
    first.state.comments = [{ body: `earlier\n${MARKER}\nDone.` }]
    await first.gh.poller.pass()
    expect(first.writes.map((w) => w.method)).toEqual(['PATCH'])
    expect(first.gh.wroteBack).toEqual([{ issueId: ID, result: 'already' }])

    const second = writeSetup(back())
    second.state.comments = [...Array.from({ length: 100 }, () => ({ body: 'noise' })), { body: MARKER }]
    await second.gh.poller.pass()
    expect(second.writes.map((w) => w.method)).toEqual(['PATCH'])
  })

  test("a stranger's issue gets the comment but is not closed on GitHub", async () => {
    const { gh, writes } = writeSetup(back({ admitted: 'label' }))
    await gh.poller.pass()
    expect(writes.map((w) => w.method)).toEqual(['POST'])
    expect(writes[0]?.body).toContain(MARKER)
  })

  test('another outcome comments but does not close the GitHub issue', async () => {
    const { gh, writes } = writeSetup(back({ outcome: 'dropped' }))
    await gh.poller.pass()
    expect(writes.map((w) => w.method)).toEqual(['POST'])
    expect(writes[0]?.body).toContain('Closed by the factory without a change: dropped.')
  })

  test('a 403 is recorded as refused, logged in one line without the token or body, and a 500 is not recorded', async () => {
    const refused = writeSetup(back())
    refused.state.status = 403
    await refused.gh.poller.pass()
    expect(refused.gh.wroteBack).toEqual([{ issueId: ID, result: 'refused-403' }])
    expect(refused.gh.logged).toEqual(['github intake: write-back to o/r refused-403'])
    expect(refused.gh.logged.join('\n')).not.toContain(TOKEN)
    expect(refused.gh.logged.join('\n')).not.toContain('secret body')

    const failing = writeSetup(back())
    failing.state.status = 500
    await failing.gh.poller.pass()
    expect(failing.gh.wroteBack).toEqual([])
    expect(failing.gh.logged).toEqual(['github intake: write-back to o/r failed (500)'])
  })

  test('a subject that is not owner/name#n is skipped', async () => {
    const { gh, writes } = writeSetup(back({ subject: '../x/y#5' }))
    await gh.poller.pass()
    expect(writes).toEqual([])
    expect(gh.wroteBack).toEqual([])
  })
})
