import { afterAll, beforeAll, expect, test } from 'bun:test'
import { type LeadsWorld, startLeadsWorld } from './support.ts'

let w: LeadsWorld
let issue = ''

beforeAll(async () => {
  w = await startLeadsWorld()
  issue = await w.admitted()
  await w.tick()
})

afterAll(async () => {
  await w.stop()
})

async function counts() {
  const [row] = await w.world.db.sql`
    SELECT (SELECT count(*)::int FROM factory.issue_events) AS events,
           (SELECT count(*)::int FROM factory.issue_effects) AS effects,
           (SELECT count(*)::int FROM factory.lead_hook_events) AS hooks,
           (SELECT count(*)::int FROM factory.lead_deliveries) AS deliveries`
  return { ...row, terminals: w.terminals().length, sent: w.terminals().flatMap((t) => t.sent).length }
}

test('replay a tick: the outbox and the hook replay twice; nothing doubles (terminals, notes, events)', async () => {
  await w.hook('session-start', 'lead-1-1', { source: 'startup', session_id: 's-1', transcript_path: '/x/s-1.jsonl' })
  await w.hook('user-prompt-submit', 'lead-1-1', { session_id: 's-1' })
  await w.record(issue, 'note:1', 'noted', { text: 'mind the migration' }, 'owner')
  // The tick reads the spool: the two lines the socket stored already are read, and they are the same events.
  const first = await w.tick()
  expect(first).toMatchObject({ replayed: 2, outbox: { ran: 1 } })
  const once = await counts()
  expect(once).toMatchObject({ hooks: 2, terminals: 1, sent: 1 })

  for (let i = 0; i < 2; i++) {
    const tick = await w.tick()
    expect(tick).toMatchObject({ replayed: 0, outbox: { ran: 0 } })
  }
  for (const key of ['lead-1-1:session_started:0', 'lead-1-1:turn_started:1']) {
    const body = {
      key,
      session: 'lead-1-1',
      kind: key.includes('turn_started') ? 'turn_started' : 'session_started',
      at: new Date().toISOString(),
    }
    const response = await fetch('http://localhost/events', {
      unix: w.socket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(await response.json()).toEqual({ recorded: false, reacted: null })
  }
  expect(await counts()).toEqual(once)
})

test('the socket is mode 0600 and serves hooks only', async () => {
  const { statSync } = await import('node:fs')
  expect(statSync(w.socket).mode & 0o777).toBe(0o600)
  const response = await fetch('http://localhost/issues', { unix: w.socket })
  expect(response.status).toBe(404)
  const gone = await fetch('http://localhost/events', {
    unix: w.socket,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'x', session: 'lead-1-1', kind: 'nonsense', at: new Date().toISOString() }),
  })
  expect(gone.status).toBe(400)
})

test('a hook that could not reach the server lost nothing: the spool has it, and the tick stores it once', async () => {
  const before = await counts()
  const silent = await w.hook(
    'stop',
    'lead-1-1',
    { stop_hook_active: false },
    { FACTORY_SOCKET: '/tmp/no-such-factory.sock' },
  )
  expect(silent).toEqual({ code: 0, out: '', err: '' })
  expect((await counts()).hooks).toBe(before.hooks)
  expect(await w.tick()).toMatchObject({ replayed: 1 })
  expect((await counts()).hooks).toBe(before.hooks + 1)
  await w.tick()
  expect((await counts()).hooks).toBe(before.hooks + 1)
})
