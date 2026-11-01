import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Issue, IssueList, MAX_FACTS_BYTES } from '@software-factory/contract'
import { serveHooks } from '../src/http.ts'
import { createIssue } from '../src/issues/create.ts'
import { startApp, TEST_REPO, TEST_ROLES, TEST_ROOT, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

const CLI = join(import.meta.dir, '..', '..', 'cli', 'bin', 'factory.ts')
const IU_REPO = join(TEST_ROOT, 'IuRoot', 'work')
const LINK_TO_IU = join(TEST_ROOT, 'looks-fine')
mkdirSync(IU_REPO, { recursive: true })
symlinkSync(IU_REPO, LINK_TO_IU)
// An IuRoot that is itself a link: the real path says nothing of it, the configured root does.
const NEUTRAL = join(TEST_ROOT, 'neutral')
mkdirSync(join(NEUTRAL, 'work'), { recursive: true })
const LINKED_ROOT = join(TEST_ROOT, 'IuRoot-link', 'IuRoot')
mkdirSync(join(TEST_ROOT, 'IuRoot-link'))
symlinkSync(NEUTRAL, LINKED_ROOT)

let db: TestDb
let app: TestApp
let dir: string
let socket: string
let hooks: ReturnType<typeof serveHooks>
const clock = new FakeClock()

beforeAll(async () => {
  db = await startTestDb()
  app = startApp({ sql: db.sql, clock })
  dir = mkdtempSync('/tmp/factory-issues-')
  socket = join(dir, 'h.sock')
  hooks = serveHooks({
    sql: db.sql,
    clock,
    token: TEST_TOKEN,
    socketPath: socket,
    repoRoots: [TEST_ROOT],
    roles: TEST_ROLES,
    slots: 2,
  })
})
afterAll(async () => {
  await hooks.stop(true)
  await app.stop()
  await db.stop()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => db.reset())

const body = (extra: Record<string, unknown> = {}) => ({
  repo: TEST_REPO,
  title: 'the forecast is wrong',
  source_key: 'k1',
  ...extra,
})
const post = (extra?: Record<string, unknown>) => app.send('POST', '/issues', body(extra))
const stored = async (): Promise<number> => (await db.sql`SELECT 1 FROM factory.issues`).length

describe('POST /issues', () => {
  test('a create is 201, queued, with the resolved repo; the same key is 200 with the stored row', async () => {
    const first = await post({ facts: { monitor: 'web' } })
    expect(first.status).toBe(201)
    const issue = Issue.parse(await first.json())
    expect(issue).toMatchObject({
      state: 'queued',
      source: 'request',
      sourceKey: 'k1',
      repo: TEST_REPO,
      facts: { monitor: 'web' },
      attempt: 0,
    })

    const again = await post({ title: 'something else', facts: { other: true } })
    expect(again.status).toBe(200)
    expect(Issue.parse(await again.json())).toEqual(issue)
    expect(await stored()).toBe(1)
    expect(await db.sql`SELECT kind FROM factory.issue_events`).toEqual([{ kind: 'created' }])
  })

  test('the key is unique per source: the same key under another source is another Issue', async () => {
    expect((await post()).status).toBe(201)
    expect((await post({ source: 'alert' })).status).toBe(201)
    expect(await stored()).toBe(2)
  })

  test('two creates at once are one Issue', async () => {
    const answers = await Promise.all([post(), post(), post(), post()])
    expect(answers.map((r) => r.status).sort()).toEqual([200, 200, 200, 201])
    expect(await stored()).toBe(1)
  })

  test("a create on a closed Issue's key reopens nothing: it answers the row", async () => {
    const { id } = Issue.parse(await (await post()).json())
    await db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'done', closed_at = ${clock.now()} WHERE id = ${id}`
    const again = await post()
    expect(again.status).toBe(200)
    expect(Issue.parse(await again.json())).toMatchObject({ id, state: 'closed' })
    expect(
      await db.sql`SELECT 1 FROM factory.issue_events WHERE to_state = 'queued' AND kind <> 'created'`,
    ).toHaveLength(0)
  })

  test('a repo outside the roots, or missing, is 422 and stores nothing', async () => {
    const outside = mkdtempSync('/tmp/factory-outside-')
    expect((await post({ repo: outside })).status).toBe(422)
    expect((await post({ repo: join(TEST_ROOT, 'nope') })).status).toBe(422)
    expect((await post({ repo: join(TEST_REPO, '..', '..') })).status).toBe(422)
    expect(await stored()).toBe(0)
    rmSync(outside, { recursive: true, force: true })
  })

  test('an alert in IuRoot is 422, through a link too; a request there is fine', async () => {
    const refused = await post({ source: 'alert', repo: IU_REPO })
    expect(refused.status).toBe(422)
    expect(((await refused.json()) as { error: string }).error).toContain('IuRoot')
    expect((await post({ source: 'alert', repo: LINK_TO_IU })).status).toBe(422)
    expect(await stored()).toBe(0)
    expect((await post({ repo: IU_REPO })).status).toBe(201)
  })

  test('an IuRoot root that is a link counts by its configured name', async () => {
    const alert = { source: 'alert', sourceKey: 'a', repo: join(LINKED_ROOT, 'work'), title: 't', facts: {} }
    const refused = await createIssue(db.sql, alert, { repoRoots: [LINKED_ROOT], now: clock.now() }).catch(String)
    expect(refused).toContain('IuRoot')
    expect(await stored()).toBe(0)
  })

  test('the configured IuRoot itself is refused, and so is a submitted link that alone names it', async () => {
    const alert = { source: 'alert', sourceKey: 'a', title: 't', facts: {} }
    const now = clock.now()
    const both = { repoRoots: [LINKED_ROOT, TEST_ROOT], now }
    expect(await createIssue(db.sql, { ...alert, repo: LINKED_ROOT }, both).catch(String)).toContain('IuRoot')

    // Only the parent is a root: the real path is neutral, the path as given is all that says IuRoot.
    const parent = { repoRoots: [TEST_ROOT], now }
    const repo = join(LINKED_ROOT, 'work')
    expect(await createIssue(db.sql, { ...alert, repo }, parent).catch(String)).toContain('IuRoot')
    expect(await stored()).toBe(0)
  })

  test('a link of any name into the home IuRoot is refused, configured or not, and the answer names no path', async () => {
    const home = join(TEST_ROOT, 'home')
    const place = join(TEST_ROOT, 'plain-name')
    const alias = join(TEST_ROOT, 'alias')
    mkdirSync(join(place, 'work'), { recursive: true })
    mkdirSync(home)
    symlinkSync(place, join(home, 'IuRoot'))
    symlinkSync(join(place, 'work'), alias)
    const before = process.env.HOME
    process.env.HOME = home
    try {
      for (const repo of [alias, join(place, 'work')]) {
        const refused = await post({ source: 'alert', repo })
        expect(refused.status).toBe(422)
        expect(await refused.text()).not.toContain('plain-name')
      }
      expect(await stored()).toBe(0)
      expect((await post({ repo: alias })).status).toBe(201)
    } finally {
      process.env.HOME = before
    }
  })

  test('an alert refused outside the roots names no resolved path either', async () => {
    const elsewhere = mkdtempSync('/tmp/factory-elsewhere-')
    const target = join(elsewhere, 'IuRoot', 'secret-name')
    mkdirSync(target, { recursive: true })
    const link = join(TEST_ROOT, 'innocent')
    symlinkSync(target, link)
    const refused = await post({ source: 'alert', repo: link })
    expect(refused.status).toBe(422)
    expect(await refused.text()).not.toContain('secret-name')
    rmSync(elsewhere, { recursive: true, force: true })
  })

  test('a body cannot name a state, an unknown source, or too many facts', async () => {
    expect((await post({ state: 'settling' })).status).toBe(400)
    expect((await post({ state: 'working' })).status).toBe(400)
    expect((await post({ source: 'kuma' })).status).toBe(400)
    expect((await post({ facts: 'x'.repeat(MAX_FACTS_BYTES) })).status).toBe(400)
    expect((await post({ source_key: '' })).status).toBe(400)
    expect((await post({ source_key: undefined })).status).toBe(400)
    expect((await post({ title: ' \n ' })).status).toBe(400)
    expect(await stored()).toBe(0)
  })

  test('facts at the limit are stored; multi-byte facts count in bytes', async () => {
    expect((await post({ facts: 'x'.repeat(MAX_FACTS_BYTES - 2) })).status).toBe(201)
    expect((await post({ source_key: 'k2', facts: 'é'.repeat(MAX_FACTS_BYTES / 2) })).status).toBe(400)
  })

  test.each([
    ['an array', [1, { a: 2 }]],
    ['a string', 'plain'],
    ['a number', 7],
    ['null', null],
  ])('facts may be any JSON: %s', async (_, facts) => {
    const created = await post({ facts })
    expect(created.status).toBe(201)
    expect(Issue.parse(await created.json()).facts).toEqual(facts)
  })

  test.each([
    ['a NUL', { text: 'a\u0000b' }],
    ['half a surrogate pair', { text: 'a\ud83d' }],
  ])('facts Postgres cannot store are a refusal, not a 500: %s', async (_, facts) => {
    expect((await post({ facts })).status).toBe(422)
    expect(await stored()).toBe(0)
  })

  test('the deepest nesting that fits the limit is stored or refused, never a 500', async () => {
    const depth = MAX_FACTS_BYTES / 2
    const deep = await app.raw(
      '/issues',
      `{"repo":${JSON.stringify(TEST_REPO)},"title":"t","source_key":"k","facts":${'['.repeat(depth)}${']'.repeat(depth)}}`,
    )
    // How deep Postgres parses depends on its stack: Homebrew's stores this, the Ubuntu runner's refuses it.
    expect([201, 422]).toContain(deep.status)
    expect(await stored()).toBe(deep.status === 201 ? 1 : 0)
    if (deep.status === 201) expect((await app.get('/issues/1')).status).toBe(200)
  })

  test('a title loses its control characters and stays one line', async () => {
    const created = await post({ title: 'down\u001b[31m\nagain\ttoday  ' })
    expect(Issue.parse(await created.json()).title).toBe('down [31m again today')
  })

  test('the token is needed', async () => {
    const refused = await app.bare('/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    })
    expect(refused.status).toBe(401)
  })
})

describe('GET /issues', () => {
  test('lists newest first without facts; one Issue has them; unknown is 404, a bad id 400', async () => {
    await post({ facts: { a: 1 } })
    clock.advance(1000)
    await post({ source_key: 'k2' })
    const list = IssueList.parse(await (await app.get('/issues')).json())
    expect(list.issues.map((i) => i.sourceKey)).toEqual(['k2', 'k1'])
    expect(list.issues[0]).not.toHaveProperty('facts')

    const one = Issue.parse(await (await app.get('/issues/1')).json())
    expect(one.facts).toEqual({ a: 1 })
    expect((await app.get('/issues/99')).status).toBe(404)
    expect((await app.get('/issues/abc')).status).toBe(400)
    expect((await app.get('/issues/99999999999')).status).toBe(400)
  })
})

describe('the socket', () => {
  const viaSocket = (method: string, path: string, payload?: unknown) =>
    fetch(`http://localhost${path}`, {
      unix: socket,
      method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })

  test('a pane files work and reads it without a token, under the same checks', async () => {
    const created = await viaSocket('POST', '/issues', body())
    expect(created.status).toBe(201)
    expect((await viaSocket('POST', '/issues', body())).status).toBe(200)
    expect((await viaSocket('POST', '/issues', body({ repo: '/etc', source_key: 'k2' }))).status).toBe(422)
    expect(
      (await viaSocket('POST', '/issues', body({ source: 'alert', repo: IU_REPO, source_key: 'k3' }))).status,
    ).toBe(422)
    expect(IssueList.parse(await (await viaSocket('GET', '/issues')).json()).issues).toHaveLength(1)
    expect(Issue.parse(await (await viaSocket('GET', '/issues/1')).json()).repo).toBe(TEST_REPO)
  })
})

describe('factory issue', () => {
  async function factory(args: string[], options: { env?: Record<string, string>; stdin?: string } = {}) {
    const proc = Bun.spawn(['bun', CLI, ...args], {
      env: {
        ...process.env,
        FACTORY_URL: app.url.href,
        FACTORY_TOKEN: TEST_TOKEN,
        FACTORY_SOCKET: socket,
        ...options.env,
      },
      stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
    return { stdout, stderr, code }
  }
  const NEW = ['issue', 'new', '--repo', TEST_REPO, '--title', 'a thing']

  test('new, list, show: with the token', async () => {
    const made = await factory([...NEW, '--key', 'k1'])
    expect(made.code).toBe(0)
    const issue = Issue.parse(JSON.parse(made.stdout))
    expect(issue).toMatchObject({ state: 'queued', source: 'request', sourceKey: 'k1', facts: {} })

    const again = await factory([...NEW, '--key', 'k1'])
    expect(Issue.parse(JSON.parse(again.stdout)).id).toBe(issue.id)

    const list = await factory(['issue', 'list'])
    expect(IssueList.parse(JSON.parse(list.stdout)).issues).toHaveLength(1)
    const plain = await factory(['issue', 'list', '--format', 'plain'])
    expect(plain.stdout).toBe(`1\tqueued\t-\trequest\t${TEST_REPO}\ta thing\n`)
    const show = await factory(['issue', 'show', '1'])
    expect(Issue.parse(JSON.parse(show.stdout)).sourceKey).toBe('k1')
  })

  test('without --key every call is an Issue of its own', async () => {
    await factory(NEW)
    await factory(NEW)
    expect(await stored()).toBe(2)
  })

  test('from a pane: the socket, no token', async () => {
    const pane = { env: { FACTORY_TOKEN: '', FACTORY_URL: 'http://127.0.0.1:1' } }
    expect((await factory(NEW, pane)).code).toBe(0)
    expect((await factory(['issue', 'list'], pane)).code).toBe(0)
    expect((await factory(['issue', 'show', '1'], pane)).code).toBe(0)
  })

  test('--facts from a file and from stdin', async () => {
    const path = join(dir, 'facts.json')
    writeFileSync(path, '{"from":"file"}')
    const fromFile = await factory([...NEW, '--facts', `@${path}`])
    expect(Issue.parse(JSON.parse(fromFile.stdout)).facts).toEqual({ from: 'file' })
    const fromStdin = await factory([...NEW, '--facts', '-'], { stdin: '["piped"]' })
    expect(Issue.parse(JSON.parse(fromStdin.stdout)).facts).toEqual(['piped'])
  })

  test('--source alert files an alert; in IuRoot it is refused with a usage exit', async () => {
    const made = await factory([...NEW, '--source', 'alert', '--key', 'a1'])
    expect(Issue.parse(JSON.parse(made.stdout)).source).toBe('alert')
    const refused = await factory(['issue', 'new', '--repo', IU_REPO, '--title', 'x', '--source', 'alert'])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('IuRoot')
  })

  test.each([
    ['no title', ['issue', 'new', '--repo', '/tmp']],
    ['no repo', ['issue', 'new', '--title', 'x']],
    ['facts that are no path', ['issue', 'new', '--repo', '/tmp', '--title', 'x', '--facts', '{}']],
    ['a missing file', ['issue', 'new', '--repo', '/tmp', '--title', 'x', '--facts', '@/nope/none.json']],
    ['no id', ['issue', 'show']],
  ])('usage: %s is exit 2', async (_, args) => {
    expect((await factory(args)).code).toBe(2)
  })

  test('facts that are not JSON are exit 2, an unknown Issue exit 4', async () => {
    expect((await factory([...NEW, '--facts', '-'], { stdin: 'nope' })).code).toBe(2)
    expect((await factory(['issue', 'show', '99'])).code).toBe(4)
  })
})
