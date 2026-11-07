import { afterAll, beforeAll, expect, test } from 'bun:test'
import { type LeadsWorld, startLeadsWorld } from './support.ts'

let w: LeadsWorld

beforeAll(async () => {
  w = await startLeadsWorld()
})

afterAll(async () => {
  await w.stop()
})

const state = async (issue: string) => {
  const [row] = await w.world.db.sql`SELECT state, wait_reason FROM factory.issues WHERE id = ${issue}`
  return row
}

/** Admits an Issue, starts its lead and opens its first turn, as Claude Code does with the brief. */
async function working(): Promise<{ issue: string; session: string; n: number }> {
  const issue = await w.admitted()
  await w.tick()
  const n = Number(issue.replace('issue_', ''))
  const session = `lead-${n}-1`
  await w.hook('session-start', session, { source: 'startup', session_id: `c-${n}` })
  await w.hook('user-prompt-submit', session, { session_id: `c-${n}` })
  return { issue, session, n }
}

test('a stop with nothing reported is sent back once; the next stalls the Issue as unreported; a new turn ends the stall', async () => {
  const { issue, session } = await working()

  const first = await w.hook('stop', session, { stop_hook_active: false })
  expect(first.code).toBe(2)
  expect(first.out).toBe('')
  expect(first.err).toContain('you stopped with nothing reported')

  // The stop that was sent back is no end: the session still reads working.
  expect(JSON.parse((await w.cli(['lead', 'get', issue])).out)).toMatchObject({ state: 'working' })
  expect(await state(issue)).toEqual({ state: 'working', wait_reason: null })

  const second = await w.hook('stop', session, { stop_hook_active: true })
  expect(second).toEqual({ code: 0, out: '', err: '' })
  expect(await state(issue)).toEqual({ state: 'waiting', wait_reason: 'unreported' })

  // The same stop asked again records nothing more.
  await w.hook('stop', session, { stop_hook_active: true })
  const stalled = await w.world.db
    .sql`SELECT 1 FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'stalled' AND result = 'applied'`
  expect(stalled).toHaveLength(1)

  // The lead's next turn (a note, the steward, the owner typing) ends the stall by itself.
  await w.hook('user-prompt-submit', session, { session_id: 'again' })
  expect(await state(issue)).toEqual({ state: 'working', wait_reason: null })
})

test('a stop after a report, with background work, or in a turn the owner started is let through', async () => {
  const reported = await working()
  await w.cli([
    'issue',
    'defer',
    reported.issue,
    '--body',
    JSON.stringify({ attempt: 1, until: new Date(Date.now() + 3_600_000).toISOString() }),
  ])
  expect((await w.hook('stop', reported.session, { stop_hook_active: false })).code).toBe(0)

  const background = await working()
  const withTask = await w.hook('stop', background.session, {
    stop_hook_active: false,
    background_tasks: [{ status: 'running' }],
  })
  expect(withTask.code).toBe(0)
  expect(await state(background.issue)).toEqual({ state: 'working', wait_reason: null })

  // The owner types into the pane: that turn follows the factory's first one and no note was typed before it.
  const owner = await working()
  await w.hook('stop', owner.session, { stop_hook_active: false }) // sent back once for turn 1
  await w.hook('stop', owner.session, { stop_hook_active: true }) // stalls
  await w.hook('user-prompt-submit', owner.session, { session_id: 'owner' }) // woken, turn 2: the owner's
  expect((await w.hook('stop', owner.session, { stop_hook_active: false })).code).toBe(0)
  expect(await state(owner.issue)).toEqual({ state: 'working', wait_reason: null })
})
