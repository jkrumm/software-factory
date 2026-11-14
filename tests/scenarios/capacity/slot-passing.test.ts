import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type Lab, startLab } from '../planning/lab.ts'

/** The slot line with six mixed callers: small steps pass a big one that does not fit and finish while it waits for memory. */
let lab: Lab

beforeAll(async () => {
  lab = await startLab({
    repos: { app: { project: 'apiVersion: factory/v2\nname: app\nslots: { run: 1m }\n' } },
    env: { FACTORY_SLOTS: '2', FACTORY_SLOTS_MAX: '6' },
  })
  await lab.cli(['project', 'sync'])
  // a host sample exists: the fake host shows about 11 GiB in use of 32 GiB
  expect((await lab.cli(['loop', 'run', 'host'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
})

const env = { FACTORY_SLOT_POLL_MS: '50', FACTORY_SLOT_ACTIVE: '' }
const sql = () => lab.world.db.sql
const granted = async (): Promise<number> => {
  const [row] = await sql()`SELECT count(*)::int AS n FROM factory.capacity_slots WHERE slot IS NOT NULL`
  return row.n
}
const learn = async (name: string, peak: number) => {
  await sql()`
    INSERT INTO factory.step_costs (at, name, peak_rss_mib, cpu_seconds, duration_ms, wait_ms, exit_code)
    VALUES (now(), ${name}, ${peak}, 1, 1000, 0, 0)`
}

test('four small steps behind a big one that waits for memory run and finish before it', async () => {
  await learn('heavy', 18_000)
  await learn('light', 100)
  const order = join(lab.root, 'order')
  const script = (word: string, seconds: number) =>
    `echo start-${word} >> ${order}; sleep ${seconds}; echo end-${word} >> ${order}`

  // the first heavy step runs; the second does not fit beside it
  const first = lab.cli(['slot', 'run', '--name', 'heavy', '--', 'sh', '-c', script('heavy1', 4)], env)
  for (let i = 0; i < 60 && (await granted()) === 0; i++) await Bun.sleep(50)
  const second = lab.cli(['slot', 'run', '--name', 'heavy', '--', 'sh', '-c', script('heavy2', 1)], env)
  for (let i = 0; i < 60 && !(await sql()`SELECT 1 FROM factory.capacity_slots WHERE slot IS NULL`).length; i++)
    await Bun.sleep(50)
  const smalls = [1, 2, 3, 4].map((n) =>
    lab.cli(['slot', 'run', '--name', 'light', '--', 'sh', '-c', script(`light${n}`, 1)], env),
  )
  const codes = (await Promise.all([first, second, ...smalls])).map((r) => r.code)
  expect(codes).toEqual([0, 0, 0, 0, 0, 0])

  const lines = (await Bun.file(order).text()).trim().split('\n')
  const at = (line: string) => lines.indexOf(line)
  for (const n of [1, 2, 3, 4]) {
    expect(at(`end-light${n}`)).toBeGreaterThan(-1)
    expect(at(`end-light${n}`)).toBeLessThan(at('start-heavy2'))
  }
  expect(at('start-heavy2')).toBeGreaterThan(at('end-heavy1'))
}, 60_000)
