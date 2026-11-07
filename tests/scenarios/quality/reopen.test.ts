import { afterAll, beforeAll, expect, test } from 'bun:test'
import { type GitRepo, startGitRepo } from '@software-factory/tests/git-repo'
import { type ServerProcess, startServer, startWorld, type World } from '../harness.ts'
import { MAKEFILE, QUALITY_ENV, reopen, scriptReview, ship, show, stateOf, until, workingIssue } from './support.ts'

const DAY_MS = 24 * 60 * 60_000
const ENV = { ...QUALITY_ENV, FACTORY_WATCH_WINDOW_MS: '100' }

let world: World
let server: ServerProcess
let repo: GitRepo

beforeAll(async () => {
  world = await startWorld()
  server = await startServer(world, { env: ENV })
  repo = await startGitRepo(MAKEFILE)
  await scriptReview(world, 'covered')
})

afterAll(async () => {
  await server.stop()
  await repo.stop()
  await world.stop()
})

/** An Issue that shipped and passed its watch: closed done. */
async function closed(tag: string): Promise<string> {
  const sha = await repo.commit(`src/${tag}.ts`, `export const ${tag} = 1\n`, `feat: ${tag}`)
  const id = await workingIssue(server, repo.path, tag)
  const shipped = await ship(world, server, id, { call: 'ship-1', commits: [sha] })
  expect(shipped.code).toBe(0)
  await until('the Issue to close', async () => (await stateOf(server, id)) === 'closed:done')
  return id
}

test('the owner reopens a closed Issue within the window: it is queued again; the same call is a replay', async () => {
  const id = await closed('first')
  const reopened = await reopen(world, server, id, { call: 'reopen-1', reason: 'it broke again on a phone' })
  expect(reopened.code).toBe(0)
  expect(reopened.json).toMatchObject({ result: 'applied', issue: { id, state: 'queued', outcome: null } })
  expect(await stateOf(server, id)).toBe('queued')

  const again = await reopen(world, server, id, { call: 'reopen-1', reason: 'it broke again on a phone' })
  expect(again.json.result).toBe('replayed')

  const notClosed = await reopen(world, server, id, { call: 'reopen-2', reason: 'again' })
  expect(notClosed.code).toBe(5)
  expect(notClosed.refusal).toContain('it is not closed')
})

test('past 30 days a reopen is refused: file a new Issue; a restarted server does not verify again', async () => {
  const id = await closed('second')
  const before = await show(world, server, id)
  expect(before.watches).toHaveLength(1)
  expect(before.watches[0]?.checks).toHaveLength(1)

  await server.stop()
  server = await startServer(world, { env: { ...ENV, FACTORY_CLOCK_OFFSET_MS: String(31 * DAY_MS) } })

  const late = await reopen(world, server, id, { call: 'reopen-1', reason: 'too late' })
  expect(late.code).toBe(5)
  expect(late.refusal).toContain('closed more than 30 days ago: file a new Issue')
  expect(await stateOf(server, id)).toBe('closed:done')

  await Bun.sleep(600)
  expect(await show(world, server, id)).toEqual(before)
}, 60_000)
