import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CapacityView, Slot } from '@software-factory/contract'
import { bearer } from '../harness.ts'
import { type Lab, startLab } from '../planning/lab.ts'

/** `factory slot run`: a lease on the host's test slots from the real server, with the contract's exits. */
let lab: Lab

beforeAll(async () => {
  lab = await startLab({
    repos: { app: { project: 'apiVersion: factory/v2\nname: app\nslots: { run: 1m }\n' } },
    env: { FACTORY_SLOTS: '1' },
  })
  await lab.cli(['project', 'sync'])
})

afterAll(async () => {
  await lab.stop()
})

const slotRows = () => lab.world.db.sql`SELECT id, name, slot FROM factory.capacity_slots ORDER BY requested_at`
const env = { FACTORY_SLOT_POLL_MS: '50' }

test("a command runs in a slot, the slot is leased while it runs and freed when it ends; the exit code is the command's", async () => {
  const marker = join(lab.root, 'ran')
  const running = lab.cli(['slot', 'run', '--name', 'first', '--', 'sh', '-c', `touch ${marker}; sleep 1; exit 3`], env)
  // while it runs, the slot is held
  let held: Awaited<ReturnType<typeof slotRows>> = []
  for (let i = 0; i < 40 && held.length === 0; i++) {
    await Bun.sleep(50)
    held = await slotRows()
  }
  expect(held.map((r: { name: string; slot: number }) => [r.name, r.slot])).toEqual([['first', 1]])
  const capacity = CapacityView.parse((await lab.cli(['capacity', 'get'])).json)
  expect(capacity.slots).toMatchObject({ total: 1, held: [{ slot: 1, name: 'first' }], waiting: [] })

  const result = await running
  expect(result.code).toBe(3)
  expect(existsSync(marker)).toBe(true)
  expect(await slotRows()).toEqual([])
})

test('a caller that cannot get a slot within its wait exits 75 without running the command', async () => {
  const marker = join(lab.root, 'never')
  const holder = lab.cli(['slot', 'run', '--name', 'holder', '--', 'sleep', '2'], env)
  for (let i = 0; i < 40 && (await slotRows()).length === 0; i++) await Bun.sleep(50)

  const waited = await lab.cli(['slot', 'run', '--name', 'late', '--', 'touch', marker], {
    ...env,
    FACTORY_SLOT_WAIT_MS: '400',
  })
  expect(waited.code).toBe(75)
  expect(waited.err).toContain('no test slot within 0s; not running')
  expect(existsSync(marker)).toBe(false)
  // the caller that gave up left the line
  expect((await slotRows()).map((r: { name: string }) => r.name)).toEqual(['holder'])

  // with FACTORY_SLOT_OPEN=1 the same wait runs the command anyway
  const open = await lab.cli(['slot', 'run', '--', 'touch', marker], {
    ...env,
    FACTORY_SLOT_WAIT_MS: '300',
    FACTORY_SLOT_OPEN: '1',
  })
  expect(open.code).toBe(0)
  expect(existsSync(marker)).toBe(true)

  expect((await holder).code).toBe(0)
  expect(await slotRows()).toEqual([])
})

test('the second caller takes the slot when the first gives it back', async () => {
  const order = join(lab.root, 'order')
  const first = lab.cli(['slot', 'run', '--name', 'one', '--', 'sh', '-c', `echo one >> ${order}; sleep 1`], env)
  for (let i = 0; i < 40 && (await slotRows()).length === 0; i++) await Bun.sleep(50)
  const second = lab.cli(['slot', 'run', '--name', 'two', '--', 'sh', '-c', `echo two >> ${order}`], env)
  expect([(await first).code, (await second).code]).toEqual([0, 0])
  expect((await Bun.file(order).text()).trim().split('\n')).toEqual(['one', 'two'])
})

test("a command past its run limit is killed and the exit is 124; the limit is the project's slots.run or FACTORY_SLOT_RUN_MS", async () => {
  const started = Date.now()
  const result = await lab.cli(['slot', 'run', '--', 'sleep', '30'], {
    ...env,
    FACTORY_SLOT_RUN_MS: '300',
    FACTORY_SLOT_KILL_GRACE_MS: '200',
  })
  expect(result.code).toBe(124)
  expect(result.err).toContain('ran past the test-slot run limit of 300 ms')
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(await slotRows()).toEqual([])

  // from a directory of a project, the server resolves its slots.run (1m here) at the grant
  const put = async (cwd: string | undefined) => {
    const response = await fetch(`${lab.server.url}/slots/resolve-${cwd ? 'project' : 'none'}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...bearer() },
      body: JSON.stringify({ name: 'probe', ...(cwd ? { cwd } : {}) }),
    })
    const slot = Slot.parse(await response.json())
    await fetch(`${lab.server.url}/slots/resolve-${cwd ? 'project' : 'none'}`, { method: 'DELETE', headers: bearer() })
    return slot
  }
  expect((await put(join(lab.root, 'app'))).runMs).toBe(60_000)
  expect((await put(join(lab.root, 'app', '.claude', 'worktrees', 'x'))).runMs).toBe(60_000)
  expect((await put(undefined)).runMs).toBe(30 * 60_000)
})

test('with the server down the command runs anyway, with one line on stderr', async () => {
  const marker = join(lab.root, 'open')
  const result = await lab.cli(['slot', 'run', '--', 'touch', marker], { ...env, FACTORY_URL: 'http://127.0.0.1:1' })
  expect(result.code).toBe(0)
  expect(result.err).toContain('no test slot')
  expect(result.err).toContain('running without one')
  expect(existsSync(marker)).toBe(true)
})

test('a command that does not exist exits 127; a missing command is a usage error', async () => {
  expect((await lab.cli(['slot', 'run', '--', 'definitely-not-a-program-xyz'], env)).code).toBe(127)
  expect((await lab.cli(['slot', 'run'], env)).code).toBe(2)
  expect((await lab.cli(['slot', 'run', '--name'], env)).code).toBe(2)
  expect(await slotRows()).toEqual([])
})
