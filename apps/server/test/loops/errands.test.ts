import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ErrandNeededAnswer } from '@software-factory/contract'
import { startTestCluster, type TestCluster } from '@software-factory/tests/pg'
import { postgresCheckpointStore } from '../../src/adapters/postgres/checkpoint-store.ts'
import { loadMigrations, migrate } from '../../src/adapters/postgres/migrate.ts'
import { postgresUnitOfWork } from '../../src/adapters/postgres/unit-of-work.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import { finishErrand, requestErrand, type CheckpointDeps } from '../../src/app/checkpoints.ts'
import { errandsPass, errandsSummary } from '../../src/app/loops/errands.ts'
import type { CheckRunner, ErrandNeededPort } from '../../src/domains/checkpoints/ports.ts'
import type { CheckRun } from '../../src/domains/checkpoints/request.ts'
import { type FixedClock, fixedClock } from '../../src/kernel/clock.ts'
import { sequentialIds } from '../../src/kernel/ids.ts'
import { err, ok, portError, type Result } from '../../src/kernel/result.ts'
import { needsModel, readNeeds } from '../../src/read/needs.ts'
import { readSince } from '../../src/read/since.ts'

/**
 * The `errands` loop over a real Postgres: a request's check closes it or keeps it, an expiry closes it, a key replaces an
 * older request, and a request with no check is read by the still-needed workflow. Every closure shows once in the band
 * "Errands closed without you". The ports (the shell, the workflow) are fakes that assert they are never called inside a
 * transaction.
 */
let db: TestCluster
const clock: FixedClock = fixedClock('2026-11-13T08:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
let deps: CheckpointDeps
let checks: Record<string, CheckRun>
let checkCalls: string[]
let needed: (id: string) => Result<ErrandNeededAnswer>
let neededCalls: { id: string; evidence: string }[]

const runner: CheckRunner = {
  run: (command) => {
    expect(deps.uow.inTransaction()).toBe(false)
    checkCalls.push(command)
    return Promise.resolve(checks[command] ?? { exit: 0, timedOut: false, output: '' })
  },
}
const judge: ErrandNeededPort = {
  judge: (request) => {
    expect(deps.uow.inTransaction()).toBe(false)
    neededCalls.push({ id: request.errand.id, evidence: request.evidence })
    return Promise.resolve(needed(request.errand.id))
  },
}

beforeAll(async () => {
  db = await startTestCluster()
})
afterAll(() => db.stop())

beforeEach(async () => {
  await db.sql`DROP SCHEMA IF EXISTS factory CASCADE`
  await migrate(db.sql, await loadMigrations())
  clock.set(new Date('2026-11-13T08:00:00Z'))
  checks = {}
  checkCalls = []
  neededCalls = []
  needed = () => ok({ verdict: 'needed', reason: 'it still stands' })
  const uow = postgresUnitOfWork(db.sql, (tx) => ({
    work: postgresWorkStore(tx),
    checkpoints: postgresCheckpointStore(tx),
  }))
  deps = {
    uow,
    clock,
    ids: sequentialIds(),
    blobs: { put: async () => err(portError('unreadable', 'x')), get: async () => err(portError('unreadable', 'x')) },
    consoleUrl: 'https://console.example.test',
  }
})

const value = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}
const request = async (raw: Record<string, unknown>) =>
  value(await requestErrand(deps, { raw: { source: 'ask-human', ...raw } }))
const pass = async () => value(await errandsPass({ uow: deps.uow, clock, checks: runner, needed: judge }))
const errandRow = async (id: string) => (await db.sql`SELECT * FROM factory.errands WHERE id = ${id}`)[0]
const since = async (at: Date) => (await readSince(db.sql, { now: clock.now(), since: at })).categories.errands

describe('a request', () => {
  test('is an Errand with no Issue that reaches the owner at once, with its command and where the hands must be', async () => {
    const made = await request({ text: 'Reseal the cache on the MacBook', command: 'make secrets-seed', key: 'reseal' })
    expect(made).toMatchObject({ result: 'applied', superseded: [] })
    expect(made.errand).toMatchObject({
      issueId: null,
      attempt: null,
      source: 'ask-human',
      command: 'make secrets-seed',
      host: 'macbook',
      reachedOwnerAt: clock.now(),
    })
    // the read token never sees a request's words: it may be about a work repo
    const read = needsModel(await readNeeds(db.sql, clock.now()), { redact: true })
    expect(read.items[0]).toMatchObject({ kind: 'errand', redacted: true, command: null })
    expect(read.items[0]?.title).not.toContain('Reseal')
    const needs = needsModel(await readNeeds(db.sql, clock.now()), { redact: false })
    expect(needs.items).toEqual([
      expect.objectContaining({
        kind: 'errand',
        id: made.errand.id,
        issue: null,
        repo: null,
        title: 'Reseal the cache on the MacBook',
        command: 'make secrets-seed',
        host: 'macbook',
        source: 'ask-human',
        redacted: false,
      }),
    ])
  })

  test('the same request again is a replay; the same key with other words replaces the open one', async () => {
    const first = await request({ text: 'Reseal the cache', key: 'reseal' })
    expect(await request({ text: 'Reseal the cache', key: 'reseal' })).toMatchObject({
      result: 'replayed',
      errand: { id: first.errand.id },
    })
    const second = await request({ text: 'Reseal the cache and the token', key: 'reseal' })
    expect(second.superseded).toEqual([first.errand.id])
    expect(await errandRow(first.errand.id)).toMatchObject({ closed_kind: 'superseded', closed_by: 'request' })
    const needs = needsModel(await readNeeds(db.sql, clock.now()), { redact: false })
    expect(needs.items.map((item) => item.id)).toEqual([second.errand.id])
    // the band says so, once
    const band = await since(new Date(clock.now().getTime() - HOUR))
    expect(band.items.map((item) => item.title)).toEqual(['Reseal the cache (replaced by a newer request)'])
  })

  test('asked again after it was closed is a new Errand', async () => {
    const first = await request({ text: 'Reseal the cache', key: 'reseal' })
    value(await finishErrand(deps, { errandId: first.errand.id, note: 'done' }))
    const again = await request({ text: 'Reseal the cache', key: 'reseal' })
    expect(again.result).toBe('applied')
    expect(again.errand.id).not.toBe(first.errand.id)
  })

  test('a bad one names every field and stores nothing', async () => {
    const bad = await requestErrand(deps, { raw: { text: '', source: 'A B' } })
    expect(bad).toMatchObject({ ok: false, error: { kind: 'missing_field' } })
    expect(await db.sql`SELECT 1 FROM factory.errands`).toHaveLength(0)
  })

  test('the owner can close it as not needed', async () => {
    const made = await request({ text: 'Add the topics' })
    const done = value(
      await finishErrand(deps, { errandId: made.errand.id, note: 'moved to the phone', outcome: 'not_needed' }),
    )
    expect(done.errand).toMatchObject({ closedKind: 'not_needed', closedBy: 'owner' })
    expect(done.issue).toBeNull()
    // his own closure is not a closure "without him"
    expect((await since(new Date(clock.now().getTime() - HOUR))).count).toBe(0)
  })
})

describe('the check', () => {
  test('exit 1 closes the request as no longer needed, with the output, and the band lists it once', async () => {
    const made = await request({ text: 'Re-run the deploy gate', check: 'gate-held' })
    checks['gate-held'] = { exit: 1, timedOut: false, output: 'no_mr: the commit is deployed' }
    const before = new Date(clock.now().getTime() - 1000)
    const result = await pass()
    expect(result).toMatchObject({ looked: 1, checkedOut: 1, kept: 0 })
    expect(await errandRow(made.errand.id)).toMatchObject({
      closed_kind: 'not_needed',
      closed_by: 'check',
      done_note: 'No longer needed: its check exited 1: no_mr: the commit is deployed',
    })
    expect(needsModel(await readNeeds(db.sql, clock.now()), { redact: false }).items).toEqual([])
    const band = await since(before)
    expect(band).toMatchObject({
      count: 1,
      items: [{ title: 'Re-run the deploy gate (no longer needed)', issue: null }],
    })
    // a second pass finds nothing open, and a visit after the closure sees nothing new
    expect(await pass()).toMatchObject({ looked: 0 })
    expect((await since(new Date(clock.now().getTime() + 1000))).count).toBe(0)
  })

  test('exit 0 keeps it; a check that cannot run keeps it too and says so, on the third time in the summary', async () => {
    const kept = await request({ text: 'Still needed', check: 'still' })
    const broken = await request({ text: 'Broken check', check: 'missing-binary' })
    checks.missing = { exit: 127, timedOut: false, output: 'not found' }
    checks['missing-binary'] = { exit: 127, timedOut: false, output: 'sh: missing-binary: not found' }
    const first = await pass()
    expect(first).toMatchObject({ looked: 2, kept: 1, unrunnable: 1, checkedOut: 0, problems: [] })
    expect(await errandRow(kept.errand.id)).toMatchObject({
      check_note: 'the check exited 0: still needed',
      check_fails: 0,
    })
    expect(await errandRow(broken.errand.id)).toMatchObject({ done_at: null, check_fails: 1 })
    await pass()
    const third = await pass()
    expect(third.problems).toHaveLength(1)
    expect(errandsSummary(third)).toContain('could not run 3 times in a row')
    expect(await errandRow(broken.errand.id)).toMatchObject({ done_at: null, check_fails: 3 })
    // the check that works again resets the count
    checks['missing-binary'] = { exit: 0, timedOut: false, output: '' }
    await pass()
    expect(await errandRow(broken.errand.id)).toMatchObject({ check_fails: 0 })
  })

  test('a timeout keeps it open', async () => {
    const made = await request({ text: 'Slow check', check: 'slow' })
    checks.slow = { exit: null, timedOut: true, output: '' }
    expect(await pass()).toMatchObject({ unrunnable: 1, checkedOut: 0 })
    expect(await errandRow(made.errand.id)).toMatchObject({
      done_at: null,
      check_note: 'the check could not run (timed out)',
    })
  })

  test('a request the owner closed while the check ran stays as he closed it', async () => {
    const made = await request({ text: 'Raced', check: 'raced' })
    checks.raced = { exit: 1, timedOut: false, output: 'gone' }
    const slow: CheckRunner = {
      run: async (command) => {
        value(await finishErrand(deps, { errandId: made.errand.id, note: 'did it' }))
        return checks[command] as CheckRun
      },
    }
    const result = value(await errandsPass({ uow: deps.uow, clock, checks: slow, needed: judge }))
    expect(result.checkedOut).toBe(0)
    expect(await errandRow(made.errand.id)).toMatchObject({ closed_kind: 'done', closed_by: 'owner' })
  })
})

describe('the expiry', () => {
  test('a request with no check is closed as expired after 7 days and appears once in the next band', async () => {
    const made = await request({ text: 'Install the Herdr glance screenshots', key: 'glance' })
    expect(made.errand.expiresAt?.getTime()).toBe(clock.now().getTime() + 7 * DAY)
    clock.set(new Date(clock.now().getTime() + 6 * DAY))
    expect(await pass()).toMatchObject({ expired: 0 })
    clock.set(new Date(clock.now().getTime() + 2 * DAY))
    const result = await pass()
    expect(result).toMatchObject({ looked: 1, expired: 1 })
    expect(await errandRow(made.errand.id)).toMatchObject({ closed_kind: 'expired', closed_by: 'loop' })
    const morning = new Date(clock.now().getTime() - HOUR)
    expect(await since(morning)).toMatchObject({
      count: 1,
      items: [{ title: 'Install the Herdr glance screenshots (expired)' }],
    })
    // the owner's next visit starts after it: it is not listed twice
    expect((await since(new Date(clock.now().getTime() + 1))).count).toBe(0)
  })

  test('`never` keeps a request, an explicit expiry closes a request that has a check', async () => {
    const never = await request({ text: 'Standing request', expires: 'never' })
    const timed = await request({ text: 'Short request', check: 'still', expires: '2d' })
    clock.set(new Date(clock.now().getTime() + 3 * DAY))
    const result = await pass()
    expect(result).toMatchObject({ expired: 1 })
    expect(await errandRow(never.errand.id)).toMatchObject({ done_at: null })
    expect(await errandRow(timed.errand.id)).toMatchObject({ closed_kind: 'expired' })
  })
})

describe('the still-needed look at a request with no check', () => {
  test('waits a day, then reads the request and the same source’s other requests; `not_needed` with a reason closes it', async () => {
    const old = await request({ text: 'Reseed the cache (Issue 178)', expires: 'never' })
    const newer = await request({ text: 'Reseal FACTORY_ORCHESTRATOR_TOKEN', expires: 'never' })
    expect(await pass()).toMatchObject({ looks: 0 })
    clock.set(new Date(clock.now().getTime() + 25 * HOUR))
    needed = (id) =>
      id === old.errand.id
        ? ok({ verdict: 'not_needed', reason: 'the later reseal covers it' })
        : ok({ verdict: 'needed', reason: 'a token reseal is still pending' })
    const result = await pass()
    expect(result).toMatchObject({ looks: 2, judgedOut: 1 })
    expect(neededCalls.map((call) => call.id).sort()).toEqual([old.errand.id, newer.errand.id].sort())
    expect(neededCalls.find((call) => call.id === old.errand.id)?.evidence).toContain(
      'Reseal FACTORY_ORCHESTRATOR_TOKEN',
    )
    expect(await errandRow(old.errand.id)).toMatchObject({
      closed_kind: 'not_needed',
      closed_by: 'judge',
      done_note: 'No longer needed: the later reseal covers it',
    })
    expect(await errandRow(newer.errand.id)).toMatchObject({
      done_at: null,
      check_note: 'a token reseal is still pending',
    })
    // looked at again only after another day
    await pass()
    expect(neededCalls).toHaveLength(2)
    clock.set(new Date(clock.now().getTime() + 25 * HOUR))
    await pass()
    expect(neededCalls).toHaveLength(3)
  })

  test('a request with a check is never read by the workflow, and an unsure or failed look keeps it', async () => {
    await request({ text: 'Has a check', check: 'still', expires: 'never' })
    const plain = await request({ text: 'No check', expires: 'never' })
    clock.set(new Date(clock.now().getTime() + 25 * HOUR))
    needed = () => ok({ verdict: 'unsure', reason: 'cannot tell' })
    await pass()
    expect(neededCalls.map((call) => call.id)).toEqual([plain.errand.id])
    expect(await errandRow(plain.errand.id)).toMatchObject({ done_at: null })

    needed = () => err(portError('timeout', 'agw did not answer'))
    clock.set(new Date(clock.now().getTime() + 25 * HOUR))
    const failed = await pass()
    expect(failed.problems[0]).toContain('agw did not answer')
    expect(await errandRow(plain.errand.id)).toMatchObject({ done_at: null })
    // a failed look is made again within hours, not a day
    clock.set(new Date(clock.now().getTime() + 7 * HOUR))
    neededCalls.length = 0
    await pass()
    expect(neededCalls).toHaveLength(1)
  })
})
