import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DoorRoute, DoorRouteList, DoorUnroutedList, IntakeAck, Issue } from '@software-factory/contract'
import { createDoor, fileViaSocket } from '../../door/src/door.ts'
import { serveHooks } from '../src/http.ts'
import { processInbox } from '../src/issues/worker.ts'
import { startApp, TEST_REPO, TEST_ROLES, TEST_ROOT, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

const CLI = join(import.meta.dir, '..', '..', 'cli', 'bin', 'factory.ts')
const IU_REPO = join(TEST_ROOT, 'IuRoot', 'work')
const LINK_TO_IU = join(TEST_ROOT, 'door-looks-fine')
const OTHER_REPO = join(TEST_ROOT, 'door-other')
const OUTSIDE = mkdtempSync('/tmp/factory-door-outside-')
mkdirSync(IU_REPO, { recursive: true })
mkdirSync(OTHER_REPO)
symlinkSync(IU_REPO, LINK_TO_IU)

let db: TestDb
let app: TestApp
let dir: string
let socket: string
let hooks: ReturnType<typeof serveHooks>
const clock = new FakeClock()

beforeAll(async () => {
  db = await startTestDb()
  app = startApp({ sql: db.sql, clock })
  dir = mkdtempSync('/tmp/factory-door-test-')
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
  rmSync(OUTSIDE, { recursive: true, force: true })
})
beforeEach(() => db.reset())

const viaSocket = (path: string, body: unknown, method = 'POST') =>
  fetch(`http://localhost${path}`, {
    unix: socket,
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const alert = (extra: Record<string, unknown> = {}) => ({
  source: 'kuma',
  monitor: 'forecast-api',
  event: '2026-11-01 21:14:07.512',
  status: 'down',
  title: 'forecast-api is down',
  facts: { msg: 'connect ECONNREFUSED' },
  ...extra,
})
const intake = (extra?: Record<string, unknown>) => viaSocket('/intake', alert(extra))
const ack = async (response: Response) => IntakeAck.parse(await response.json())
const route = (repo = TEST_REPO, extra: Record<string, unknown> = {}) =>
  app.send('PUT', '/door/routes', { source: 'kuma', monitor: 'forecast-api', repo, ...extra })

// oxlint-disable-next-line typescript/no-explicit-any -- rows of whichever table a test reads
const rows = async (table: string): Promise<Record<string, any>[]> => [
  ...(await db.sql.unsafe(`SELECT * FROM factory.${table} ORDER BY 1, 2`)),
]
const issues = () => rows('issues')
const inbox = () => rows('issue_inbox')

describe('rule 1: no route', () => {
  test('files no Issue, counts the monitor, answers 202', async () => {
    const response = await intake()
    expect(response.status).toBe(202)
    expect(await ack(response)).toEqual({ outcome: 'unrouted', issue: null })
    expect(await issues()).toEqual([])
    expect(await rows('door_unrouted')).toMatchObject([
      { source: 'kuma', monitor: 'forecast-api', count: 1, last_title: 'forecast-api is down' },
    ])
  })

  test('another event counts again with the newest title; a replay of one counts once', async () => {
    await intake()
    await intake()
    await intake({ event: 'later', title: 'forecast-api is up', status: 'up' })
    await intake({ event: 'later', title: 'forecast-api is up', status: 'up' })
    expect(await rows('door_unrouted')).toMatchObject([
      { count: 2, last_title: 'forecast-api is up', last_event: 'later' },
    ])
  })

  test('names lose their control characters before anything is keyed or shown', async () => {
    await intake({ monitor: 'api\u001b[2J\nx' })
    expect(await rows('door_unrouted')).toMatchObject([{ monitor: 'api [2J x' }])
  })

  test('a monitor routed while its alert was in flight is not listed as unrouted', async () => {
    await route()
    await db.sql`INSERT INTO factory.door_unrouted (source, monitor, count, last_seen, last_title, last_event) VALUES ('kuma', 'forecast-api', 1, ${clock.now()}, 't', 'e')`
    expect(DoorUnroutedList.parse(await (await app.get('/door/unrouted')).json()).unrouted).toEqual([])
  })

  test('one row per source and monitor, kept small', async () => {
    for (const [source, monitor] of [
      ['kuma', 'a'],
      ['kuma', 'b'],
      ['hyperdx', 'a'],
    ] as const) {
      expect((await intake({ source, monitor })).status).toBe(202)
    }
    expect(await rows('door_unrouted')).toHaveLength(3)
    expect(await issues()).toEqual([])
  })

  test('the owner reads them with `door unrouted`, and a route takes the monitor off the list', async () => {
    await intake()
    const list = DoorUnroutedList.parse(await (await app.get('/door/unrouted')).json())
    expect(list.unrouted).toMatchObject([{ source: 'kuma', monitor: 'forecast-api', count: 1 }])
    expect((await route()).status).toBe(200)
    expect(DoorUnroutedList.parse(await (await app.get('/door/unrouted')).json()).unrouted).toEqual([])
  })
})

describe('rule 3: routed, none open, down', () => {
  test('creates an Issue of source alert, in the route’s repo, answers 201', async () => {
    await route()
    const response = await intake()
    expect(response.status).toBe(201)
    const { issue } = await ack(response)
    const [row] = await issues()
    expect(row).toMatchObject({
      id: issue,
      state: 'queued',
      source: 'alert',
      source_key: 'kuma:forecast-api:2026-11-01 21:14:07.512',
      repo: TEST_REPO,
      title: 'forecast-api is down',
    })
    expect(row?.facts).toEqual({
      source: 'kuma',
      monitor: 'forecast-api',
      event: '2026-11-01 21:14:07.512',
      status: 'down',
      details: { msg: 'connect ECONNREFUSED' },
    })
    expect(await rows('door_unrouted')).toEqual([])
  })

  test('a replay is the same Issue, 200, and nothing more', async () => {
    await route()
    const first = await ack(await intake())
    const replay = await intake()
    expect(replay.status).toBe(200)
    expect(await ack(replay)).toEqual({ outcome: 'replayed', issue: first.issue })
    expect(await issues()).toHaveLength(1)
    expect(await inbox()).toEqual([])
  })

  test('the replay of the event that made an Issue is no signal on it later', async () => {
    await route()
    const { issue } = await ack(await intake())
    await db.sql`UPDATE factory.issues SET state = 'watching' WHERE id = ${issue}`
    expect((await intake()).status).toBe(200)
    expect(await inbox()).toEqual([])
    expect(await processInbox(db.sql, () => clock.now())).toEqual([])
    expect((await issues())[0]?.state).toBe('watching')
  })

  test('a retry of an event that was a signal, after its Issue closed, makes no Issue', async () => {
    await route()
    const { issue } = await ack(await intake())
    await intake({ event: 'again' })
    await db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'done', closed_at = ${clock.now()} WHERE id = ${issue}`
    const replay = await intake({ event: 'again' })
    expect(replay.status).toBe(200)
    expect(await ack(replay)).toEqual({ outcome: 'replayed', issue })
    expect(await issues()).toHaveLength(1)
  })

  test('two monitors whose names and events run together are two keys', async () => {
    await route()
    await app.send('PUT', '/door/routes', { source: 'kuma', monitor: 'db', repo: OTHER_REPO })
    await app.send('PUT', '/door/routes', { source: 'kuma', monitor: 'db:primary', repo: OTHER_REPO })
    expect((await intake({ monitor: 'db', event: 'primary:1' })).status).toBe(201)
    expect((await intake({ monitor: 'db:primary', event: '1' })).status).toBe(201)
    expect(await issues()).toHaveLength(2)
  })

  test('a closed Issue is not open: the next down event makes a new one, and the old event’s replay makes none', async () => {
    await route()
    const first = await ack(await intake())
    await db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'done', closed_at = ${clock.now()} WHERE id = ${first.issue}`
    const second = await intake({ event: 'next' })
    expect(second.status).toBe(201)
    expect((await ack(second)).issue).not.toBe(first.issue)
    expect(await issues()).toHaveLength(2)
    await db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'done', closed_at = ${clock.now()} WHERE state = 'queued'`
    const replay = await intake()
    expect(replay.status).toBe(200)
    expect((await ack(replay)).outcome).toBe('replayed')
    expect(await issues()).toHaveLength(2)
  })
})

describe('rule 2: routed, an Issue open', () => {
  test('a down event is a signal with regression: true, 200', async () => {
    await route()
    const { issue } = await ack(await intake())
    const response = await intake({ event: 'again' })
    expect(response.status).toBe(200)
    expect(await ack(response)).toEqual({ outcome: 'attached', issue })
    expect(await issues()).toHaveLength(1)
    expect(await inbox()).toMatchObject([
      {
        issue_id: issue,
        key: 'door:kuma:forecast-api:again',
        kind: 'signal',
        payload: { regression: true, status: 'down' },
      },
    ])
  })

  test('an up event is a signal too, and is no regression', async () => {
    await route()
    const { issue } = await ack(await intake())
    const response = await intake({ event: 'recovered', status: 'up' })
    expect(await ack(response)).toEqual({ outcome: 'attached', issue })
    expect(await inbox()).toMatchObject([{ kind: 'signal', payload: { regression: false, status: 'up' } }])
  })

  test('a replay is one signal', async () => {
    await route()
    await intake()
    await intake({ event: 'again' })
    const replay = await intake({ event: 'again' })
    expect(replay.status).toBe(200)
    expect((await ack(replay)).outcome).toBe('replayed')
    expect(await inbox()).toHaveLength(1)
  })

  test('Wave 1 moves a watching Issue back to work on the down signal and not on the up one', async () => {
    await route()
    const { issue } = await ack(await intake())
    await db.sql`UPDATE factory.issues SET state = 'watching', attempt = 1, hold = 1 WHERE id = ${issue}`
    await intake({ event: 'recovered', status: 'up' })
    expect(await processInbox(db.sql, () => clock.now())).toEqual([])
    expect((await issues())[0]?.state).toBe('watching')
    await intake({ event: 'down-again' })
    expect(await processInbox(db.sql, () => clock.now())).toEqual([])
    expect((await issues())[0]?.state).toBe('working')
  })

  test('two alerts of one monitor at once make one Issue', async () => {
    await route()
    const responses = await Promise.all([1, 2, 3, 4, 5].map((n) => intake({ event: `e${n}` })))
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1)
    expect(await issues()).toHaveLength(1)
    expect(await inbox()).toHaveLength(4)
  })

  test('another monitor’s Issue is not this one’s', async () => {
    await route()
    await app.send('PUT', '/door/routes', { source: 'kuma', monitor: 'billing', repo: OTHER_REPO })
    await intake()
    const other = await intake({ monitor: 'billing' })
    expect(other.status).toBe(201)
    expect(await issues()).toHaveLength(2)
  })
})

describe('rule 4: routed, none open, up', () => {
  test('files nothing but the route’s counter, 202; a replay counts once', async () => {
    await route()
    const response = await intake({ status: 'up', event: 'up-1' })
    expect(response.status).toBe(202)
    expect(await ack(response)).toEqual({ outcome: 'quiet', issue: null })
    const replay = await intake({ status: 'up', event: 'up-1' })
    expect(replay.status).toBe(202)
    expect((await ack(replay)).outcome).toBe('replayed')
    expect(await issues()).toEqual([])
    expect(await rows('door_unrouted')).toEqual([])
    expect(DoorRouteList.parse(await (await app.get('/door/routes')).json()).routes).toMatchObject([{ quiet: 1 }])
  })
})

describe('what a payload cannot do', () => {
  test('a repo, a path, a role or a command in the intake is refused as a field, and files nothing', async () => {
    await route()
    for (const extra of [
      { repo: OTHER_REPO },
      { path: OTHER_REPO },
      { role: 'lead' },
      { command: 'rm -rf /' },
      { cwd: '/' },
    ]) {
      expect((await intake(extra)).status).toBe(400)
    }
    expect(await issues()).toEqual([])
  })

  test('the same words inside facts are only facts: the repo is the route’s', async () => {
    await route()
    const facts = { repo: OUTSIDE, path: '/etc', role: 'lead', command: 'rm -rf /', cwd: IU_REPO }
    const response = await intake({ facts })
    expect(response.status).toBe(201)
    const [row] = await issues()
    expect(row?.repo).toBe(TEST_REPO)
    expect(row?.facts.details).toEqual(facts)
  })

  test('facts Postgres cannot store are made storable, for a new Issue and for a signal', async () => {
    await route()
    const facts = { lone: 'a\ud800b', nul: 'x\u0000y', ['k\u0000']: [{ deep: '\udc00' }] }
    expect((await intake({ facts })).status).toBe(201)
    expect((await intake({ event: 'again', facts })).status).toBe(200)
    expect((await issues())[0]?.facts.details).toEqual({
      lone: 'a\ufffdb',
      nul: 'x\ufffdy',
      'k\ufffd': [{ deep: '\ufffd' }],
    })
    expect(await inbox()).toHaveLength(1)
  })

  test('half a surrogate pair in a title, a monitor or an event is made text, not a 500', async () => {
    await app.send('PUT', '/door/routes', { source: 'kuma', monitor: 'api\ufffd', repo: TEST_REPO })
    const response = await intake({ monitor: 'api\ud83d', event: 'e\ude00', title: 'down \ud83d' })
    expect(response.status).toBe(201)
    expect(await issues()).toMatchObject([{ title: 'down \ufffd', source_key: 'kuma:api\ufffd:e\ufffd' }])
    expect((await intake({ monitor: 'other\ud83d', title: '\ude00' })).status).toBe(202)
    expect(await rows('door_unrouted')).toMatchObject([{ monitor: 'other\ufffd', last_title: '\ufffd' }])
  })

  test('an alert whose source is named like a timer cannot pass for its replay', async () => {
    await app.send('PUT', '/door/routes', { source: 'wake', monitor: '1', repo: TEST_REPO })
    const { issue } = await ack(await intake({ source: 'wake', monitor: '1', event: 'x' }))
    await db.sql`INSERT INTO factory.issue_inbox (issue_id, key, kind, at) VALUES (${issue}, 'wake:1:y', 'wake', ${clock.now()})`
    const response = await intake({ source: 'wake', monitor: '1', event: 'y' })
    expect((await ack(response)).outcome).toBe('attached')
  })

  test('/intake is on the socket only', async () => {
    expect((await app.send('POST', '/intake', alert())).status).toBe(404)
    expect((await viaSocket('/door/routes', {}, 'PUT')).status).toBe(404)
    expect((await fetch('http://localhost/door/unrouted', { unix: socket })).status).toBe(404)
  })

  test('facts that cannot be stored, or are too large, are 400 and 422 and file nothing', async () => {
    await route()
    expect((await intake({ facts: { big: 'x'.repeat(25 * 1024) } })).status).toBe(400)
    // Small as sent (about 20 KiB), larger once the arrays at the 32nd level are each cut to a marker.
    let nested: unknown = Array.from({ length: 7000 }, () => [])
    for (let level = 0; level < 31; level++) nested = [nested]
    expect((await intake({ facts: nested })).status).toBe(400)
    expect((await intake({ monitor: '' })).status).toBe(400)
    expect((await intake({ source: 'Kuma' })).status).toBe(400)
    expect((await intake({ status: 'sideways' })).status).toBe(400)
    expect(await issues()).toEqual([])
    expect(await issues()).toEqual([])
  })
})

describe('IuRoot', () => {
  test('a route into IuRoot is refused, by name and through a link; nothing is stored', async () => {
    for (const repo of [IU_REPO, LINK_TO_IU]) {
      const response = await route(repo)
      expect(response.status).toBe(422)
      expect(((await response.json()) as { error: string }).error).toContain('IuRoot')
    }
    expect(await rows('door_routes')).toEqual([])
    expect(await issues()).toEqual([])
  })

  test('a route that points into IuRoot anyway (the registry edited by hand) files nothing', async () => {
    await db.sql`INSERT INTO factory.door_routes (source, monitor, repo) VALUES ('kuma', 'forecast-api', ${IU_REPO})`
    const response = await intake()
    expect(response.status).toBe(422)
    expect(await issues()).toEqual([])
    expect(await rows('door_issues')).toEqual([])
  })
})

describe('the registry', () => {
  test('set, move, list, remove', async () => {
    const set = await route()
    expect(set.status).toBe(200)
    expect(DoorRoute.parse(await set.json())).toEqual({
      source: 'kuma',
      monitor: 'forecast-api',
      repo: TEST_REPO,
      quiet: 0,
      lastQuietAt: null,
    })
    await intake({ status: 'up', event: 'u' })
    const moved = DoorRoute.parse(await (await route(OTHER_REPO)).json())
    expect(moved).toMatchObject({ repo: OTHER_REPO, quiet: 1 })
    expect(DoorRouteList.parse(await (await app.get('/door/routes')).json()).routes).toHaveLength(1)

    const removed = await fetch(new URL('/door/routes', app.url), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'kuma', monitor: 'forecast-api' }),
    })
    expect(removed.status).toBe(200)
    expect(await rows('door_routes')).toEqual([])
    const again = await fetch(new URL('/door/routes', app.url), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'kuma', monitor: 'forecast-api' }),
    })
    expect(again.status).toBe(404)
  })

  test('the repo is checked like a spawn’s: outside the roots and missing are 422', async () => {
    expect((await route(OUTSIDE)).status).toBe(422)
    expect((await route(join(TEST_ROOT, 'missing'))).status).toBe(422)
    expect(
      (await app.send('PUT', '/door/routes', { source: 'kuma', monitor: 'm', repo: 'relative/path' })).status,
    ).toBe(400)
    expect(await rows('door_routes')).toEqual([])
  })

  test('the registry needs the token', async () => {
    for (const [method, path] of [
      ['GET', '/door/routes'],
      ['PUT', '/door/routes'],
      ['DELETE', '/door/routes'],
      ['GET', '/door/unrouted'],
    ]) {
      const response = await app.bare(path ?? '', {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      })
      expect(response.status).toBe(401)
    }
  })
})

describe('the door in front of the server', () => {
  const TOKEN = 'kuma-token-0123456789-abcdef'
  const fixture = (name: string): Promise<unknown> =>
    Bun.file(join(import.meta.dir, '..', '..', 'door', 'test', 'fixtures', name)).json()
  const door = () => createDoor({ tokens: { kuma: TOKEN }, file: fileViaSocket(socket), log: () => {} })
  const post = async (name: string, extra: Record<string, unknown> = {}) =>
    door()(
      new Request('http://localhost/alert/kuma', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...((await fixture(name)) as object), ...extra }),
      }),
    )

  test('Kuma’s down beat becomes an Issue, its recovery a signal, and its test message nothing', async () => {
    expect((await post('kuma-down.json')).status).toBe(202)
    await app.send('PUT', '/door/routes', { source: 'kuma', monitor: 'forecast-api', repo: TEST_REPO })
    expect((await post('kuma-test.json')).status).toBe(200)
    const down = await post('kuma-down.json')
    expect(down.status).toBe(201)
    const [row] = await issues()
    expect(row).toMatchObject({
      source: 'alert',
      repo: TEST_REPO,
      title: expect.stringContaining('forecast-api is down'),
    })
    expect(JSON.stringify(row?.facts)).not.toContain('s3cret')
    expect(JSON.stringify(row?.facts)).not.toContain(TOKEN)
    const up = await post('kuma-up.json')
    expect(up.status).toBe(200)
    expect(await inbox()).toMatchObject([{ kind: 'signal', payload: { regression: false } }])
    expect(Issue.parse(await (await app.get(`/issues/${row?.id}`)).json()).state).toBe('queued')
  })

  test('a payload that names a repo, a path or a command changes nothing', async () => {
    await app.send('PUT', '/door/routes', { source: 'kuma', monitor: 'forecast-api', repo: TEST_REPO })
    const response = await post('kuma-down.json', { repo: OUTSIDE, path: IU_REPO, command: 'rm -rf /', role: 'lead' })
    expect(response.status).toBe(201)
    expect((await issues())[0]?.repo).toBe(TEST_REPO)
  })

  test('an alert whose title and name are nothing reaches door_unrouted under the source’s name', async () => {
    const hyperdx = createDoor({ tokens: { hyperdx: TOKEN }, file: fileViaSocket(socket), log: () => {} })
    const response = await hyperdx(
      new Request('http://localhost/alert/hyperdx', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: '🚨 ', state: 'ALERT', eventId: 'e1' }),
      }),
    )
    expect(response.status).toBe(202)
    expect(await rows('door_unrouted')).toMatchObject([
      { source: 'hyperdx', monitor: 'hyperdx', last_title: 'hyperdx' },
    ])
  })

  test('a stopped factory is a 503 at the door', async () => {
    await hooks.stop(true)
    try {
      expect((await post('kuma-down.json')).status).toBe(503)
    } finally {
      hooks = serveHooks({
        sql: db.sql,
        clock,
        token: TEST_TOKEN,
        socketPath: socket,
        repoRoots: [TEST_ROOT],
        roles: TEST_ROLES,
        slots: 2,
      })
    }
  })
})

describe('factory door', () => {
  async function factory(args: string[], env: Record<string, string> = {}) {
    const proc = Bun.spawn(['bun', CLI, ...args], {
      env: { ...process.env, FACTORY_URL: app.url.href, FACTORY_TOKEN: TEST_TOKEN, FACTORY_SOCKET: socket, ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
    return { stdout, stderr, code }
  }

  test('route set, list, rm and unrouted', async () => {
    await intake()
    const unrouted = await factory(['door', 'unrouted', '--format', 'plain'])
    expect(unrouted.code).toBe(0)
    expect(unrouted.stdout).toMatch(/^kuma\tforecast-api\t1\t.+\tforecast-api is down\n$/)

    const set = await factory(['door', 'route', 'set', 'kuma', 'forecast-api', TEST_REPO])
    expect(set.code).toBe(0)
    expect(DoorRoute.parse(JSON.parse(set.stdout))).toMatchObject({ source: 'kuma', repo: TEST_REPO })
    expect((await factory(['door', 'unrouted', '--format', 'plain'])).stdout).toBe('')

    const list = await factory(['door', 'route', 'list', '--format', 'plain'])
    expect(list.stdout).toBe(`kuma\tforecast-api\t${TEST_REPO}\t0\t-\n`)

    expect((await factory(['door', 'route', 'rm', 'kuma', 'forecast-api'])).code).toBe(0)
    const gone = await factory(['door', 'route', 'rm', 'kuma', 'forecast-api'])
    expect(gone.code).toBe(4)
  })

  test('a refused repo is a usage error (422) and the registry needs the token', async () => {
    const refused = await factory(['door', 'route', 'set', 'kuma', 'm', IU_REPO])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('IuRoot')
    const noToken = await factory(['door', 'route', 'list'], { FACTORY_TOKEN: '' })
    expect(noToken.code).toBe(3)
  })

  test('usage errors', async () => {
    expect((await factory(['door'])).code).toBe(2)
    expect((await factory(['door', 'route', 'set', 'kuma'])).code).toBe(2)
    expect((await factory(['door', 'route', 'rm', 'kuma'])).code).toBe(2)
    expect((await factory(['door', 'token', 'new'])).code).toBe(2)
  })

  test('token new writes a 0600 file, prints the token once, and refuses to replace one without --rotate', async () => {
    const file = join(dir, 'conf', 'door-tokens.json')
    const first = await factory(['door', 'token', 'new', 'kuma'], { FACTORY_DOOR_TOKENS_FILE: file })
    expect(first.code).toBe(0)
    const { token } = JSON.parse(first.stdout) as { token: string }
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ kuma: token })
    expect(first.stderr).not.toContain(token)

    const again = await factory(['door', 'token', 'new', 'kuma'], { FACTORY_DOOR_TOKENS_FILE: file })
    expect(again.code).toBe(5)
    expect(again.stdout).toBe('')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ kuma: token })
    const rotated = await factory(['door', 'token', 'new', 'kuma', '--rotate', '--format', 'plain'], {
      FACTORY_DOOR_TOKENS_FILE: file,
    })
    expect(rotated.code).toBe(0)
    expect(rotated.stdout.trim()).not.toBe(token)
  })

  test('token new refuses a tokens file with loose mode and a name that is no source', async () => {
    const file = join(dir, 'loose.json')
    writeFileSync(file, '{}', { mode: 0o644 })
    expect(existsSync(file)).toBe(true)
    const loose = await factory(['door', 'token', 'new', 'kuma'], { FACTORY_DOOR_TOKENS_FILE: file })
    expect(loose.code).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe('{}')
    const name = await factory(['door', 'token', 'new', '../x'], { FACTORY_DOOR_TOKENS_FILE: join(dir, 'x.json') })
    expect(name.code).toBe(1)
  })
})
