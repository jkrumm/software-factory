import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { admit, fileIssue, must, runLoop, settle, tick } from '../flow.ts'
import type { LeadsWorld } from '../leads/support.ts'
import { commit, QUALITY_ENV, ship, show, startQualityWorld, stateOf, until, workingIssue } from '../quality/support.ts'

/**
 * The claim deadlock, against the real server and Postgres: a working or watching Issue is after an Issue of its own
 * repo that stays queued for lack of the only claim, which the holder keeps. One steward pass defers the holder, the
 * blocker is admitted, and the holder wakes when the blocker closes. The edge is the owner's `after`.
 */
setDefaultTimeout(90_000)

let lw: LeadsWorld
const flow = () => ({ world: lw.world, server: lw.server })

beforeAll(async () => {
  lw = await startQualityWorld(
    {
      ...QUALITY_ENV,
      FACTORY_LOOP_STEWARD_MS: '3600000',
      FACTORY_LOOP_PLANNING_MS: '3600000',
      FACTORY_WATCH_WINDOW_MS: '8000',
    },
    { project: 'apiVersion: factory/v2\nname: example\nleads: 1\ndeploy:\n  mode: make\n  hold: 8s\n' },
  )
})

afterAll(async () => {
  await lw.stop()
})

const sql = () => lw.world.db.sql

const edge = (holder: string, blocker: string) =>
  must(flow(), ['planning', 'after', '--body', JSON.stringify({ issue: holder, after: [blocker] })])

const events = async (issue: string) =>
  (await sql()`SELECT kind, actor, payload FROM factory.issue_events WHERE issue_id = ${issue} AND result = 'applied' ORDER BY version`) as {
    kind: string
    actor: string
    payload: Record<string, unknown>
  }[]

const holdsClaim = async (issue: string) =>
  (await sql()`SELECT 1 FROM factory.capacity_claims WHERE issue_id = ${issue}`).length > 0

/** Another Issue of the repo, settled with no edges: with the one claim held, it stays queued for lack of one. */
async function queuedBehind(title: string): Promise<string> {
  const issue = await fileIssue(flow(), { repo: 'example', title })
  await settle(flow(), issue)
  await admit(flow())
  expect((await stateOf(lw.world, issue)).startsWith('queued')).toBe(true)
  return issue
}

/** B is admitted once the holder's dependency wait freed the claim, and closes; the planning pass wakes the holder. */
async function admitThenClose(blocker: string): Promise<void> {
  for (let round = 0; round < 12 && !(await stateOf(lw.world, blocker)).startsWith('working'); round++) {
    await admit(flow())
  }
  expect(await stateOf(lw.world, blocker)).toBe('working')
  await must(flow(), ['issue', 'cancel', blocker, '--reason', 'done for the test'])
  await tick(flow())
  await until('the blocker claim to go', async () => !(await holdsClaim(blocker)))
  await runLoop(flow(), 'planning')
}

test('a watching holder after a queued Issue of its repo is deferred, B is admitted, and the watch runs again when B closes', async () => {
  const holder = await workingIssue(lw, 'holder that shipped')
  const sha = await commit(lw, 'src/holder.ts', 'export const holder = 1\n', 'feat: holder')
  expect((await ship(lw.world, lw.server, holder, { call: 'ship-1', commits: [sha] })).code).toBe(0)
  await until('the first watch to open', async () => (await show(lw.world, lw.server, holder)).watches.length === 1)
  const blocker = await queuedBehind('blocker that waits for the claim')
  await edge(holder, blocker)

  const pass = await runLoop(flow(), 'steward')
  expect(pass.summary).toContain('deferred 1')
  expect(await stateOf(lw.world, holder)).toBe('waiting:dependency')
  const log = await events(holder)
  expect(log.slice(-2).map((e) => `${e.kind}:${e.actor}`)).toEqual(['noted:steward', 'deferred:steward'])
  expect(log.at(-1)?.payload).toMatchObject({ after: [blocker], why: expect.stringContaining('lack of a claim') })

  // The same pass again does nothing twice.
  expect((await runLoop(flow(), 'steward')).summary).toContain('deferred 0')

  await admitThenClose(blocker)
  await until('the holder to wake into its watch', async () => {
    await tick(flow())
    return (await stateOf(lw.world, holder)).startsWith('watching')
  })
  expect((await events(holder)).at(-1)).toMatchObject({ kind: 'woken', actor: 'factory' })
  // A new watch opens, the old one ends, and the new one passes.
  await until('the second watch to open', async () => (await show(lw.world, lw.server, holder)).watches.length === 2)
  await until('the Issue to close', async () => (await stateOf(lw.world, holder)) === 'closed:done')
  const watches = (await show(lw.world, lw.server, holder)).watches
  expect(watches.map((w) => [w.watch, w.answer])).toEqual([
    [1, 'ended'],
    [2, 'passed'],
  ])
})

test('a working holder is deferred and works again when B closes', async () => {
  const holder = await workingIssue(lw, 'holder still at work')
  const blocker = await queuedBehind('second blocker')
  await edge(holder, blocker)

  expect((await runLoop(flow(), 'steward')).summary).toContain('deferred 1')
  expect(await stateOf(lw.world, holder)).toBe('waiting:dependency')
  expect((await events(holder)).at(-1)?.payload).toMatchObject({ after: [blocker] })

  await admitThenClose(blocker)
  await until('the holder to work again', async () => {
    await tick(flow())
    return (await stateOf(lw.world, holder)) === 'working'
  })
  await must(flow(), ['issue', 'cancel', holder, '--reason', 'done for the test'])
  await tick(flow())
})

test('a blocker queued for another reason than a claim defers nothing', async () => {
  const holder = await workingIssue(lw, 'holder with a chained blocker')
  const first = await queuedBehind('queued for the claim')
  // The blocker waits for another Issue of the chain, not for a claim.
  const blocker = await fileIssue(flow(), { repo: 'example', title: 'chain blocked' })
  await settle(flow(), blocker, [first])
  await admit(flow())
  expect((await stateOf(lw.world, blocker)).startsWith('queued')).toBe(true)
  await edge(holder, blocker)

  const pass = await runLoop(flow(), 'steward')
  expect(pass.summary).toContain('deferred 0')
  expect(await stateOf(lw.world, holder)).toBe('working')

  await must(flow(), ['issue', 'cancel', holder, '--reason', 'done for the test'])
  await must(flow(), ['issue', 'cancel', blocker, '--reason', 'done for the test'])
  await must(flow(), ['issue', 'cancel', first, '--reason', 'done for the test'])
  await tick(flow())
})
