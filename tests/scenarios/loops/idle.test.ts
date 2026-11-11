import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { hook, must, sessionOf } from '../flow.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { callsOf, eventsOf, runLoop, script, state, working } from './support.ts'

/**
 * A working Issue whose lead went quiet, against the real server and Postgres with the fake agw: the steward nudges it
 * with a note naming the Issue's last event, never while a tool runs, and asks the workflow once the wakes are spent.
 * The idle thresholds are 0 here, so the first pass after a turn ends counts as idle (`idle-background.test.ts` holds the
 * longer one for a lead that waits on background work).
 */
let lab: Lab
let dir: string
let stewardScript: string
let askScript: string

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-idle-')
  stewardScript = join(dir, 'steward.json')
  askScript = join(dir, 'ask.json')
  await Promise.all([script(stewardScript, []), script(askScript, [])])
  lab = await startLab({
    leads: true,
    repos: { app: { project: 'apiVersion: factory/v2\nname: app\nleads: 8\n' } },
    env: {
      FACTORY_LEADS_PER_ACCOUNT: '16',
      FACTORY_STEWARD_MIN_STALL_MS: '0',
      FACTORY_STEWARD_IDLE_MS: '0',
      FACTORY_STEWARD_IDLE_BACKGROUND_MS: '0',
      FACTORY_FAKE_STEWARD_SCRIPT: stewardScript,
      FACTORY_FAKE_ASK_SCRIPT: askScript,
    },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

/** The lead's session starts and its first turn opens, as Claude Code does with the brief. */
async function open(issue: string): Promise<string> {
  const session = sessionOf(issue)
  await hook(lab.world, 'session-start', session, { source: 'startup', session_id: `c-${issue}` })
  await hook(lab.world, 'user-prompt-submit', session, { session_id: `c-${issue}` })
  return session
}

/** The turn ends with a background task still running: the stop is let through and the session reads idle. */
const goQuiet = (session: string) =>
  hook(lab.world, 'stop', session, { stop_hook_active: false, background_tasks: [{ status: 'running' }] })

const idleNotes = async (issue: string): Promise<string[]> => {
  const rows = await lab.world.db
    .sql`SELECT payload->>'text' AS text FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'noted' AND actor = 'steward' AND result = 'applied' ORDER BY version`
  return rows.map((row: { text: string }) => row.text)
}

test('a lead running a tool is never woken, and an idle one is woken with its last event named', async () => {
  const issue = await working(lab, 'app', 'the lead went quiet after a regression')
  const session = await open(issue)

  // mid-turn: the session reads working, whatever the age of the turn
  expect((await runLoop(lab, 'steward')).summary).toContain('woken 0')
  expect(await idleNotes(issue)).toEqual([])

  await must(lab, ['issue', 'note', issue, 'the vendor answered: use the v2 endpoint'])
  await goQuiet(session)
  const ran = await runLoop(lab, 'steward')
  expect(ran.error).toBeNull()
  expect(ran.summary).toContain('woken 1')
  const notes = await idleNotes(issue)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('your session has been idle')
  expect(notes[0]).toContain('The last event on the Issue: v')
  expect(notes[0]).toContain('a note')
  expect(notes[0]).toContain('background work still running')
  expect(await state(lab, issue)).toMatchObject({ state: 'working', wait: null })
  expect(await callsOf(lab, 'factory-steward')).toEqual([])

  // the lead takes the wake: a new turn, and it is not woken again while it works
  await hook(lab.world, 'user-prompt-submit', session, { session_id: 'again' })
  const version = (await state(lab, issue)).version
  await runLoop(lab, 'steward')
  expect((await state(lab, issue)).version).toBe(version)
})

test('after maxWakes the workflow is asked, and an answer that wakes it is another note', async () => {
  const issue = await working(lab, 'app', 'the frozen subagent never answers')
  const session = await open(issue)
  await goQuiet(session)
  await script(stewardScript, [
    {
      match: 'frozen subagent',
      answer: { action: 'wake', note: 'Stop the frozen subagent and go on.', reason: 'idle', decision: null },
    },
  ])

  expect((await runLoop(lab, 'steward')).summary).toContain('woken 1')
  expect((await runLoop(lab, 'steward')).summary).toContain('woken 1')
  expect(await idleNotes(issue)).toHaveLength(2)
  expect(await callsOf(lab, 'factory-steward')).toEqual([])

  const asked = await runLoop(lab, 'steward')
  expect(asked.summary).toContain('asked 1')
  const calls = await callsOf(lab, 'factory-steward')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.input).toMatchObject({ issue, repo: 'app', cause: 'unreported', stewardWakes: 2 })
  const notes = await idleNotes(issue)
  expect(notes).toHaveLength(3)
  expect(notes[2]).toContain('Stop the frozen subagent and go on.')

  // the answer's note is recorded once: two wakes, one answer
  const kinds = (await eventsOf(lab, issue)).map((event) => event.kind)
  expect(kinds.filter((kind) => kind === 'noted')).toHaveLength(3)
})

const DECISION = {
  action: 'raise_decision',
  note: '',
  reason: 'the choice is not the steward’s',
  decision: {
    question: 'Should the quiet lead be given more time?',
    recommendation: 'try again',
    checked: 'The history shows two wakes and no report.',
    options: [
      { label: 'try again', reversible: true, cost: 'the lead is woken and may go quiet again' },
      { label: 'drop', reversible: true, cost: 'the work is not done; it can be filed again' },
    ],
    noAnswer: { consequence: 'the Issue stays stalled', default: null, waitMinutes: null },
  },
}

test('a quiet lead is never turned into a stall or a Decision: the answer that asks for one is dropped', async () => {
  const issue = await working(lab, 'app', 'the glorp lead goes quiet')
  const session = await open(issue)
  await script(stewardScript, [{ match: 'glorp', answer: DECISION }])
  await goQuiet(session)

  for (let wake = 0; wake < 2; wake++) await runLoop(lab, 'steward')
  for (let pass = 0; pass < 2; pass++) {
    const ran = await runLoop(lab, 'steward')
    expect(ran.error).toBeNull()
    expect(ran.summary).toContain('Decisions 0')
  }
  expect(await state(lab, issue)).toMatchObject({ state: 'working', wait: null })
  // the workflow was asked once, and nothing but the two wakes came of it
  expect((await callsOf(lab, 'factory-steward')).filter((call) => call.input.issue === issue)).toHaveLength(1)
  expect(await idleNotes(issue)).toHaveLength(2)
  const kinds = (await eventsOf(lab, issue)).map((event) => event.kind)
  expect(kinds).not.toContain('stalled')
  expect(kinds).not.toContain('asked')
})

test('a lead that deferred before going quiet is not nudged', async () => {
  const issue = await working(lab, 'app', 'reported before going quiet')
  const session = await open(issue)
  await must(lab, [
    'issue',
    'defer',
    issue,
    '--body',
    JSON.stringify({ attempt: 1, until: new Date(Date.now() + 3_600_000).toISOString() }),
  ])
  await goQuiet(session)
  await runLoop(lab, 'steward')
  expect(await idleNotes(issue)).toEqual([])
})
