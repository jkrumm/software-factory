import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { IssueAnswerAck, Notification, NotificationList } from '@software-factory/contract'
import { serveHooks } from '../src/http.ts'
import { createIssue } from '../src/issues/create.ts'
import { enqueue } from '../src/issues/inbox.ts'
import { getIssue } from '../src/issues/read.ts'
import { issuePass } from '../src/issues/worker.ts'
import { notifyPass } from '../src/notify/index.ts'
import { startApp, TEST_REPO, TEST_ROLES, TEST_ROOT, TEST_TOKEN, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { FakeNotifier } from './support/notifier.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

const CLI = join(import.meta.dir, '..', '..', 'cli', 'bin', 'factory.ts')

let db: TestDb
let app: TestApp
let dir: string
let socket: string
let hooks: ReturnType<typeof serveHooks>
let notifier: FakeNotifier
const clock = new FakeClock(new Date('2026-11-02T10:00:00.000Z'))
let n = 0

beforeAll(async () => {
  db = await startTestDb()
  notifier = new FakeNotifier()
  app = startApp({ sql: db.sql, clock, notifier, notifyTarget: 'slack:#agents' })
  dir = mkdtempSync('/tmp/factory-notify-')
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
beforeEach(async () => {
  await db.reset()
  notifier.recover()
  notifier.sent = []
  notifier.calls = 0
  n = 0
})

const now = () => clock.now()
const pass = () => issuePass(db.sql, { now, ports: {} })

/** An Issue that is working and asks a question; the pass has handled the ask. */
async function asked(): Promise<number> {
  const { issue } = await createIssue(
    db.sql,
    { source: 'request', sourceKey: `k${++n}`, repo: TEST_REPO, title: 't', facts: {} },
    { repoRoots: [TEST_ROOT], now: now() },
  )
  for (const [kind, payload] of [['admitted'], ['ask', { question: 'which one?' }]] as const) {
    await enqueue(db.sql, { issueId: issue.id, key: `${issue.id}:${kind}:${++n}`, kind, at: now(), payload })
    expect(await pass()).toEqual([])
  }
  return issue.id
}

const viaSocket = (path: string, payload: unknown) =>
  fetch(`http://localhost${path}`, {
    unix: socket,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

describe('POST /issues/:id/answer', () => {
  test('the owner answers: the Issue works again, the question is answered, the lead is to be told', async () => {
    const id = await asked()
    const res = await app.send('POST', `/issues/${id}/answer`, { answer: 'the first', id: 'a1' })
    expect(res.status).toBe(201)
    const ack = IssueAnswerAck.parse(await res.json())
    expect(ack).toEqual({ issue: id, key: `${id}:answer:a1`, duplicate: false, state: 'waiting' })
    expect(await pass()).toEqual([])
    await pass()
    expect((await getIssue(db.sql, id))?.state).toBe('working')
    const [decision] = await db.sql`SELECT answer, answered_by FROM factory.decisions WHERE issue_id = ${id}`
    expect(decision).toEqual({ answer: 'the first', answered_by: 'owner' })
    const [effect] = await db.sql`SELECT kind, payload FROM factory.issue_effects WHERE kind = 'note_lead'`
    expect(effect?.payload).toMatchObject({ cause: 'wake', for: 'claim', answer: 'the first' })
    // the same call again is one answer
    const again = await app.send('POST', `/issues/${id}/answer`, { answer: 'the first', id: 'a1' })
    expect(again.status).toBe(200)
    expect(IssueAnswerAck.parse(await again.json()).duplicate).toBe(true)
  })

  test('it names its question, and an answer for a question that is answered already is refused in the Issue events', async () => {
    const id = await asked()
    await app.send('POST', `/issues/${id}/answer`, { answer: 'x', decision: 1, id: 'a1' })
    await pass()
    await app.send('POST', `/issues/${id}/answer`, { answer: 'late', decision: 1, id: 'a2' })
    await pass()
    const refused = await db.sql`SELECT payload FROM factory.issue_events WHERE issue_id = ${id} AND kind = 'refused'`
    expect(refused).toHaveLength(1)
  })

  test('unknown Issue 404, bad id 400, empty answer or a stray field 400, no token 401', async () => {
    expect((await app.send('POST', '/issues/99/answer', { answer: 'x' })).status).toBe(404)
    expect((await app.send('POST', '/issues/abc/answer', { answer: 'x' })).status).toBe(400)
    const id = await asked()
    expect((await app.send('POST', `/issues/${id}/answer`, { answer: ' ' })).status).toBe(400)
    expect((await app.send('POST', `/issues/${id}/answer`, { answer: 'x', state: 'closed' })).status).toBe(400)
    const bare = await app.bare(`/issues/${id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'x' }),
    })
    expect(bare.status).toBe(401)
  })

  test('an answer that names no question is for the one open when it was given', async () => {
    const id = await asked()
    await app.send('POST', `/issues/${id}/answer`, { answer: 'for the first', id: 'a1' })
    // before the tick handles it, the lead (impossibly, but the order of events is the database's) asks again
    const [row] = await db.sql`SELECT payload FROM factory.issue_inbox WHERE key = ${`${id}:answer:a1`}`
    expect(row?.payload).toMatchObject({ answer: 'for the first', decision: 1 })
  })

  test('with no question open there is nothing to answer (409), and a repeated call is still a duplicate', async () => {
    const { issue } = await createIssue(
      db.sql,
      { source: 'request', sourceKey: 'none', repo: TEST_REPO, title: 't', facts: {} },
      { repoRoots: [TEST_ROOT], now: now() },
    )
    expect((await app.send('POST', `/issues/${issue.id}/answer`, { answer: 'x' })).status).toBe(409)
    const id = await asked()
    expect((await app.send('POST', `/issues/${id}/answer`, { answer: 'x', id: 'r1' })).status).toBe(201)
    await pass()
    expect((await app.send('POST', `/issues/${id}/answer`, { answer: 'x', id: 'r1' })).status).toBe(200)
  })

  test('the socket does not answer: a pane, a lead among them, cannot answer its own question', async () => {
    const id = await asked()
    const res = await viaSocket(`/issues/${id}/answer`, { answer: 'from a pane' })
    expect([404, 405]).toContain(res.status)
    await pass()
    const [decision] = await db.sql`SELECT answer FROM factory.decisions WHERE issue_id = ${id}`
    expect(decision?.answer).toBeNull()
    expect((await getIssue(db.sql, id))?.state).toBe('waiting')
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind = 'answer'`).toHaveLength(0)
  })

  test('a session field is not part of the body', async () => {
    const id = await asked()
    expect((await app.send('POST', `/issues/${id}/answer`, { answer: 'x', session: 's' })).status).toBe(400)
  })
})

describe('notifications', () => {
  test('GET /notifications lists newest first, ?pending=1 only what is not sent', async () => {
    await asked()
    await asked()
    expect(NotificationList.parse(await (await app.get('/notifications')).json()).notifications).toHaveLength(2)
    expect(await notifyPass(db.sql, { notifier, target: 'x', digestAt: null, digestTz: 'UTC' }, now)).toEqual([])
    const pending = NotificationList.parse(await (await app.get('/notifications?pending=1')).json())
    expect(pending.notifications).toEqual([])
    const all = NotificationList.parse(await (await app.get('/notifications')).json())
    expect(all.notifications.map((x) => x.status)).toEqual(['sent', 'sent'])
  })

  test('POST /notifications/test sends one line through the live path and answers with the row', async () => {
    const res = await app.send('POST', '/notifications/test', {})
    expect(res.status).toBe(200)
    const row = Notification.parse(await res.json())
    expect(row).toMatchObject({ kind: 'test', status: 'sent', attempts: 1 })
    expect(notifier.sent).toEqual(["Factory test: the owner's line works."])
  })

  test('with the target off a test says so', async () => {
    const off = startApp({ sql: db.sql, clock, notifier: new FakeNotifier(), notifyTarget: 'off' })
    const row = Notification.parse(await (await off.send('POST', '/notifications/test', {})).json())
    expect(row).toMatchObject({ status: 'sent', error: 'notifications are off (FACTORY_NOTIFY_TARGET=off)' })
    await off.stop()
  })

  test('a test that does not arrive says why and stays pending for the tick to retry', async () => {
    notifier.failWith('hermes send exited 1')
    const row = Notification.parse(await (await app.send('POST', '/notifications/test', {})).json())
    expect(row).toMatchObject({ status: 'pending', error: 'hermes send exited 1' })
  })
})

describe('factory issue answer, factory notify', () => {
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

  test('the line an ask sends is the command that answers it', async () => {
    const id = await asked()
    const [row] = await db.sql`SELECT text FROM factory.notifications`
    expect(row?.text).toContain(`factory issue answer ${id} "<text>" --decision 1`)
    const done = await factory(['issue', 'answer', String(id), 'the second one', '--decision', '1', '--id', 'c1'])
    expect(done.code).toBe(0)
    expect(IssueAnswerAck.parse(JSON.parse(done.stdout))).toMatchObject({ issue: id, key: `${id}:answer:c1` })
    await pass()
    await pass()
    expect((await getIssue(db.sql, id))?.state).toBe('working')
    const [decision] = await db.sql`SELECT answer FROM factory.decisions WHERE issue_id = ${id}`
    expect(decision?.answer).toBe('the second one')
  })

  test('usage mistakes are exit 2, an unknown Issue 4; without the token it says so (exit 3), socket or not', async () => {
    const id = await asked()
    expect((await factory(['issue', 'answer', String(id)])).code).toBe(2)
    expect((await factory(['issue', 'answer', 'x', 'text'])).code).toBe(2)
    expect((await factory(['issue', 'answer', String(id), 'text', '--decision', 'one'])).code).toBe(2)
    expect((await factory(['issue', 'answer', '99', 'text'])).code).toBe(4)
    const bare = await factory(['issue', 'answer', String(id), 'no token'], {
      FACTORY_TOKEN: '',
      FACTORY_SESSION: `lead-${id}-1`,
    })
    expect(bare.code).toBe(3)
    expect(bare.stderr).toContain('needs FACTORY_TOKEN')
    expect(await db.sql`SELECT 1 FROM factory.issue_inbox WHERE kind = 'answer'`).toHaveLength(0)
  })

  test('notify list and notify test', async () => {
    await asked()
    const listed = await factory(['notify', 'list', '--pending', '--format', 'plain'])
    expect(listed.code).toBe(0)
    expect(listed.stdout.split('\t').slice(1, 3)).toEqual(['ask', 'pending'])
    const ok = await factory(['notify', 'test'])
    expect(ok.code).toBe(0)
    expect(Notification.parse(JSON.parse(ok.stdout)).status).toBe('sent')
    notifier.failWith('hermes send exited 1')
    const bad = await factory(['notify', 'test'])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('not delivered')
    expect(Notification.parse(JSON.parse(bad.stdout)).status).toBe('pending')
  })
})
