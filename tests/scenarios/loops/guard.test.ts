import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Lab, startLab } from '../planning/lab.ts'
import { blocked, callsOf, loops, runLoop, script, state } from './support.ts'

/**
 * The loop guard and the pending path, against the real server with the steward's clock on (an hour, so it never fires
 * by itself in a test) and the fake agw answering "still running" until `agw run wait` is asked, as the real CLI does when its
 * wait budget is spent.
 */
let lab: Lab
let dir: string

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-loops-guard-')
  await script(join(dir, 'steward.json'), [
    { match: 'guard test', answer: { action: 'wake', note: 'Carry on.', reason: 'the cause is gone', decision: null } },
  ])
  lab = await startLab({
    leads: true,
    repos: { app: { project: 'apiVersion: factory/v2\nname: app\nleads: 8\n' } },
    env: {
      FACTORY_LOOP_STEWARD_MS: '3600000',
      FACTORY_STEWARD_MIN_STALL_MS: '0',
      FACTORY_FAKE_STEWARD_SCRIPT: join(dir, 'steward.json'),
      FACTORY_FAKE_PENDING: '1',
    },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

test('a loop’s own note never fires that loop again; a pending run is waited for through agw run wait', async () => {
  const issue = await blocked(lab, 'app', 'guard test: needs a nudge', 'stuck on something unclear')
  const ran = await runLoop(lab, 'steward')
  expect(ran.error).toBeNull()
  // the fake answered "pending" first: the adapter went on to `agw run wait`, and the answer came
  expect(await state(lab, issue)).toMatchObject({ state: 'working' })
  const calls = await callsOf(lab, 'factory-steward')
  expect(calls).toHaveLength(1)
  const waited = (await lab.world.calls()).filter((call) => call.args[0] === 'run' && call.args[1] === 'wait')
  expect(waited).toHaveLength(1)

  // the pass changed an Issue and told the runner; the steward was the maker, so its kick was dropped, not run
  await Bun.sleep(300)
  const steward = (await loops(lab)).find((loop) => loop.name === 'steward')
  expect(steward).toMatchObject({ intervalMs: 3_600_000, runs: 1, kicks: 0, droppedKicks: 1 })
  expect(await callsOf(lab, 'factory-steward')).toHaveLength(1)
})
