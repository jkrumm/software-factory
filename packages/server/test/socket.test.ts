import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Session, Spawn } from '@software-factory/contract'
import { serveHooks } from '../src/http.ts'
import { HerdrRunner } from '../src/runner.ts'
import { tick } from '../src/tick.ts'
import { startApp, TEST_REPO, TEST_ROLES, TEST_ROOT, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHerdr, type FakeHerdr } from './support/herdr.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { usage } from './support/quota.ts'

const CLI = join(import.meta.dir, '..', '..', 'cli', 'bin', 'factory.ts')
const ACCOUNTS = ['a', 'b', 'c']
const OUTSIDE = mkdtempSync('/tmp/factory-outside-')
const WORKTREE = join(TEST_REPO, '.claude', 'worktrees', 'w1')
mkdirSync(WORKTREE, { recursive: true })

let db: TestDb
let herdr: FakeHerdr
let app: TestApp
let dir: string
let socket: string
let hooks: ReturnType<typeof serveHooks>
const clock = new FakeClock()

beforeAll(async () => {
  db = await startTestDb()
  herdr = await createFakeHerdr()
  app = startApp({ sql: db.sql, clock })
  dir = mkdtempSync('/tmp/factory-socket-')
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
  await herdr.cleanup()
  await db.stop()
  rmSync(dir, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
})
beforeEach(async () => {
  await db.reset()
  await herdr.reset()
  for (const account of ACCOUNTS) {
    await app.send('PUT', `/quota/accounts/${account}`, usage(10, 10, new Date(clock.now().getTime() + 1e9)))
  }
})

const viaSocket = (method: string, path: string, body?: unknown) =>
  fetch(`http://localhost${path}`, {
    unix: socket,
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const runTick = () =>
  tick({
    sql: db.sql,
    clock,
    runner: new HerdrRunner({
      bin: herdr.bin,
      clock,
      pretrustBin: herdr.pretrustBin,
      accountsFile: herdr.accountsFile,
      home: '/home/me',
      deliverWaitMs: 3_000,
    }),
  })

describe('POST /spawns on the socket: a pane starts work without a token', () => {
  test('queues the spawn with the caller as parent, as the port does', async () => {
    const res = await viaSocket('POST', '/spawns', { key: 'child', repo: TEST_REPO, prompt: 'go', parent: 'lead-1' })
    expect(res.status).toBe(201)
    expect(Spawn.parse(await res.json())).toMatchObject({
      key: 'child',
      status: 'queued',
      parent: 'lead-1',
      repo: TEST_REPO,
      space: TEST_REPO,
    })
  })

  test('is idempotent by key: a second create answers the existing spawn (200)', async () => {
    const body = { key: 'again', repo: TEST_REPO, prompt: 'go' }
    expect((await viaSocket('POST', '/spawns', body)).status).toBe(201)
    const second = await viaSocket('POST', '/spawns', { ...body, prompt: 'something else' })
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ key: 'again' })
    expect(await db.sql`SELECT prompt FROM factory.spawns WHERE key = 'again'`).toEqual([{ prompt: 'go' }])
  })

  test('has the same validation as the port', async () => {
    const bad = [
      { key: '-x', repo: TEST_REPO, prompt: 'go' },
      { key: 'k', repo: 'relative', prompt: 'go' },
      { key: 'k', repo: TEST_REPO, prompt: '-flag' },
      { key: 'k', repo: TEST_REPO, prompt: 'go', new_space: 'yes' },
    ]
    for (const body of bad) {
      expect((await viaSocket('POST', '/spawns', body)).status).toBe(400)
      expect((await app.send('POST', '/spawns', body)).status).toBe(400)
    }
    expect((await viaSocket('POST', '/spawns', { key: 'k', repo: TEST_REPO, prompt: 'go', role: 'nope' })).status).toBe(
      422,
    )
    expect((await viaSocket('POST', '/spawns', 'x')).status).toBe(400)
  })

  test('has the same repo-roots check: a repo or a space outside the allowed roots stores nothing', async () => {
    const outside = await viaSocket('POST', '/spawns', { key: 'out', repo: OUTSIDE, prompt: 'go' })
    expect(outside.status).toBe(422)
    const space = await viaSocket('POST', '/spawns', { key: 'out2', repo: TEST_REPO, prompt: 'go', space: OUTSIDE })
    expect(space.status).toBe(422)
    expect(await db.sql`SELECT key FROM factory.spawns`).toEqual([])
  })

  test('refuses a space that does not contain the repo (its panes would not find it again)', async () => {
    const other = join(TEST_ROOT, 'elsewhere')
    mkdirSync(other, { recursive: true })
    const res = await viaSocket('POST', '/spawns', { key: 'apart', repo: other, prompt: 'go', space: TEST_REPO })
    expect(res.status).toBe(422)
    expect(await db.sql`SELECT key FROM factory.spawns`).toEqual([])
  })

  test('serves a body only as JSON, as the port does', async () => {
    const res = await fetch('http://localhost/spawns', {
      unix: socket,
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ key: 'k', repo: TEST_REPO, prompt: 'go' }),
    })
    expect(res.status).toBe(415)
  })

  test('serves reads of one spawn, one session and the queue, and nothing else', async () => {
    await viaSocket('POST', '/spawns', { key: 'read-me', repo: TEST_REPO, prompt: 'go' })
    expect((await viaSocket('GET', '/spawns/read-me')).status).toBe(200)
    expect((await viaSocket('GET', '/spawns/nope')).status).toBe(404)
    expect((await viaSocket('GET', '/sessions/nope')).status).toBe(404)
    const queue = await viaSocket('GET', `/queue?project=${encodeURIComponent(TEST_REPO)}`)
    expect(await queue.json()).toMatchObject({ scope: { project: TEST_REPO }, effective: 'run' })
    expect((await viaSocket('GET', `/queue?project=${encodeURIComponent(OUTSIDE)}`)).status).toBe(422)

    // The list, the requeue, the status, the quota and every write to the queue need the token and are not here.
    for (const [method, path, body] of [
      ['GET', '/spawns'],
      ['POST', '/spawns/read-me/requeue', {}],
      ['GET', '/status'],
      ['GET', '/quota'],
      ['POST', '/quota/refresh', {}],
      ['PUT', '/queue', { state: 'drain' }],
      ['GET', '/sessions'],
    ] as const) {
      expect((await viaSocket(method, path, body)).status).toBe(404)
    }
    expect(await app.get('/queue').then((r) => r.json())).toMatchObject({ effective: 'run' })
  })
})

describe('a spawn started in a space shows its pane, tab and space', () => {
  test('spawn get and session get carry the ids the Runner made', async () => {
    await viaSocket('POST', '/spawns', { key: 'tabbed', repo: TEST_REPO, prompt: 'go' })
    expect(await runTick()).toMatchObject({ started: ['tabbed'] })
    const state = await herdr.state()
    const ids = {
      pane: state.panes[0]?.pane_id as string,
      tab: state.tabs[0]?.tab_id as string,
      workspace: state.workspaces[0]?.workspace_id as string,
    }
    const spawn = Spawn.parse(await (await viaSocket('GET', '/spawns/tabbed')).json())
    expect(spawn).toMatchObject({ status: 'started', ...ids, session: ids.pane })
    const session = Session.parse(await (await viaSocket('GET', '/sessions/tabbed')).json())
    expect(session).toMatchObject({ pane: ids.pane, tab: ids.tab })
  })

  test("a fan worker's worktree with its main checkout as space lands in the repo's space; new_space does not", async () => {
    await viaSocket('POST', '/spawns', { key: 'lead', repo: TEST_REPO, prompt: 'go' })
    await runTick()
    await viaSocket('POST', '/spawns', { key: 'fan', repo: WORKTREE, space: TEST_REPO, prompt: 'go' })
    await runTick()
    const lead = Spawn.parse(await (await viaSocket('GET', '/spawns/lead')).json())
    const fan = Spawn.parse(await (await viaSocket('GET', '/spawns/fan')).json())
    expect(fan.workspace).toBe(lead.workspace as string)
    expect(fan).toMatchObject({ repo: WORKTREE, space: TEST_REPO })
    expect((await herdr.state()).workspaces).toHaveLength(1)

    await viaSocket('POST', '/spawns', { key: 'apart', repo: TEST_REPO, prompt: 'go', new_space: true })
    await runTick()
    const apart = Spawn.parse(await (await viaSocket('GET', '/spawns/apart')).json())
    expect(apart.workspace).not.toBe(lead.workspace as string)
    expect(await db.sql`SELECT new_space FROM factory.spawns WHERE key = 'apart'`).toEqual([{ new_space: true }])
  })
})

describe('FACTORY_ROLE and the pane: a session no spawn describes reports its own', () => {
  const event = (kind: string, payload: Record<string, unknown>) =>
    viaSocket('POST', '/events', { key: `rd:${kind}`, session: 'rd-1', kind, at: '2026-10-30T12:00:00.000Z', payload })

  test('session_started records the role, the pane and the tab', async () => {
    await event('session_started', {
      claudeSessionId: 'c1',
      cwd: TEST_REPO,
      role: 'wave',
      pane: 'w7:p3',
      tab: 'w7:t3',
    })
    const session = Session.parse(await (await viaSocket('GET', '/sessions/rd-1')).json())
    expect(session).toMatchObject({ role: 'wave', pane: 'w7:p3', tab: 'w7:t3', spawn: null })
  })

  test('a name rd reuses in a new pane is the new pane; a spawn keeps the pane its Runner made', async () => {
    await event('session_started', { claudeSessionId: 'c1', pane: 'w7:p3', tab: 'w7:t3' })
    await viaSocket('POST', '/events', {
      key: 'rd:again',
      session: 'rd-1',
      kind: 'session_started',
      at: '2026-10-30T13:00:00.000Z',
      payload: { claudeSessionId: 'c2', pane: 'w9:p1', tab: 'w9:t1' },
    })
    expect(Session.parse(await (await viaSocket('GET', '/sessions/rd-1')).json())).toMatchObject({
      pane: 'w9:p1',
      tab: 'w9:t1',
    })

    await viaSocket('POST', '/spawns', { key: 'sp', repo: TEST_REPO, prompt: 'go' })
    await runTick()
    const own = Session.parse(await (await viaSocket('GET', '/sessions/sp')).json())
    await viaSocket('POST', '/events', {
      key: 'sp:start',
      session: 'sp',
      kind: 'session_started',
      at: '2026-10-30T13:00:00.000Z',
      payload: { claudeSessionId: 'c3', pane: 'w9:p9', tab: 'w9:t9' },
    })
    expect(Session.parse(await (await viaSocket('GET', '/sessions/sp')).json())).toMatchObject({
      pane: own.pane,
      tab: own.tab,
    })
  })

  test('a role that is not a word is ignored', async () => {
    await event('session_started', { claudeSessionId: 'c1', role: 'wave; rm -rf' })
    expect(Session.parse(await (await viaSocket('GET', '/sessions/rd-1')).json()).role).toBeNull()
  })

  test('the hook binary reports FACTORY_ROLE, HERDR_PANE_ID and HERDR_TAB_ID at session-start', async () => {
    const spool = mkdtempSync('/tmp/factory-spool-')
    const proc = Bun.spawn(['bun', CLI, 'hook', 'session-start'], {
      env: {
        ...process.env,
        FACTORY_SESSION: 'rd-2',
        FACTORY_ROLE: 'lead',
        HERDR_PANE_ID: 'w8:p1',
        HERDR_TAB_ID: 'w8:t1',
        FACTORY_SOCKET: socket,
        FACTORY_SPOOL_DIR: spool,
      },
      stdin: new Blob([JSON.stringify({ session_id: 'c2', cwd: TEST_REPO })]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.stdout.text()).toBe('')
    expect(await proc.exited).toBe(0)
    rmSync(spool, { recursive: true, force: true })
    const session = Session.parse(await (await viaSocket('GET', '/sessions/rd-2')).json())
    expect(session).toMatchObject({ role: 'lead', pane: 'w8:p1', tab: 'w8:t1' })
  })
})

describe('factory spawn create from a pane: no token, a parent from FACTORY_SESSION', () => {
  const factory = async (args: string[], env: Record<string, string>) => {
    const base = { ...process.env } as Record<string, string | undefined>
    delete base.FACTORY_TOKEN
    const proc = Bun.spawn(['bun', CLI, ...args], {
      env: { ...base, FACTORY_SOCKET: socket, FACTORY_URL: 'http://127.0.0.1:1', ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
    return { stdout, stderr, code }
  }

  test('queues the spawn under the caller, and spawn get follows it', async () => {
    const created = await factory(['spawn', 'create', 'from-pane', '--repo', TEST_REPO, '--prompt', 'go'], {
      FACTORY_SESSION: 'lead-7',
    })
    expect(created).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(created.stdout)).toMatchObject({ key: 'from-pane', parent: 'lead-7', status: 'queued' })

    // idempotent: the same key again answers the same spawn, exit 0
    const again = await factory(['spawn', 'create', 'from-pane', '--repo', TEST_REPO, '--prompt', 'go'], {
      FACTORY_SESSION: 'lead-7',
    })
    expect(again.code).toBe(0)

    await runTick()
    const got = await factory(['spawn', 'get', 'from-pane'], {})
    expect(JSON.parse(got.stdout)).toMatchObject({ status: 'started', parent: 'lead-7' })
    expect(JSON.parse(got.stdout).tab).toMatch(/^w/)
  })

  test('a repo outside the roots is refused (exit 1 for 422) and nothing is stored', async () => {
    const r = await factory(['spawn', 'create', 'bad', '--repo', OUTSIDE, '--prompt', 'go'], {})
    expect(r.code).not.toBe(0)
    expect(await db.sql`SELECT key FROM factory.spawns`).toEqual([])
  })

  test('--space and --new-space reach the server', async () => {
    const r = await factory(
      ['spawn', 'create', 'f1', '--repo', WORKTREE, '--prompt', 'go', '--space', TEST_REPO, '--new-space'],
      {},
    )
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ repo: WORKTREE, space: TEST_REPO })
    expect(await db.sql`SELECT new_space FROM factory.spawns WHERE key = 'f1'`).toEqual([{ new_space: true }])
  })
})
