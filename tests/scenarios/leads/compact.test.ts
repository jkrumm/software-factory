import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type LeadsWorld, startLeadsWorld } from './support.ts'

let w: LeadsWorld

beforeAll(async () => {
  w = await startLeadsWorld()
  await w.admitted()
  await w.tick()
})

afterAll(async () => {
  await w.stop()
})

const SESSION = 'lead-1-1'
const LINE =
  "Context was compacted. Re-read Issue 1 with `factory issue show issue_1` and your brief's standing orders before acting.\n"

test('compact: a session-start with source compact prints the one line; every other hook prints nothing', async () => {
  const compact = await w.hook('session-start', SESSION, {
    source: 'compact',
    session_id: 'c-1',
    transcript_path: '/x/c-1.jsonl',
  })
  expect(compact).toEqual({ code: 0, out: LINE, err: '' })

  const silent: [string, Record<string, unknown>][] = [
    ['session-start', { source: 'startup', session_id: 'c-1' }],
    ['session-start', { source: 'resume', session_id: 'c-1' }],
    ['user-prompt-submit', { session_id: 'c-1', prompt: 'secret words' }],
    ['stop', { stop_hook_active: false }],
    ['stop-failure', { error: 'rate_limit' }],
    ['notification', { notification_type: 'idle_prompt' }],
    ['session-end', { reason: 'other' }],
  ]
  for (const [event, input] of silent) {
    const out = await w.hook(event, SESSION, input)
    expect({ event, ...out }).toMatchObject({ event, out: '' })
  }
})

test('a session that is no lead gets no line, and without FACTORY_SESSION the hook does nothing', async () => {
  expect(await w.hook('session-start', 'rd-agent', { source: 'compact' })).toEqual({ code: 0, out: '', err: '' })
  const none = await w.hook('session-start', '', { source: 'compact' })
  expect(none).toEqual({ code: 0, out: '', err: '' })
})

test('the hooks spooled first and the server derived the session from them', async () => {
  const spooled = readFileSync(join(w.spool, 'lead-1-1.jsonl'), 'utf8').trim().split('\n')
  expect(spooled.length).toBeGreaterThanOrEqual(7)
  expect(JSON.parse(spooled[0] ?? '')).toMatchObject({
    session: SESSION,
    kind: 'session_started',
    key: 'lead-1-1:session_started:0',
  })
  // The last event of the sequence above was session-end; the compact start came first.
  const lead = await w.cli(['lead', 'get', 'issue_1'])
  expect(JSON.parse(lead.out)).toMatchObject({ state: 'gone', turns: 1 })
})
