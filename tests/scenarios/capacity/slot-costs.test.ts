import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type Lab, startLab } from '../planning/lab.ts'

/** The cost ledger of `factory slot run` and the grant rule that follows free memory: two base slots, never more. */
let lab: Lab

beforeAll(async () => {
  lab = await startLab({
    repos: { app: { project: 'apiVersion: factory/v2\nname: app\nslots: { run: 1m }\n' } },
    env: { FACTORY_SLOTS: '2', FACTORY_SLOTS_MAX: '2' },
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

/** Runs two named callers at once; returns the highest number of granted rows seen and the order the commands ran in. */
async function race(first: string, second: string) {
  const order = join(lab.root, `order-${first}-${second}`)
  const script = (word: string) => `echo start-${word} >> ${order}; sleep 1; echo end-${word} >> ${order}`
  const a = lab.cli(['slot', 'run', '--name', first, '--', 'sh', '-c', script('a')], env)
  for (let i = 0; i < 60 && (await granted()) === 0; i++) await Bun.sleep(50)
  const b = lab.cli(['slot', 'run', '--name', second, '--', 'sh', '-c', script('b')], env)
  let most = 0
  const results: Promise<unknown>[] = [a, b]
  let done = false
  void Promise.all(results).then(() => {
    done = true
  })
  while (!done) {
    most = Math.max(most, await granted())
    await Bun.sleep(40)
  }
  return {
    most,
    lines: (await Bun.file(order).text()).trim().split('\n'),
    codes: (await Promise.all([a, b])).map((r) => r.code),
  }
}

test('two steps that would not fit together do not overlap although a second slot is free', async () => {
  await learn('heavy', 18_000)
  const { most, lines, codes } = await race('heavy', 'heavy')
  expect(codes).toEqual([0, 0])
  expect(most).toBe(1)
  expect(lines).toEqual(['start-a', 'end-a', 'start-b', 'end-b'])
}, 30_000)

test('a step with a small learned peak runs beside a heavy one', async () => {
  await learn('light', 100)
  const { most, lines } = await race('heavy', 'light')
  expect(most).toBe(2)
  expect(lines.slice(0, 2).sort()).toEqual(['start-a', 'start-b'])
}, 30_000)

test('a waiter says why it waits', async () => {
  const holder = lab.cli(['slot', 'run', '--name', 'heavy', '--', 'sleep', '2'], env)
  for (let i = 0; i < 60 && (await granted()) === 0; i++) await Bun.sleep(50)
  const waiter = await lab.cli(['slot', 'run', '--name', 'heavy', '--', 'true'], {
    ...env,
    FACTORY_SLOT_WAIT_MS: '400',
  })
  expect(waiter.err).toContain('queued for a test slot (waiting for memory: needs 17.6 GiB')
  await holder
}, 30_000)

test('a finished step leaves a row in the ledger with its duration, wait, size and cpu', async () => {
  const result = await lab.cli(['slot', 'run', '--name', 'ledgered', '--', 'sh', '-c', 'sleep 1; exit 3'], env)
  expect(result.code).toBe(3)
  const rows = await sql()`
    SELECT name, repo, peak_rss_mib, cpu_seconds, duration_ms, wait_ms, exit_code, cwd
    FROM factory.step_costs WHERE name = 'ledgered'`
  expect(rows).toHaveLength(1)
  const row = rows[0]
  expect(Number(row.duration_ms)).toBeGreaterThanOrEqual(900)
  expect(Number(row.wait_ms)).toBeGreaterThanOrEqual(0)
  expect(row.peak_rss_mib).not.toBeNull()
  expect(row.cpu_seconds).not.toBeNull()
  expect(row.exit_code).toBe(3)
  // the directory the step ran in: what ties it to a lead's worktree
  expect(typeof row.cwd).toBe('string')
}, 30_000)

test('a finished merge-lock call leaves a row with when it asked, got the window and gave it back', async () => {
  const locks = { FACTORY_DEPLOY_LOCK_DIR: join(lab.root, 'locks') }
  const result = await lab.cli(['merge-lock', '--project', 'app', '--', 'sh', '-c', 'sleep 1; exit 2'], locks)
  expect(result.code).toBe(2)
  const rows = await sql()`
    SELECT project, cwd, requested_at, acquired_at, released_at, exit_code FROM factory.merge_windows`
  expect(rows).toHaveLength(1)
  const row = rows[0]
  expect([row.project, row.exit_code, typeof row.cwd]).toEqual(['app', 2, 'string'])
  expect(row.acquired_at.getTime()).toBeGreaterThanOrEqual(row.requested_at.getTime())
  expect(row.released_at.getTime() - row.acquired_at.getTime()).toBeGreaterThanOrEqual(900)
}, 30_000)

test('a nested pass-through records nothing', async () => {
  const result = await lab.cli(['slot', 'run', '--name', 'nested', '--', 'true'], { ...env, FACTORY_SLOT_ACTIVE: '1' })
  expect(result.code).toBe(0)
  expect(await sql()`SELECT 1 FROM factory.step_costs WHERE name = 'nested'`).toHaveLength(0)
})

test('the JUnit a step leaves in FACTORY_JUNIT_DIR is stored with its cost; a step with none stores no results', async () => {
  const xml =
    '<testsuites><testsuite name="a.test.ts"><testcase name="ok" classname="" time="0.5"/>' +
    '<testcase name="bad" time="0.1"><failure message="x"/></testcase>' +
    '<testcase name="later"><skipped/></testcase></testsuite></testsuites>'
  const written = join(lab.root, 'unit.xml')
  await Bun.write(written, xml)
  const result = await lab.cli(
    ['slot', 'run', '--name', 'with-junit', '--', 'sh', '-c', `cp ${written} "$FACTORY_JUNIT_DIR/unit.xml"; exit 1`],
    env,
  )
  expect(result.code).toBe(1)
  const rows = await sql()`
    SELECT t.test_suite_name AS suite, t.test_case_name AS name, t.test_case_result_status AS status, t.duration_ms,
      t.step_cost_id = c.id AS linked
    FROM factory.test_results t JOIN factory.step_costs c ON c.id = t.step_cost_id
    WHERE c.name = 'with-junit' ORDER BY t.id`
  expect(
    rows.map((r: Record<string, unknown>) => [r.suite, r.name, r.status, Number(r.duration_ms), r.linked]),
  ).toEqual([
    ['a.test.ts', 'ok', 'pass', 500, true],
    ['a.test.ts', 'bad', 'fail', 100, true],
    ['a.test.ts', 'later', 'skip', 0, true],
  ])
  await lab.cli(['slot', 'run', '--name', 'no-junit', '--', 'true'], env)
  expect(
    await sql()`SELECT 1 FROM factory.test_results t JOIN factory.step_costs c ON c.id = t.step_cost_id WHERE c.name = 'no-junit'`,
  ).toHaveLength(0)
}, 30_000)
