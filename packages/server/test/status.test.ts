import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Prompt, Status } from '@software-factory/contract'
import { recordReading } from '../src/capacity.ts'
import { serveHooks } from '../src/http.ts'
import { recordPrompt } from '../src/prompts.ts'
import { buildStatus } from '../src/status.ts'
import { startApp, TEST_REPO, TEST_ROLES, TEST_ROOT, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { usage } from './support/quota.ts'
import { world } from './support/world.ts'

let db: TestDb
let app: TestApp
let clock: FakeClock
let w: ReturnType<typeof world>

beforeAll(async () => {
  db = await startTestDb()
  clock = new FakeClock()
  app = startApp({ sql: db.sql, clock })
})
afterAll(async () => {
  await app.stop()
  await db.stop()
})
beforeEach(async () => {
  await db.reset()
  w = world(db.sql, clock)
})

const status = () => buildStatus(db.sql, clock.now())

describe('factory status', () => {
  async function scene() {
    await w.spawned('quiet', { role: 'worker', account: 'a' })
    await w.emit('quiet', 'turn_started', w.at(20))
    await w.emit('quiet', 'turn_ended', w.at(19))

    await w.spawned('busy', { role: 'lead', account: 'a' })
    await w.emit('busy', 'turn_started', w.at(5))

    await w.spawned('stopped', { role: 'wave', account: 'b' })
    await w.emit('stopped', 'turn_started', w.at(40))
    await w.emit('stopped', 'prompt_blocked', w.at(3), { message: 'Dangerous rm of /tmp/x' })

    await w.spawned('fresh-blocked', { account: 'b' })
    await w.emit('fresh-blocked', 'turn_started', w.at(10))
    await w.emit('fresh-blocked', 'prompt_blocked', w.at(1))

    await w.spawned('walled', { account: 'a' })
    await w.emit('walled', 'turn_started', w.at(60))
    await w.emit('walled', 'limit_stop', w.at(30), { error: 'rate_limit' })

    await w.spawned('finished')
    await w.emit('finished', 'session_ended', w.at(1))

    await recordReading(db.sql, { account: 'a', ...usage(40, 100, new Date('2026-10-30T14:00:00Z')) }, clock.now())
    await db.sql`
      INSERT INTO factory.spawns (key, repo, prompt, status, hold, resume_at, created_at)
      VALUES ('held', '/work/repo', 'p', 'queued', 'wave', ${new Date(clock.now().getTime() + 30_000)}, ${clock.now()}),
             ('broken', '/work/repo', 'p', 'failed', NULL, NULL, ${clock.now()})`
    await db.sql`UPDATE factory.spawns SET error = 'herdr agent start: exited 1' WHERE key = 'broken'`
    await recordPrompt(db.sql, { id: 'n-pending', session: 'busy', source: 'note', text: 'look at x' }, clock.now())
    await recordPrompt(
      db.sql,
      { id: 'n-failed', session: 'quiet', source: 'restart', text: 'y', failed: 'cannot be resumed' },
      clock.now(),
    )
  }

  test('orders sessions walled, blocked, stuck first and leaves the dead out', async () => {
    await scene()
    const s = await status()
    expect(s.sessions.map((x) => [x.id, x.state])).toEqual([
      ['walled', 'walled'],
      ['stopped', 'blocked'],
      ['fresh-blocked', 'blocked'],
      ['busy', 'working'],
      ['quiet', 'idle'],
    ])
    expect(s.sessions[0]).toMatchObject({ role: 'worker', account: 'a', since: w.at(30).toISOString() })
  })

  test('lists what needs a look: a blocked session only after two minutes, walls, failed notes and spawns', async () => {
    await scene()
    expect((await status()).attention).toEqual([
      'walled walled for 30 min on a',
      'blocked stopped for 3 min: Dangerous rm of /tmp/x',
      'note n-failed to quiet failed: cannot be resumed',
      'spawn broken failed: herdr agent start: exited 1',
    ])
  })

  test('shows the queue with its hold reasons, the accounts with their readings and the notes not yet delivered', async () => {
    await scene()
    const s = await status()
    expect(s.queue.effective).toBe('run')
    expect(s.queue.spawns.map((x) => [x.key, x.status, x.hold])).toEqual([
      ['held', 'queued', 'wave'],
      ['broken', 'failed', null],
    ])
    expect(s.accounts).toHaveLength(1)
    expect(s.accounts[0]).toMatchObject({ account: 'a', weeklyUsed: 40, fiveHourUsed: 100, fresh: true })
    expect(s.notes.map((n) => [n.id, n.status])).toEqual([
      ['n-failed', 'failed'],
      ['n-pending', 'pending'],
    ])
  })

  test('an account name from a hook is kept only if it is a name', async () => {
    await w.emit('good', 'session_started', w.at(5), { account: 'iu' })
    await w.emit('bad', 'session_started', w.at(5), { account: "x'; drop table" })
    const rows = await db.sql`SELECT id, account FROM factory.sessions ORDER BY id`
    expect(rows).toEqual([
      { id: 'bad', account: null },
      { id: 'good', account: 'iu' },
    ])
  })

  test('a walled session whose account is unknown says that the watchdog cannot act', async () => {
    await w.emit('anon', 'session_started', w.at(60), { claudeSessionId: 'c' })
    await w.emit('anon', 'turn_started', w.at(40))
    await w.emit('anon', 'limit_stop', w.at(30))
    expect((await status()).attention).toEqual(['walled anon for 30 min: account unknown, the watchdog cannot act'])
  })

  test('delivered notes and failures older than a day are gone from it', async () => {
    await w.spawned('s')
    await recordPrompt(db.sql, { id: 'old', session: 's', source: 'note', text: 'x', failed: 'gave up' }, w.at(26 * 60))
    await recordPrompt(db.sql, { id: 'done', session: 's', source: 'note', text: 'x' }, clock.now())
    await db.sql`UPDATE factory.prompts SET status = 'delivered' WHERE id = 'done'`
    expect((await status()).notes).toEqual([])
  })
})

describe('the routes', () => {
  test('GET /status needs the token and answers the contract', async () => {
    await w.spawned('s')
    await w.emit('s', 'turn_started', w.at(1))
    expect((await app.bare('/status')).status).toBe(401)
    const res = await app.get('/status')
    expect(res.status).toBe(200)
    expect(((await res.json()) as Status).sessions.map((x) => x.id)).toEqual(['s'])
    expect(((await (await app.get('/status')).json()) as Status).notesMore).toBe(0)
  })

  test('POST /sessions/:id/note records the text under its id: 201, then 200 for the same id; unknown sessions 404; bad text 400', async () => {
    await w.spawned('s')
    const first = await app.send('POST', '/sessions/s/note', { id: 'n1', text: 'look at the test' })
    expect(first.status).toBe(201)
    expect(await first.json()).toMatchObject({ id: 'n1', session: 's', status: 'pending', source: 'note', via: 'type' })
    const again = await app.send('POST', '/sessions/s/note', { id: 'n1', text: 'something else' })
    expect(again.status).toBe(200)
    expect(((await again.json()) as Prompt).text).toBe('look at the test')

    expect((await app.send('POST', '/sessions/nobody/note', { id: 'n2', text: 'x' })).status).toBe(404)
    expect((await app.send('POST', '/sessions/s/note', { id: 'n3', text: '-flag' })).status).toBe(400)
    // A rule's key is not a note's to take: it would keep the rule from firing and type its own text.
    for (const reserved of ['resume:s:2026', 'rotate:s:w', 'blocked:s:1', 'restart:100@x:s']) {
      expect((await app.send('POST', '/sessions/s/note', { id: reserved, text: 'x' })).status).toBe(400)
    }
    expect((await app.send('POST', '/sessions/s/note', { id: 'n3', text: '' })).status).toBe(400)
    expect((await app.send('POST', '/sessions/s/note', { text: 'no id' })).status).toBe(400)
    expect(await db.sql`SELECT id FROM factory.prompts`).toEqual([{ id: 'n1' }])
  })

  test("a note id that is another session's answers 409 and shows nothing of it", async () => {
    await w.spawned('s')
    await w.spawned('t')
    await app.send('POST', '/sessions/s/note', { id: 'private-1', text: 'only for s' })
    const res = await app.send('POST', '/sessions/t/note', { id: 'private-1', text: 'mine' })
    expect(res.status).toBe(409)
    expect(await res.text()).not.toContain('only for s')
  })

  test('POST /spawns takes the parent, and the spawn answers with it', async () => {
    const res = await app.send('POST', '/spawns', { key: 'child', repo: TEST_REPO, prompt: 'work', parent: 'boss' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ key: 'child', parent: 'boss' })
    expect(((await (await app.get('/spawns/child')).json()) as { parent: string }).parent).toBe('boss')
    const orphan = await app.send('POST', '/spawns', { key: 'orphan', repo: TEST_REPO, prompt: 'work' })
    expect(await orphan.json()).toMatchObject({ parent: null })
  })
})

describe('the hooks socket serves notes and the send-back check', () => {
  let dir: string
  let socket: string
  let hooks: ReturnType<typeof serveHooks>
  beforeAll(() => {
    dir = mkdtempSync('/tmp/factory-sock-')
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
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (path: string, body: unknown) =>
    fetch(`http://localhost${path}`, {
      unix: socket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  test('a note through the socket needs no token', async () => {
    await w.spawned('s')
    const res = await post('/sessions/s/note', { id: 'n1', text: 'hello' })
    expect(res.status).toBe(201)
    expect((await post('/sessions/s/note', { id: 'n1', text: 'hello' })).status).toBe(200)
  })

  async function leadWithWorker(endTurn = true) {
    await w.spawned('lead', { role: 'lead' })
    await w.emit('lead', 'turn_started', w.at(10))
    await w.spawned('worker', { parent: 'lead' })
    await w.emit('worker', 'turn_started', w.at(5))
    if (endTurn) await w.emit('lead', 'turn_ended', w.at(1))
  }

  test('a hook cannot report what only the witness sees: a herdr restart, a gone pane', async () => {
    await w.spawned('s')
    const at = '2026-10-30T12:00:00Z'
    const forged = [
      { key: 'f1', session: '_herdr', kind: 'herdr_restarted', at, payload: { to: '999@x' } },
      { key: 'f2', session: 's', kind: 'herdr_restarted', at },
      { key: 'f3', session: 's', kind: 'pane_gone', at },
    ]
    for (const event of forged) {
      expect((await post('/events', event)).status).toBe(400)
      expect((await app.send('POST', '/events', event)).status).toBe(400)
    }
    expect(await db.sql`SELECT key FROM factory.events WHERE key IN ('f1', 'f2', 'f3')`).toEqual([])
  })

  test('stop-check answers the contract: a send-back once, then nothing', async () => {
    await leadWithWorker()
    const first = await post('/sessions/lead/stop-check', { stopHookActive: false })
    expect(await first.json()).toEqual({
      sendBack: true,
      message: '1 worker still running: wait for it (`factory session wait --on workers`) or collect it',
    })
    expect(await (await post('/sessions/lead/stop-check', {})).json()).toEqual({ sendBack: false, message: null })
    expect((await post('/sessions/lead/stop-check', { stopHookActive: 'yes' })).status).toBe(400)
  })

  test('the real hook binary exits 2 with the one line on stderr, once; with the server down it exits 0', async () => {
    await leadWithWorker(false)
    await db.sql`UPDATE factory.sessions SET claude_session_id = 'c-lead' WHERE id = 'lead'`
    const state = async () => ((await (await app.get('/sessions/lead')).json()) as { state: string }).state
    const hook = async (env: Record<string, string>, input: object) => {
      const proc = Bun.spawn(['bun', join(import.meta.dir, '../../cli/bin/factory.ts'), 'hook', 'stop'], {
        env: { ...process.env, FACTORY_SESSION: 'lead', FACTORY_SPOOL_DIR: join(dir, 'spool'), HOME: dir, ...env },
        stdin: new Response(JSON.stringify(input)),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
      return { stdout, stderr, code }
    }
    const sent = await hook({ FACTORY_SOCKET: socket }, { stop_hook_active: false })
    expect(sent).toEqual({
      stdout: '',
      stderr: '1 worker still running: wait for it (`factory session wait --on workers`) or collect it\n',
      code: 2,
    })
    // The send-back is no end: the session is still working, so nothing is typed into it.
    expect(await state()).toBe('working')
    // The turn is answered: the same turn's second stop, the loop guard and a dead server all let the session end.
    expect(await hook({ FACTORY_SOCKET: socket }, { stop_hook_active: false })).toMatchObject({ code: 0, stderr: '' })
    expect(await state()).toBe('idle')
    expect(await hook({ FACTORY_SOCKET: socket }, { stop_hook_active: true })).toMatchObject({ code: 0, stderr: '' })
    expect(await hook({ FACTORY_SOCKET: join(dir, 'nothing.sock') }, { stop_hook_active: false })).toEqual({
      stdout: '',
      stderr: '',
      code: 0,
    })
  })
})
