import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { BRIEF_MAX_AGE_MS, type BriefWatch, inputBoxText, nudgeBriefs } from '../src/briefs.ts'
import { currentLoads, latestReadings } from '../src/capacity.ts'
import { HcRunner } from '../src/hc-runner.ts'
import { healthKind, healthLines } from '../src/health.ts'
import { tick } from '../src/tick.ts'
import { createSpawn } from '../src/spawns.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHc, type FakeHc } from './support/hc.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { QuotaPoller } from '../src/quota.ts'
import { FakeQuotaSource, usage, WORKER } from './support/quota.ts'
import { FakeRunner, world } from './support/world.ts'

const RULE = '─'.repeat(100)
const screen = (box: string) =>
  [
    '✻ Ready to work…',
    '',
    RULE,
    `❯ ${box}`,
    RULE,
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
    '  Opus 4.7 · ctx 3%',
  ].join('\n')

describe('inputBoxText', () => {
  test('an empty box is empty', () => {
    expect(inputBoxText(screen(''))).toBe('')
    expect(inputBoxText(screen(' '.trim()))).toBe('')
  })

  test('typed text and a paste placeholder are the box text', () => {
    expect(inputBoxText(screen('fix the failing test'))).toBe('fix the failing test')
    expect(inputBoxText(screen('[Pasted text #1 +40 lines]'))).toBe('[Pasted text #1 +40 lines]')
  })

  test('a multi-line box is read between its rules', () => {
    const text = ['x', RULE, '❯ first line', '  second line', RULE, 'footer'].join('\n')
    expect(inputBoxText(text)).toBe('first line\n  second line')
  })

  test('only the last two rules count; no box is no text', () => {
    const text = [RULE, 'old output', RULE, '❯ ', RULE].join('\n')
    expect(inputBoxText(text)).toBe('')
    expect(inputBoxText('Do you trust this folder?\n1. Yes\n2. No')).toBe('')
    expect(inputBoxText(`${RULE}\n❯ lonely`)).toBe('')
  })
})

describe('the unsent-brief pass', () => {
  let db: TestDb
  let hc: FakeHc
  let clock: FakeClock
  let watch: BriefWatch

  beforeAll(async () => {
    db = await startTestDb()
    hc = await createFakeHc()
  })
  afterAll(async () => {
    await hc.cleanup()
    await db.stop()
  })
  beforeEach(async () => {
    await db.reset()
    await hc.reset()
    clock = new FakeClock()
    watch = new Map()
  })

  const w = () => world(db.sql, clock)
  const pass = (runner: FakeRunner | HcRunner) => nudgeBriefs({ sql: db.sql, runner, clock, watch })
  const hcRunner = () =>
    new HcRunner({
      bin: hc.bin,
      clock,
      pretrustBin: hc.pretrustBin,
      accountsFile: hc.accountsFile,
      home: '/home/me',
      deliverWaitMs: 3_000,
    })
  const enters = async () => (await hc.state()).sent.filter((s) => s.text === '').length

  /** Starts a spawn through the real tick and HcRunner; the fake core makes it come up with its brief unsent. */
  async function startUnsent(key: string): Promise<HcRunner> {
    const source = new FakeQuotaSource()
    source.readings = [{ account: 'a', ...usage(1, 1, new Date(clock.now().getTime() + 1_000 * 3_600_000)) }]
    const quota = new QuotaPoller({ sql: db.sql, clock, source })
    await quota.poll()
    await createSpawn(db.sql, { key, repo: '/work/repo', prompt: 'the brief', ...WORKER }, clock.now())
    await hc.plan('terminal.run:unsent')
    const runner = hcRunner()
    const result = await tick({ sql: db.sql, runner, clock, quota })
    expect(result.started).toEqual([key])
    return runner
  }

  test('a swallowed Enter is pressed again after the backoff gap, then nothing once the turn began', async () => {
    const runner = await startUnsent('brief-1')
    const [spawn] = await db.sql`SELECT session FROM factory.spawns WHERE key = 'brief-1'`
    expect(inputBoxText(await runner.screen(spawn.session))).toBe('the brief')

    clock.advance(9_000)
    expect(await pass(runner)).toEqual([])
    expect(await enters()).toBe(0)

    clock.advance(1_000)
    await pass(runner)
    expect(await enters()).toBe(1)
    expect(inputBoxText(await runner.screen(spawn.session))).toBe('the brief')

    clock.advance(10_000 - 1_000)
    await pass(runner)
    expect(await enters()).toBe(1)

    clock.advance(1_000)
    await pass(runner)
    expect(await enters()).toBe(2)
    expect(inputBoxText(await runner.screen(spawn.session))).toBe('')

    await w().emit('brief-1', 'turn_started', clock.now())
    clock.advance(60_000)
    await pass(runner)
    expect(await enters()).toBe(2)
    expect(watch.size).toBe(0)
  })

  test('the gaps grow to a minute', async () => {
    await hc.mutate((state) => {
      state.swallow = 99
    })
    const runner = await startUnsent('brief-2')
    clock.advance(10_000)
    const pressAt: number[] = []
    const start = clock.now().getTime()
    for (let t = 0; t <= 200_000; t += 5_000) {
      const before = await enters()
      await pass(runner)
      if ((await enters()) > before) pressAt.push(t)
      clock.advance(5_000)
    }
    expect(clock.now().getTime() - start).toBeGreaterThan(0)
    expect(pressAt).toEqual([0, 10_000, 30_000, 70_000, 130_000, 190_000])
  })

  test('an empty input box is never pressed', async () => {
    await w().spawned('s', { startedMinutesAgo: 1 })
    const runner = new FakeRunner()
    runner.screens.set('w1:s', screen(''))
    expect(await pass(runner)).toEqual([])
    expect(runner.screenRead).toEqual(['w1:s'])
    expect(runner.typed).toEqual([])
  })

  test('a spawn with a turn is never read; one past 30 minutes or younger than 10 s is not either', async () => {
    const world_ = w()
    await world_.spawned('turned', { startedMinutesAgo: 1 })
    await world_.emit('turned', 'turn_started', world_.at(0.5))
    await world_.spawned('old', { startedMinutesAgo: BRIEF_MAX_AGE_MS / 60_000 + 1 })
    await world_.spawned('young', { startedMinutesAgo: 5 / 60 })
    const runner = new FakeRunner()
    await pass(runner)
    expect(runner.screenRead).toEqual([])
  })

  test('a busy agent gets no press and is tried again next pass', async () => {
    await w().spawned('s', { startedMinutesAgo: 1 })
    const runner = new FakeRunner()
    runner.screens.set('w1:s', screen('the brief'))
    runner.answer = 'busy'
    await pass(runner)
    expect(runner.typed).toEqual([])
    expect(watch.size).toBe(0)
    runner.answer = 'typed'
    await pass(runner)
    expect(runner.typed).toEqual([{ pane: 'w1:s', text: '', enterOnly: true }])
  })

  test('a screen error is returned, not thrown', async () => {
    await w().spawned('s', { startedMinutesAgo: 1 })
    const runner = new FakeRunner()
    runner.failure = new Error('core down')
    expect(await pass(runner)).toEqual(['s: core down'])
  })

  test('the health line shows at 3 min without a turn and is gone after it', async () => {
    const world_ = w()
    await world_.spawned('s', { startedMinutesAgo: 2.9 })
    expect(await healthLines(db.sql, clock.now())).toEqual([])
    clock.advance(10_000)
    const lines = await healthLines(db.sql, clock.now())
    expect(lines).toEqual(['spawn s: no first turn 3 min after its start, its brief may sit unsent'])
    expect(healthKind(lines[0] ?? '')).toBe('silent')
    expect(healthKind('Issue 7: no first turn 5 min after its start, its brief may sit unsent')).toBe('silent')
    await world_.emit('s', 'turn_started', clock.now())
    expect(await healthLines(db.sql, clock.now())).toEqual([])
  })

  test('an ended session has no line', async () => {
    const world_ = w()
    await world_.spawned('s', { startedMinutesAgo: 10 })
    await world_.emit('s', 'pane_gone', world_.at(1))
    expect(await healthLines(db.sql, clock.now())).toEqual([])
  })

  test('a started spawn without a turn keeps holding its account, whatever the sample says; a turn frees it', async () => {
    const source = new FakeQuotaSource()
    source.readings = [{ account: 'a', ...usage(1, 1, new Date(clock.now().getTime() + 1_000 * 3_600_000)) }]
    const quota = new QuotaPoller({ sql: db.sql, clock, source })
    const world_ = w()
    await world_.spawned('s', { startedMinutesAgo: 10 })
    await quota.poll()
    const readings = await latestReadings(db.sql)
    expect((await currentLoads(db.sql, readings)).get('a')).toBe(1)
    await world_.emit('s', 'turn_started', world_.at(5))
    expect((await currentLoads(db.sql, readings)).get('a')).toBeUndefined()
  })

  test('the tick runs the pass when it is given a watch, and not without one', async () => {
    await w().spawned('s', { startedMinutesAgo: 1 })
    const runner = new FakeRunner()
    runner.screens.set('w1:s', screen('the brief'))
    await tick({ sql: db.sql, runner, clock })
    expect(runner.screenRead).toEqual([])
    const result = await tick({ sql: db.sql, runner, clock, briefs: watch })
    expect(result.errors).toEqual([])
    expect(runner.typed).toEqual([{ pane: 'w1:s', text: '', enterOnly: true }])
    expect(watch.get('s')?.presses).toBe(1)
  })
})
