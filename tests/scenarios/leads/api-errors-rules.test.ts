import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readState, statePathOf, withState } from '../fakes/hc-state.ts'
import { hook, sessionOf } from '../flow.ts'
import { runLoop, working } from '../loops/support.ts'
import { type Lab, startLab } from '../planning/lab.ts'

/**
 * The resume rules are the settings' (`FACTORY_API_RESUME_MS`), and the steward reads the same ones: with two resumes
 * configured, a lead that failed twice is a quiet lead again, not a session the API-error path still owns.
 */
setDefaultTimeout(120_000)

let lab: Lab
let dir: string

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-apierr-rules-')
  await mkdir(join(dir, 'config', 'projects'), { recursive: true })
  lab = await startLab({
    leads: true,
    repos: { app: { project: 'apiVersion: factory/v2\nname: app\nleads: 8\n' } },
    env: {
      FACTORY_LEADS_PER_ACCOUNT: '16',
      FACTORY_STEWARD_MIN_STALL_MS: '0',
      FACTORY_STEWARD_IDLE_MS: '0',
      FACTORY_STEWARD_IDLE_BACKGROUND_MS: '0',
      FACTORY_API_RESUME_MS: '0,0',
    },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

test('with two resumes configured, the steward takes the lead back once both are spent', async () => {
  const issue = await working(lab, 'app', 'the edge is down for a while')
  const session = sessionOf(issue)
  await hook(lab.world, 'session-start', session, { source: 'startup', session_id: 'c-1' })
  await hook(lab.world, 'user-prompt-submit', session, { session_id: 'c-1' })
  const path = statePathOf(join(lab.world.bin, 'calls.jsonl'))
  const { address } = Object.values(readState(path).terminals).find((t) => t.labels['factory.key'] === session) ?? {
    address: '',
  }
  const line = 'Please run /login · API Error: 403 Attention Required! | Cloudflare'
  await withState(path, (state) => {
    const terminal = state.terminals[address]
    if (!terminal) throw new Error('no terminal')
    terminal.status = { state: 'blocked' }
    terminal.screen = ['⏺ working', '', `⏺ ${line}`, '', '─'.repeat(50), '❯ ', '─'.repeat(50)].join('\n')
  })
  await hook(lab.world, 'stop-failure', session, { error: 'authentication_failed', last_assistant_message: line })

  // the path owns it while a resume is left: the steward is silent
  expect((await runLoop(lab, 'leads')).summary).toContain('"resumed":1')
  expect((await runLoop(lab, 'steward')).summary).toContain('woken 0')
  expect((await runLoop(lab, 'leads')).summary).toContain('"resumed":1')
  // both spent: nothing more is typed, and the lead is a quiet one again
  expect((await runLoop(lab, 'leads')).summary).toContain('"resumed":0')
  expect(Object.values(readState(path).terminals).find((t) => t.address === address)?.sent).toHaveLength(2)
  expect((await runLoop(lab, 'steward')).summary).toContain('woken 1')
})
