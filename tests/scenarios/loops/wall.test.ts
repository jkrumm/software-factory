import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { hitWall, hook, sessionOf } from '../flow.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { eventsOf, runLoop, script, state, working } from './support.ts'

/**
 * A lead whose account runs out under it: the Issue stalls as `wall` and waits for the window to reset. Until then the
 * steward neither wakes nor nudges it and self-watch files no `lead_idle`; once a sample after the wall shows the account
 * open again, the lead continues. The idle thresholds are 0 so that any quiet lead would count as idle at once.
 */
const REPO = 'software-factory'
let lab: Lab
let dir: string

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-wall-')
  await script(join(dir, 'steward.json'), [])
  lab = await startLab({
    leads: true,
    repos: { [REPO]: { project: `apiVersion: factory/v2\nname: ${REPO}\nleads: 4\n` } },
    accounts: [{ id: 'me', five_hour: 30, seven_day: 40 }],
    env: {
      FACTORY_LEADS_PER_ACCOUNT: '4',
      FACTORY_STEWARD_MIN_STALL_MS: '0',
      FACTORY_STEWARD_IDLE_MS: '0',
      FACTORY_STEWARD_IDLE_BACKGROUND_MS: '0',
      FACTORY_SELFWATCH_GRACE_MS: '0',
      FACTORY_FAKE_STEWARD_SCRIPT: join(dir, 'steward.json'),
    },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

const noteCount = async (issue: string) => {
  const rows = await lab.world.db
    .sql`SELECT count(*)::int AS n FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'noted' AND result = 'applied'`
  return rows[0].n as number
}
const idleSignals = async () =>
  (
    await lab.world.db
      .sql`SELECT count(*)::int AS n FROM factory.intake_signals WHERE text LIKE 'Self-watch lead_idle (%'`
  )[0].n as number

test('a lead whose account is exhausted waits for the reset: no lead_idle, no nudge, then it continues', async () => {
  const issue = await working(lab, REPO, 'the account runs out under the lead')
  const session = sessionOf(issue)
  await hook(lab.world, 'session-start', session, { source: 'startup', session_id: `c-${issue}` })
  await hook(lab.world, 'user-prompt-submit', session, { session_id: `c-${issue}` })

  // the account's window fills (the picker says 100 %), then the lead hits the wall
  await lab.accounts([{ id: 'me', five_hour: 100, seven_day: 40 }])
  expect((await lab.cli(['capacity', 'refresh'])).code).toBe(0)
  expect((await hitWall(lab.world, issue)).code).toBe(0)
  expect(await state(lab, issue)).toMatchObject({ state: 'waiting', wait: 'wall' })

  for (let pass = 0; pass < 3; pass++) {
    expect((await runLoop(lab, 'steward')).summary).toContain('woken 0')
    await runLoop(lab, 'selfwatch')
  }
  expect(await state(lab, issue)).toMatchObject({ state: 'waiting', wait: 'wall' })
  expect(await noteCount(issue)).toBe(0)
  expect(await idleSignals()).toBe(0)

  // the window resets: the next sample shows the account open, and the lead continues
  await lab.accounts([{ id: 'me', five_hour: 5, seven_day: 40 }])
  expect((await lab.cli(['capacity', 'refresh'])).code).toBe(0)
  expect((await runLoop(lab, 'steward')).summary).toContain('woken 1')
  expect(await state(lab, issue)).toMatchObject({ state: 'working', wait: null })
  expect((await eventsOf(lab, issue)).slice(-1)).toEqual([{ kind: 'woken', actor: 'steward' }])
}, 90_000)
