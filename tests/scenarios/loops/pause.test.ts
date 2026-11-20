import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { block, hook, run, sessionOf } from '../flow.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { eventsOf, runLoop, script, state, working } from './support.ts'

/**
 * The owner pauses an Issue with a wait, not with a note: a paused Issue is not woken, nudged or sent to the Judge by any
 * loop, however many passes run (the idle thresholds are 0, so any quiet lead would count at once), and it resumes on the
 * owner's word or at the time he gave. The 24 hours of passes are as many passes as fit in a test: the loops read the
 * wait, never the clock, so a pass a minute later or a day later takes the same path (`work/pause.test.ts` replays the
 * day on the table).
 */
const REPO = 'software-factory'
let lab: Lab
let dir: string

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-pause-')
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

/** What no loop may do to a paused Issue. */
const passes = async (issue: string, rounds: number) => {
  for (let round = 0; round < rounds; round++) {
    expect((await runLoop(lab, 'steward')).summary).toContain('woken 0')
    await runLoop(lab, 'selfwatch')
    expect((await lab.cli(['planning', 'pass'])).code).toBe(0)
  }
  return eventsOf(lab, issue)
}

const started = async (title: string) => {
  const issue = await working(lab, REPO, title)
  await hook(lab.world, 'session-start', sessionOf(issue), { source: 'startup', session_id: `c-${issue}` })
  await hook(lab.world, 'user-prompt-submit', sessionOf(issue), { session_id: `c-${issue}` })
  return issue
}

test('a paused Issue is left alone by every loop, refuses the lead, and resumes on the owner word', async () => {
  const issue = await started('the owner wants this to wait')
  const paused = await lab.cli(['issue', 'pause', issue, '--reason', 'wait for the release'])
  expect(paused.code).toBe(0)
  expect(await state(lab, issue)).toMatchObject({ state: 'waiting', wait: 'paused' })
  expect(paused.json).toMatchObject({ result: 'applied' })
  const effects = async () =>
    (
      await lab.world.db
        .sql`SELECT count(*)::int AS n FROM factory.issue_effects WHERE issue_id = ${issue} AND kind = 'note_lead'`
    )[0].n as number
  // the lead is told once, at the pause
  expect(await effects()).toBe(1)
  const before = (await eventsOf(lab, issue)).length

  // the lead's block, the thing that used to start the stall loop, is refused and records nothing
  const refused = await run(
    lab,
    ['issue', 'block', issue, '--attempt', '1', '--reason', 'the owner paused it'],
    'agent',
  )
  expect(refused.code).not.toBe(0)
  expect(refused.err).toContain('paused')

  const events = await passes(issue, 6)
  expect(events).toHaveLength(before)
  expect(events.slice(-1)).toEqual([{ kind: 'paused', actor: 'owner' }])
  expect(await effects()).toBe(1)
  expect(await state(lab, issue)).toMatchObject({ state: 'waiting', wait: 'paused' })
  const [asked] = await lab.world.db
    .sql`SELECT count(*)::int AS n FROM factory.issue_events WHERE issue_id = ${issue} AND result = 'applied' AND kind IN ('asked', 'woken', 'deferred', 'stalled')`
  expect(asked.n).toBe(0)

  // a steward's wake is refused by the table; the owner's word ends it, once, and tells the lead
  const resumed = await lab.cli(['issue', 'note', issue, 'go ahead', '--wake'])
  expect(resumed.code).toBe(0)
  expect(await state(lab, issue)).toMatchObject({ state: 'working', wait: null })
  expect((await eventsOf(lab, issue)).slice(-2)).toEqual([
    { kind: 'noted', actor: 'owner' },
    { kind: 'woken', actor: 'owner' },
  ])
}, 120_000)

test('a stalled Issue the owner pauses stops stalling: the steward leaves it alone', async () => {
  const issue = await working(lab, REPO, 'a block the owner turns into a pause')
  await block(lab, issue, 'waiting on the release')
  expect(await state(lab, issue)).toMatchObject({ state: 'waiting', wait: 'blocked' })
  expect((await lab.cli(['issue', 'pause', issue, '--reason', 'the owner holds it'])).code).toBe(0)
  expect(await state(lab, issue)).toMatchObject({ state: 'waiting', wait: 'paused' })
  await passes(issue, 4)
  expect(await state(lab, issue)).toMatchObject({ state: 'waiting', wait: 'paused' })
  expect((await lab.cli(['issue', 'cancel', issue, '--reason', 'done with it'])).code).toBe(0)
}, 120_000)

test('a pause with a time resumes at the time, and an unstarted Issue cannot be paused', async () => {
  const issue = await started('the owner pauses it for a moment')
  const until = new Date(Date.now() + 1500).toISOString()
  expect((await lab.cli(['issue', 'pause', issue, '--reason', 'a short hold', '--until', until])).code).toBe(0)
  expect(await state(lab, issue)).toMatchObject({ state: 'waiting', wait: 'paused' })
  await Bun.sleep(1700)
  expect((await lab.cli(['planning', 'pass'])).code).toBe(0)
  expect(await state(lab, issue)).toMatchObject({ state: 'working', wait: null })
  expect((await eventsOf(lab, issue)).slice(-1)).toEqual([{ kind: 'woken', actor: 'factory' }])

  const filed = await lab.cli(['issue', 'new', '--repo', REPO, '--title', 'not started', '--key', 'pause-unstarted'])
  const unstarted = (filed.json as { issue: string }).issue
  const refused = await lab.cli(['issue', 'pause', unstarted, '--reason', 'too early'])
  expect(refused.code).not.toBe(0)
  expect(refused.err).toContain('no lead has started it')
  await lab.cli(['issue', 'cancel', unstarted, '--reason', 'done'])
  await lab.cli(['issue', 'cancel', issue, '--reason', 'done'])
}, 120_000)
