import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readState, statePathOf, withState, type FakeTerminal } from '../fakes/hc-state.ts'
import { hook, must, sessionOf, tick } from '../flow.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { working } from '../loops/support.ts'

/**
 * A note for a lead whose hooks say its turn ended, while herdr-core's status reads something that is no prompt (issue
 * 1190: a resumed session read busy for a day), against the real server and Postgres with the fake hc. The screen decides:
 * an empty input box takes the note with the core's override, a dialog gets nothing.
 */
setDefaultTimeout(120_000)

let lab: Lab
let dir: string
const RULE = '─'.repeat(60)

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-noteidle-')
  lab = await startLab({
    leads: true,
    repos: { app: { project: 'apiVersion: factory/v2\nname: app\nleads: 8\n' } },
    // the hooks' word counts after 0 ms here, where it is 5 minutes in production
    env: { FACTORY_LEADS_PER_ACCOUNT: '16', FACTORY_FORCE_NOTE_MS: '0' },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

const statePath = () => statePathOf(join(lab.world.bin, 'calls.jsonl'))
const terminalOf = (session: string): FakeTerminal => {
  const found = Object.values(readState(statePath()).terminals).find(
    (terminal) => terminal.state === 'live' && terminal.labels['factory.key'] === session,
  )
  if (!found) throw new Error(`no live terminal ${session}`)
  return found
}

/** The lead's turn opened and ended with nothing running; the core's status is `blocked` and the screen is what is given. */
async function quietWith(issue: string, screen: string): Promise<string> {
  const session = sessionOf(issue)
  await hook(lab.world, 'session-start', session, { source: 'startup', session_id: `c-${issue}` })
  await hook(lab.world, 'user-prompt-submit', session, { session_id: `c-${issue}` })
  // a stop with nothing reported is sent back; one with background work in flight is let through and ends the turn
  await hook(lab.world, 'stop', session, { stop_hook_active: false, background_tasks: [{ status: 'running' }] })
  const { address } = terminalOf(session)
  await withState(statePath(), (state) => {
    const terminal = state.terminals[address]
    if (!terminal) throw new Error('terminal vanished')
    terminal.status = { state: 'blocked' }
    terminal.screen = screen
    terminal.sent = []
    terminal.forced = []
  })
  return session
}

test('a lead the hooks call idle, at an empty input box the core calls blocked, hears the note with the override', async () => {
  const issue = await working(lab, 'app', 'the core reads blocked at an empty prompt')
  const session = await quietWith(issue, ['⏺ Done with the step', '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n'))
  await must(lab, ['issue', 'note', issue, 'the answer is staging'])
  await tick(lab)
  const terminal = terminalOf(session)
  expect(terminal.sent).toHaveLength(1)
  expect(terminal.sent[0]).toContain('the answer is staging')
  expect(terminal.forced).toEqual([0])
})

test('a dialog on the screen gets nothing typed, whatever the hooks say', async () => {
  const issue = await working(lab, 'app', 'the core reads blocked at a dialog')
  const session = await quietWith(
    issue,
    ['⏺ Run this command?', RULE, '❯ 1. Yes', '  2. No', RULE, '  Esc to cancel'].join('\n'),
  )
  await must(lab, ['issue', 'note', issue, 'the answer is production'])
  await tick(lab)
  expect(terminalOf(session).sent).toEqual([])
})
