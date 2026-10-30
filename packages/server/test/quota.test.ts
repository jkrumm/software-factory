import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QuotaList } from '@software-factory/contract'
import { HerdrRunner } from '../src/runner.ts'
import { ClaudeAccountSource, POLL_EVERY_MS, QuotaError, QuotaPoller } from '../src/quota.ts'
import { tick } from '../src/tick.ts'
import { startApp, type TestApp } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHerdr, type FakeHerdr } from './support/herdr.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { type FakeQuotaSource, usage } from './support/quota.ts'

/** What `claude-account usage --json` prints (shape read from the live picker; extra fields included on purpose). */
const PICKER_OUTPUT = {
  default_account: 'iu',
  accounts: [
    {
      id: 'iu',
      plan: 'max20x',
      enabled: true,
      five_hour: 2,
      seven_day: 44,
      five_hour_resets_at: 1793383200,
      seven_day_resets_at: 1793808000,
      age_s: 82,
      five_hour_age_s: 82,
      seven_day_age_s: 82,
      source: 'statusline',
      auth_ok: true,
      exhausted_until: null,
    },
    {
      id: 'me2',
      plan: 'max5x',
      enabled: false,
      five_hour: null,
      seven_day: null,
      five_hour_resets_at: null,
      seven_day_resets_at: null,
      age_s: null,
      five_hour_age_s: null,
      seven_day_age_s: null,
      source: null,
      auth_ok: false,
      exhausted_until: 1793383300,
    },
  ],
}

let db: TestDb
let herdr: FakeHerdr
let app: TestApp
const dir = mkdtempSync('/tmp/factory-picker-')
let clock: FakeClock
let source: FakeQuotaSource

beforeAll(async () => {
  db = await startTestDb()
  herdr = await createFakeHerdr()
})
afterAll(async () => {
  await app?.stop()
  await herdr.cleanup()
  await db.stop()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  await db.reset()
  await herdr.reset()
  await app?.stop()
  clock = new FakeClock()
  app = startApp({ sql: db.sql, clock })
  source = app.quotaSource
})

const readingsOf = async () =>
  db.sql`SELECT account, five_hour_used, weekly_used FROM factory.quota_readings ORDER BY id`

/** A stand-in for `claude-account`: a shell script that prints `body` (or runs `script`) whatever it is asked. */
function picker(name: string, script: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${script}\n`)
  chmodSync(path, 0o755)
  return path
}
const printing = (name: string, body: unknown) => picker(name, `cat <<'JSON'\n${JSON.stringify(body)}\nJSON`)

describe('the claude-account adapter', () => {
  test('reads `usage --json` into readings; the accounts are whatever the picker lists', async () => {
    const readings = await new ClaudeAccountSource({ bin: printing('ok', PICKER_OUTPUT) }).read()
    expect(readings).toEqual([
      {
        account: 'iu',
        enabled: true,
        authOk: true,
        fiveHourUsed: 2,
        weeklyUsed: 44,
        fiveHourResetsAt: new Date(1793383200 * 1000),
        weeklyResetsAt: new Date(1793808000 * 1000),
        exhaustedUntil: null,
        ageS: 82,
      },
      {
        account: 'me2',
        enabled: false,
        authOk: false,
        fiveHourUsed: null,
        weeklyUsed: null,
        fiveHourResetsAt: null,
        weeklyResetsAt: null,
        exhaustedUntil: new Date(1793383300 * 1000),
        ageS: null,
      },
    ])
  })

  test('is called with `usage --json`', async () => {
    const args = join(dir, 'args.txt')
    const bin = picker('args', `echo "$@" > ${args}\necho '{"accounts":[]}'`)
    expect(await new ClaudeAccountSource({ bin }).read()).toEqual([])
    expect((await Bun.file(args).text()).trim()).toBe('usage --json')
  })

  test.each([
    ['a failing picker', picker('fails', 'exit 3'), /exited 3/],
    ['output that is not JSON', picker('prose', "echo 'iu max20x 5h 2%'"), /expected shape/],
    [
      'a shape without auth_ok',
      printing('drift', { accounts: [{ ...PICKER_OUTPUT.accounts[0], auth_ok: undefined }] }),
      /expected shape/,
    ],
    [
      'an account name that is not a name',
      printing('name', { accounts: [{ ...PICKER_OUTPUT.accounts[0], id: '../x' }] }),
      /expected shape/,
    ],
    ['a picker that is not there', join(dir, 'missing'), /cannot execute/],
  ])('%s is a QuotaError', async (_name, bin, message) => {
    const error = await new ClaudeAccountSource({ bin }).read().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(QuotaError)
    expect((error as Error).message).toMatch(message)
  })

  test('a picker that hangs is killed at the process timeout', async () => {
    const started = Date.now()
    const error = await new ClaudeAccountSource({ bin: picker('hangs', 'sleep 30'), timeoutMs: 200 })
      .read()
      .catch((e: unknown) => e)
    expect((error as Error).message).toMatch(/did not answer within 200 ms/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('the poller', () => {
  test('stores one row per account and poll, and the sample time is the read time minus the sample age', async () => {
    const resets = new Date(clock.now().getTime() + 3_600_000)
    source.readings = [
      { account: 'a', ...usage(10, 20, resets, { ageS: 90 }) },
      { account: 'b', ...usage(30, 40, resets, { ageS: null }) },
    ]
    await new QuotaPoller({ sql: db.sql, source, clock }).poll()
    expect(await readingsOf()).toEqual([
      { account: 'a', five_hour_used: 20, weekly_used: 10 },
      { account: 'b', five_hour_used: 40, weekly_used: 30 },
    ])
    const [row] = await db.sql`SELECT sampled_at FROM factory.quota_readings WHERE account = 'a'`
    expect(row.sampled_at).toEqual(new Date(clock.now().getTime() - 90_000))
  })

  test('the tick polls at most once a minute; a failed attempt counts, and a failure is an error, not a crash', async () => {
    const poller = new QuotaPoller({ sql: db.sql, source, clock })
    source.readings = [{ account: 'a', ...usage(1, 1, new Date(clock.now().getTime() + 3_600_000)) }]
    await poller.pollIfDue()
    await poller.pollIfDue()
    expect(source.reads).toBe(1)

    clock.advance(POLL_EVERY_MS - 1)
    await poller.pollIfDue()
    expect(source.reads).toBe(1)
    clock.advance(1)
    await poller.pollIfDue()
    expect(source.reads).toBe(2)
    expect(await readingsOf()).toHaveLength(2)

    // The source breaks: the first try throws, the next pass inside the minute does not try again.
    clock.advance(POLL_EVERY_MS)
    source.failure = new QuotaError('picker down')
    await expect(poller.pollIfDue()).rejects.toThrow('picker down')
    await poller.pollIfDue()
    expect(source.reads).toBe(3)
  })

  test('readings older than a week are deleted, the newest of each account is kept', async () => {
    const resets = new Date(clock.now().getTime() + 3_600_000)
    const poller = new QuotaPoller({ sql: db.sql, source, clock })
    source.readings = [
      { account: 'a', ...usage(1, 1, resets) },
      { account: 'gone', ...usage(2, 2, resets) },
    ]
    await poller.poll()
    clock.advance(8 * 24 * 3_600_000)
    source.readings = [{ account: 'a', ...usage(3, 3, resets) }]
    await poller.poll()
    // a's first row is old and not its newest; gone's only row is old but is the newest of its account.
    expect(await readingsOf()).toEqual([
      { account: 'gone', five_hour_used: 2, weekly_used: 2 },
      { account: 'a', five_hour_used: 3, weekly_used: 3 },
    ])
  })

  test('overlapping polls share one read, so an older sample never lands after a newer one', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const resets = new Date(clock.now().getTime() + 3_600_000)
    const slow = {
      reads: 0,
      async read() {
        slow.reads++
        await gate
        return [{ account: 'a', ...usage(1, 1, resets) }]
      },
    }
    const poller = new QuotaPoller({ sql: db.sql, source: slow, clock })
    const first = poller.poll()
    const second = poller.poll()
    release()
    await Promise.all([first, second])
    expect(slow.reads).toBe(1)
    expect(await readingsOf()).toHaveLength(1)
    await poller.poll()
    expect(slow.reads).toBe(2)
  })

  test("the previous release's table is fed too, with the readings it can hold", async () => {
    const resets = new Date(clock.now().getTime() + 3_600_000)
    source.readings = [
      { account: 'a', ...usage(10, 20, resets) },
      { account: 'b', ...usage(null, null, resets) },
    ]
    await new QuotaPoller({ sql: db.sql, source, clock }).poll()
    const rows = await db.sql`SELECT account, weekly_used, five_hour_used FROM factory.capacity_readings`
    expect(rows).toEqual([{ account: 'a', weekly_used: 10, five_hour_used: 20 }])
  })

  test('a tick whose poll fails reports it in its errors and still starts what has capacity', async () => {
    source.failure = new QuotaError('picker down')
    const runner = new HerdrRunner({
      bin: herdr.bin,
      clock,
      pretrustBin: herdr.pretrustBin,
      accountsFile: herdr.accountsFile,
      home: '/home/me',
      deliverWaitMs: 3_000,
    })
    const quota = new QuotaPoller({ sql: db.sql, source, clock })
    expect(await tick({ sql: db.sql, runner, clock, quota })).toMatchObject({
      started: [],
      errors: ['quota poll: picker down'],
    })
  })
})

describe('GET /quota and POST /quota/refresh', () => {
  test('the newest reading of each account, fresh while the poller keeps renewing it', async () => {
    const resets = new Date(clock.now().getTime() + 3_600_000)
    source.readings = [{ account: 'a', ...usage(10, 20, resets, { ageS: 30 }) }]
    const refreshed = await app.send('POST', '/quota/refresh', {})
    expect(refreshed.status).toBe(200)

    const { quota } = QuotaList.parse(await (await app.get('/quota')).json())
    expect(quota).toEqual([
      {
        account: 'a',
        enabled: true,
        authOk: true,
        fiveHourUsed: 20,
        weeklyUsed: 10,
        fiveHourResetsAt: resets.toISOString(),
        weeklyResetsAt: resets.toISOString(),
        exhaustedUntil: null,
        sampledAt: new Date(clock.now().getTime() - 30_000).toISOString(),
        readAt: clock.now().toISOString(),
        fresh: true,
      },
    ])

    clock.advance(11 * 60_000)
    expect(QuotaList.parse(await (await app.get('/quota')).json()).quota[0]?.fresh).toBe(false)
  })

  test('only the newest of an account is listed', async () => {
    const resets = new Date(clock.now().getTime() + 3_600_000)
    source.readings = [{ account: 'a', ...usage(10, 20, resets) }]
    await app.send('POST', '/quota/refresh', {})
    source.readings = [{ account: 'a', ...usage(11, 21, resets) }]
    await app.send('POST', '/quota/refresh', {})
    expect(QuotaList.parse(await (await app.get('/quota')).json()).quota.map((q) => q.weeklyUsed)).toEqual([11])
  })

  test('a picker that fails is a 502 with its reason, and stores nothing', async () => {
    source.failure = new QuotaError('picker down')
    const res = await app.send('POST', '/quota/refresh', {})
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'picker down' })
    expect(await readingsOf()).toEqual([])
  })

  test('an account the picker lists later is an account: nothing in the server names one', async () => {
    const resets = new Date(clock.now().getTime() + 3_600_000)
    source.readings = [{ account: 'a', ...usage(10, 20, resets) }]
    await app.send('POST', '/quota/refresh', {})
    source.readings = [
      { account: 'a', ...usage(10, 20, resets) },
      { account: 'fourth', ...usage(1, 1, resets) },
    ]
    await app.send('POST', '/quota/refresh', {})
    expect(QuotaList.parse(await (await app.get('/quota')).json()).quota.map((q) => q.account)).toEqual(['a', 'fourth'])
  })
})
