import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { readState, statePathOf } from '../fakes/hc-state.ts'
import { hitWall, hook, sessionOf, tick } from '../flow.ts'
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

test('a lead whose account is exhausted moves to another open account: the same session starts again there', async () => {
  await lab.accounts([{ id: 'me', five_hour: 30, seven_day: 40 }])
  expect((await lab.cli(['capacity', 'refresh'])).code).toBe(0)
  const issue = await working(lab, REPO, 'the account runs out and another has room')
  const session = sessionOf(issue)
  await hook(lab.world, 'session-start', session, { source: 'startup', session_id: `c-${issue}` })
  await hook(lab.world, 'user-prompt-submit', session, { session_id: `c-${issue}` })
  const account = async () =>
    (await lab.world.db.sql`SELECT account FROM factory.lead_attempts WHERE issue_id = ${issue}`)[0]?.account

  expect(await account()).toBe('me')
  await lab.accounts([
    { id: 'me', five_hour: 100, seven_day: 40 },
    { id: 'other', five_hour: 20, seven_day: 30 },
  ])
  expect((await lab.cli(['capacity', 'refresh'])).code).toBe(0)
  expect((await hitWall(lab.world, issue)).code).toBe(0)
  expect(await state(lab, issue)).toMatchObject({ state: 'waiting', wait: 'wall' })

  expect((await runLoop(lab, 'steward')).summary).toContain('woken 1')
  expect(await state(lab, issue)).toMatchObject({ state: 'working', wait: null })
  const assigned = await lab.world.db.sql`
    SELECT a.account AS assigned, c.account AS claimed FROM factory.capacity_assignments a
    JOIN factory.capacity_claims c ON c.issue_id = a.issue_id WHERE a.issue_id = ${issue}`
  expect(assigned[0]).toMatchObject({ assigned: 'other', claimed: 'other' })

  // the wake is delivered: the session ends on `me` and starts again, `--resume`, on `other`
  expect((await tick(lab)).outbox).toMatchObject({ failed: 0 })
  expect(await account()).toBe('other')
  const terminals = Object.values(readState(statePathOf(join(lab.world.bin, 'calls.jsonl'))).terminals).filter(
    (terminal) => terminal.labels['factory.key'] === session,
  )
  const live = terminals.filter((terminal) => terminal.state === 'live')
  expect(live).toHaveLength(1)
  expect(live[0]?.env.CLAUDE_ACCOUNT_PICKED).toBe('other')
  const resume = live[0]?.argv.indexOf('--resume') ?? -1
  expect(resume).toBeGreaterThan(0)
  expect(live[0]?.argv[resume + 1]).toBe(`c-${issue}`)
  expect(live[0]?.argv.at(-1)).toContain('the lead continues on account other')
}, 90_000)
