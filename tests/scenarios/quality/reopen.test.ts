import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { type ServerProcess, startServer } from '../harness.ts'
import type { LeadsWorld } from '../leads/support.ts'
import {
  commit,
  QUALITY_ENV,
  reopen,
  scriptReview,
  ship,
  show,
  startQualityWorld,
  stateOf,
  until,
  workingIssue,
} from './support.ts'

// A lead starts through the leads' own tick (a worktree, a terminal) before each Issue ships: more than bun's 5 s default.
setDefaultTimeout(60_000)

const DAY_MS = 24 * 60 * 60_000
const WINDOW = { FACTORY_WATCH_WINDOW_MS: '100' }

let lw: LeadsWorld
let server: ServerProcess
let later: ServerProcess | undefined

beforeAll(async () => {
  lw = await startQualityWorld(WINDOW)
  server = lw.server
  await scriptReview(lw.world, 'covered')
})

afterAll(async () => {
  await later?.stop()
  await lw.stop()
})

/** An Issue that shipped and passed its watch: closed done. */
async function closed(tag: string): Promise<string> {
  const id = await workingIssue(lw, tag)
  const sha = await commit(lw, `src/${tag}.ts`, `export const ${tag} = 1\n`, `feat: ${tag}`)
  const shipped = await ship(lw.world, server, id, { call: 'ship-1', commits: [sha] })
  expect(shipped.code).toBe(0)
  await until('the Issue to close', async () => (await stateOf(server, id)) === 'closed:done')
  return id
}

test('the owner reopens a closed Issue within the window: it is queued again; the same call is a replay', async () => {
  const id = await closed('first')
  const reopened = await reopen(lw.world, server, id, { call: 'reopen-1', reason: 'it broke again on a phone' })
  expect(reopened.code).toBe(0)
  expect(reopened.json).toMatchObject({ result: 'applied', issue: { id, state: 'queued', outcome: null } })
  expect(await stateOf(server, id)).toBe('queued')

  const again = await reopen(lw.world, server, id, { call: 'reopen-1', reason: 'it broke again on a phone' })
  expect(again.json.result).toBe('replayed')

  const notClosed = await reopen(lw.world, server, id, { call: 'reopen-2', reason: 'again' })
  expect(notClosed.code).toBe(5)
  expect(notClosed.refusal).toContain('it is not closed')
})

test('past 30 days a reopen is refused: file a new Issue; a restarted server does not verify again', async () => {
  const id = await closed('second')
  const before = await show(lw.world, server, id)
  expect(before.watches).toHaveLength(1)
  expect(before.watches[0]?.checks).toHaveLength(1)

  await server.stop()
  // The same world and database, a server whose clock is 31 days on.
  later = await startServer(lw.world, {
    env: {
      ...QUALITY_ENV,
      ...WINDOW,
      FACTORY_INTERNAL_TEST_ROUTES: '1',
      FACTORY_REPO_ROOTS: lw.root,
      FACTORY_GRACE_MS: '0',
      FACTORY_CLOCK_OFFSET_MS: String(31 * DAY_MS),
    },
  })
  server = later

  const late = await reopen(lw.world, server, id, { call: 'reopen-1', reason: 'too late' })
  expect(late.code).toBe(5)
  expect(late.refusal).toContain('closed more than 30 days ago: file a new Issue')
  expect(await stateOf(server, id)).toBe('closed:done')

  await Bun.sleep(600)
  expect(await show(lw.world, server, id)).toEqual(before)
}, 60_000)
