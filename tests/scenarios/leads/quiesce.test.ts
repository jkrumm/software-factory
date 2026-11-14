import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { statePathOf, withState } from '../fakes/hc-state.ts'
import { setSessionProcesses } from '../host.ts'
import { type LeadsWorld, startLeadsWorld } from './support.ts'

let w: LeadsWorld
let issue = ''
const SESSION = 'lead-1-1'
const CLAUDE = {
  pid: 4001,
  command: '/usr/local/bin/claude --dangerously-skip-permissions',
  env: [`FACTORY_SESSION=${SESSION}`],
}

beforeAll(async () => {
  w = await startLeadsWorld({ FACTORY_QUIESCE_AFTER_MS: '0' })
  issue = await w.admitted()
  await w.tick()
  await setSessionProcesses(w.world.bin, [CLAUDE])
  // The lead's session ran, ended its turn, and the lead put its Issue to wait.
  await w.hook('session-start', SESSION, { source: 'startup', session_id: 's-1', transcript_path: '/x/s-1.jsonl' })
  await w.hook('user-prompt-submit', SESSION, { session_id: 's-1' })
  const deferred = await w.cli([
    'issue',
    'defer',
    issue,
    '--body',
    JSON.stringify({ attempt: 1, after: ['issue_999'] }),
  ])
  expect(JSON.parse(deferred.out)).toMatchObject({ issue: { state: 'waiting', waitReason: 'dependency' } })
  // It reported, so its stop is a stop: the turn ended and the session idles.
  await w.hook('stop', SESSION, { session_id: 's-1', stop_hook_active: false })
})

afterAll(async () => {
  await w.stop()
})

const lead = () => w.terminals().filter((t) => t.labels['factory.key'] === SESSION)

test('a lead with a process under it is not dormant; a quiet one is, and nothing of it runs', async () => {
  await setSessionProcesses(w.world.bin, [
    CLAUDE,
    { pid: 4002, ppid: 4001, command: '/bin/sleep 600', env: [`FACTORY_SESSION=${SESSION}`] },
  ])
  await w.tick()
  expect(lead().map((t) => t.state)).toEqual(['live'])

  await setSessionProcesses(w.world.bin, [CLAUDE])
  await w.tick()
  expect(lead().map((t) => t.state)).toEqual(['finished'])
  const [row] = await w.world.db.sql`SELECT dormant_at, gone_at FROM factory.lead_attempts WHERE issue_id = ${issue}`
  expect(row?.dormant_at).not.toBeNull()
  expect(row?.gone_at).toBeNull()

  // Dormant is not lost: the Issue stays as it was, however many passes go by.
  await w.tick()
  const [state] = await w.world.db.sql`SELECT state FROM factory.issues WHERE id = ${issue}`
  expect(state?.state).toBe('waiting')
})

test('the wake starts the same session again, with the wake as its first message, once', async () => {
  const woken = await w.note(issue, 'the dependency closed, go on', { wake: true })
  expect(woken.json).toMatchObject({ woken: true })
  const tick = await w.tick()
  expect(tick.outbox).toMatchObject({ failed: 0 })

  const [running, ...rest] = lead()
  expect(rest).toHaveLength(0)
  expect(running?.state).toBe('live')
  // The same key, the same tab, the same session: claude's own transcript carries on from where it ended.
  expect(running?.labels['herdr.tab']).toStartWith('tb-')
  const resume = running?.argv.indexOf('--resume') ?? -1
  expect(resume).toBeGreaterThan(0)
  expect(running?.argv[resume + 1]).toBe('s-1')
  expect(running?.argv.at(-1)).toStartWith('Factory, Issue 1:')
  expect(running?.argv.at(-1)).toContain('the dependency closed, go on')
  expect(running?.env.FACTORY_SESSION).toBe(SESSION)

  const [row] = await w.world.db
    .sql`SELECT dormant_at, revive_tries FROM factory.lead_attempts WHERE issue_id = ${issue}`
  expect(row).toMatchObject({ dormant_at: null, revive_tries: 0 })
  // The note was the program's argument: nothing was typed, and a second pass starts nothing.
  expect(running?.sent).toHaveLength(0)
  await w.tick()
  expect(lead()).toHaveLength(1)
})

test('a resume the core refuses is the lead gone at once, and the next attempt starts', async () => {
  const second = await w.admitted('the second probe')
  await w.tick()
  const key = 'lead-2-1'
  await setSessionProcesses(w.world.bin, [{ pid: 4101, env: [`FACTORY_SESSION=${key}`] }])
  await w.hook('session-start', key, { source: 'startup', session_id: 's-2', transcript_path: '/x/s-2.jsonl' })
  await w.cli(['issue', 'defer', second, '--body', JSON.stringify({ attempt: 1, after: ['issue_999'] })])
  await w.hook('stop', key, { session_id: 's-2', stop_hook_active: false })
  await w.tick()
  expect(
    w
      .terminals()
      .filter((t) => t.labels['factory.key'] === key)
      .map((t) => t.state),
  ).toEqual(['finished'])

  await withState(statePathOf(join(w.world.bin, 'calls.jsonl')), (state) => {
    state.failRun = { kind: 'refused', message: 'no such program' }
  })
  await w.note(second, 'go on', { wake: true })
  await w.tick()
  const gone = await w.world.db
    .sql`SELECT payload->>'detail' AS detail FROM factory.issue_events WHERE issue_id = ${second} AND kind = 'lead_gone'`
  expect(gone).toHaveLength(1)
  expect(gone[0]?.detail).toContain('dormant session could not be resumed')
})
