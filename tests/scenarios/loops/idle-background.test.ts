import { afterAll, beforeAll, expect, test } from 'bun:test'
import { hook, sessionOf } from '../flow.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { eventsOf, runLoop, state, working } from './support.ts'

/**
 * A lead whose turn ended with background work in flight (a subagent, a check) is waiting, not quiet: the Stop hook lists the
 * work, the session reads it, and the steward does not nudge it on the short threshold. The short threshold is 0 here and the
 * background one an hour, so a nudge could only come from counting the wait as idle.
 */
let lab: Lab

beforeAll(async () => {
  lab = await startLab({
    leads: true,
    repos: { app: { project: 'apiVersion: factory/v2\nname: app\nleads: 8\n' } },
    env: {
      FACTORY_LEADS_PER_ACCOUNT: '16',
      FACTORY_STEWARD_MIN_STALL_MS: '0',
      FACTORY_STEWARD_IDLE_MS: '0',
      FACTORY_STEWARD_IDLE_BACKGROUND_MS: '3600000',
    },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(() => lab.stop())

test('a lead waiting on a subagent or a check is not nudged, however many passes run', async () => {
  const issue = await working(lab, 'app', 'the lead waits on its implementer')
  const session = sessionOf(issue)
  await hook(lab.world, 'session-start', session, { source: 'startup', session_id: 'c-bg' })
  await hook(lab.world, 'user-prompt-submit', session, { session_id: 'c-bg' })
  await hook(lab.world, 'stop', session, {
    stop_hook_active: false,
    background_tasks: [{ status: 'running' }],
  })

  const version = (await state(lab, issue)).version
  for (let pass = 0; pass < 3; pass++) {
    const ran = await runLoop(lab, 'steward')
    expect(ran.error).toBeNull()
    expect(ran.summary).toContain('woken 0')
    expect(ran.summary).toContain('1 quiet')
  }
  expect((await state(lab, issue)).version).toBe(version)
  expect((await eventsOf(lab, issue)).filter((event) => event.actor === 'steward')).toEqual([])
})
