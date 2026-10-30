import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { recordReading } from '../src/capacity.ts'
import { deliverPrompts, REARM_AFTER_MS } from '../src/prompts.ts'
import { HerdrRunner } from '../src/runner.ts'
import {
  BLOCKED_AFTER_MS,
  evaluateRules,
  RESTART_NOTE,
  RESTART_SETTLE_MS,
  RESUME_GRACE_MS,
  RESUME_WINDOW_MS,
  stopCheck,
} from '../src/rules.ts'
import { getSession, HERDR_SESSION, recordEvent } from '../src/sessions.ts'
import { tick } from '../src/tick.ts'
import { type AgentSeen, type HerdrView, witness } from '../src/witness.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHerdr, type FakeHerdr } from './support/herdr.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
import { usage } from './support/quota.ts'
import { FakeRunner, world } from './support/world.ts'

let db: TestDb
let clock: FakeClock
let runner: FakeRunner
let w: ReturnType<typeof world>

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(async () => {
  await db.reset()
  clock = new FakeClock()
  runner = new FakeRunner()
  w = world(db.sql, clock)
})

const minutes = (n: number) => n * 60_000
const evaluate = () => evaluateRules(db.sql, clock.now())
const deliver = () => deliverPrompts({ sql: db.sql, runner, clock })
const prompts = () =>
  db.sql`SELECT id, session, source, via, text, status, error FROM factory.prompts ORDER BY id` as Promise<
    { id: string; session: string; source: string; via: string; text: string; status: string; error: string | null }[]
  >
const reading = (weekly: number, fiveHour: number, fiveHourReset: Date, weeklyReset: Date, account = 'a') =>
  recordReading(
    db.sql,
    { account, ...usage(weekly, fiveHour, fiveHourReset, { weeklyResetsAt: weeklyReset }) },
    clock.now(),
  )

/** Runs the rules twice more: a replay of the same facts records nothing. */
async function replayIsSilent() {
  const before = await prompts()
  expect((await evaluate()).created).toEqual([])
  expect((await evaluate()).created).toEqual([])
  expect(await prompts()).toEqual(before)
}

describe('resume watchdog (FL2)', () => {
  /** A session walled 20 minutes ago whose 5-hour window lifts in `resetInMinutes`. */
  async function walled(resetInMinutes: number, session = 's') {
    await w.spawned(session, { account: 'a' })
    await w.emit(session, 'turn_started', w.at(30))
    await w.emit(session, 'limit_stop', w.at(20), { error: 'rate_limit' })
    const reset = new Date(clock.now().getTime() + minutes(resetInMinutes))
    await reading(50, 100, reset, new Date(clock.now().getTime() + 5 * 86_400_000))
    return reset
  }

  test('one "continue" five minutes after the reset, keyed by session and reset; a replay adds nothing', async () => {
    const reset = await walled(10)

    expect((await evaluate()).created).toEqual([])
    clock.advance(minutes(10) + RESUME_GRACE_MS - 1_000)
    expect((await evaluate()).created).toEqual([])

    clock.advance(2_000)
    expect((await evaluate()).created).toEqual([`resume:s:${reset.toISOString()}`])
    expect(await prompts()).toEqual([
      {
        id: `resume:s:${reset.toISOString()}`,
        session: 's',
        source: 'resume',
        via: 'type',
        text: 'continue',
        status: 'pending',
        error: null,
      },
    ])
    await replayIsSilent()
  })

  test('is typed into the walled session, and confirmed by the turn it starts', async () => {
    await walled(10)
    clock.advance(minutes(16))
    await evaluate()
    expect((await deliver()).sent).toHaveLength(1)
    expect(runner.typed).toEqual([{ pane: 'w1:s', text: 'continue' }])
    clock.advance(5_000)
    await w.emit('s', 'turn_started', clock.now())
    await deliver()
    expect((await prompts())[0]?.status).toBe('delivered')
    expect((await evaluate()).created).toEqual([])
  })

  test('says nothing before the reset, once the session has started a turn again, or when no reading names a reset', async () => {
    await walled(30)
    clock.advance(minutes(20))
    await evaluate()
    expect(await prompts()).toEqual([])

    clock.advance(minutes(20))
    await w.emit('s', 'turn_started', w.at(1))
    await evaluate()
    expect(await prompts()).toEqual([])

    await w.spawned('quiet', { account: 'b' })
    await w.emit('quiet', 'turn_started', w.at(30))
    await w.emit('quiet', 'limit_stop', w.at(20))
    await evaluate()
    expect(await prompts()).toEqual([])
  })

  test('a quota_resume after the wall moves the five minutes to it', async () => {
    const reset = await walled(1)
    clock.advance(minutes(2))
    await w.emit('s', 'quota_resume', clock.now(), { state: 'stale' })
    clock.advance(RESUME_GRACE_MS - 1_000)
    expect((await evaluate()).created).toEqual([])
    clock.advance(2_000)
    expect((await evaluate()).created).toEqual([`resume:s:${reset.toISOString()}`])
  })

  test('works for a session the hook reported the account of, and is blind to one with no account', async () => {
    await w.emit('rd', 'session_started', w.at(60), { claudeSessionId: 'c-rd', account: 'a' })
    await w.emit('rd', 'turn_started', w.at(30))
    await w.emit('rd', 'limit_stop', w.at(20))
    await w.emit('anon', 'session_started', w.at(60), { claudeSessionId: 'c-anon' })
    await w.emit('anon', 'turn_started', w.at(30))
    await w.emit('anon', 'limit_stop', w.at(20))
    const reset = new Date(clock.now().getTime() + minutes(1))
    await reading(50, 100, reset, new Date(clock.now().getTime() + 5 * 86_400_000))
    clock.advance(minutes(7))
    expect((await evaluate()).created).toEqual([`resume:rd:${reset.toISOString()}`])
  })

  test('a wall whose reset is long past records and types nothing: a deploy does not wake sessions walled days ago', async () => {
    await w.spawned('old', { account: 'a', startedMinutesAgo: 4 * 24 * 60 })
    await w.emit('old', 'turn_started', w.at(3 * 24 * 60 + 60))
    await w.emit('old', 'limit_stop', w.at(3 * 24 * 60))
    // The reading is still there, and its reset (two days and a bit ago) is past.
    await db.sql`
      INSERT INTO factory.quota_readings (account, read_at, sampled_at, enabled, auth_ok, five_hour_used, weekly_used, five_hour_resets_at, weekly_resets_at)
      VALUES ('a', ${w.at(3 * 24 * 60 - 1)}, ${w.at(3 * 24 * 60 - 1)}, true, true, 100, 50, ${w.at(2 * 24 * 60)}, ${w.at(-2 * 24 * 60)})`
    expect((await evaluate()).created).toEqual([])
    const result = await tick({ sql: db.sql, runner, clock })
    expect(result.errors).toEqual([])
    expect(runner.typed).toEqual([])
    expect(await prompts()).toEqual([])
  })

  test('acts until the reset is six hours past, and not after', async () => {
    const reset = await walled(1)
    clock.advance(RESUME_WINDOW_MS - minutes(1) - 1_000)
    expect((await evaluate()).created).toEqual([`resume:s:${reset.toISOString()}`])
    await db.reset()
    const second = await walled(1)
    clock.advance(RESUME_WINDOW_MS + minutes(1) + 1_000)
    expect(second).toBeDefined()
    expect((await evaluate()).created).toEqual([])
  })

  test('takes the first reading after the wall that names its end, not the first reading', async () => {
    await w.spawned('s', { account: 'a' })
    await w.emit('s', 'turn_started', w.at(30))
    await w.emit('s', 'limit_stop', w.at(20))
    // The picker's first word after the wall has no reset in it; a later one does.
    await recordReading(
      db.sql,
      { account: 'a', ...usage(null, null, new Date(), { fiveHourResetsAt: null, weeklyResetsAt: null }) },
      clock.now(),
    )
    clock.advance(minutes(1))
    const reset = new Date(clock.now().getTime() + minutes(5))
    await reading(50, 100, reset, new Date(clock.now().getTime() + 5 * 86_400_000))
    clock.advance(minutes(11))
    expect((await evaluate()).created).toEqual([`resume:s:${reset.toISOString()}`])
  })

  test('the reset is the weekly one when the week is what is full', async () => {
    await w.spawned('s', { account: 'a' })
    await w.emit('s', 'turn_started', w.at(30))
    await w.emit('s', 'limit_stop', w.at(20))
    const fiveHour = new Date(clock.now().getTime() + minutes(30))
    const week = new Date(clock.now().getTime() + 2 * 86_400_000)
    await reading(100, 100, fiveHour, week)
    clock.advance(minutes(40))
    expect((await evaluate()).created).toEqual([])
    clock.advance(2 * 86_400_000)
    expect((await evaluate()).created).toEqual([`resume:s:${week.toISOString()}`])
  })
})

describe('rotation', () => {
  const week = () => new Date(clock.now().getTime() + 3 * 86_400_000)

  test('a mother or lead whose account reaches 94 % of its week gets one note per week', async () => {
    await w.spawned('lead-1', { role: 'lead', account: 'a' })
    await w.spawned('mother-1', { role: 'mother', account: 'a' })
    await w.spawned('worker-1', { role: 'worker', account: 'a' })
    await w.spawned('lead-b', { role: 'lead', account: 'b' })
    const resets = week()
    for (const s of ['lead-1', 'mother-1', 'worker-1', 'lead-b']) await w.emit(s, 'turn_started', w.at(5))

    await reading(93.9, 10, new Date(clock.now().getTime() + minutes(60)), resets)
    await reading(40, 10, new Date(clock.now().getTime() + minutes(60)), resets, 'b')
    expect((await evaluate()).created).toEqual([])

    clock.advance(minutes(1))
    await reading(94, 10, new Date(clock.now().getTime() + minutes(60)), resets)
    expect((await evaluate()).created.sort()).toEqual([
      `rotate:lead-1:${resets.toISOString()}`,
      `rotate:mother-1:${resets.toISOString()}`,
    ])
    expect((await prompts())[0]?.text).toContain('Write the handoff and rotate')
    await replayIsSilent()

    // The next week is a new key.
    const next = new Date(resets.getTime() + 7 * 86_400_000)
    clock.advance(minutes(1))
    await reading(94.5, 10, new Date(clock.now().getTime() + minutes(60)), next)
    expect((await evaluate()).created.sort()).toEqual([
      `rotate:lead-1:${next.toISOString()}`,
      `rotate:mother-1:${next.toISOString()}`,
    ])
  })

  test('is held while the session works and typed when it is at its prompt', async () => {
    await w.spawned('lead-1', { role: 'lead', account: 'a' })
    await w.emit('lead-1', 'turn_started', w.at(5))
    await reading(95, 10, new Date(clock.now().getTime() + minutes(60)), week())
    await evaluate()
    expect((await deliver()).sent).toEqual([])
    await w.emit('lead-1', 'turn_ended', clock.now())
    expect((await deliver()).sent).toHaveLength(1)
  })
})

describe('a rule that gave up is asked again while its condition holds', () => {
  const failed = (id: string) =>
    db.sql`UPDATE factory.prompts SET status = 'failed', failed_at = ${clock.now()}, error = 'gave up' WHERE id = ${id}`

  test('after half an hour a failed rotation note starts over, once; a delivered one never does', async () => {
    await w.spawned('lead-1', { role: 'lead', account: 'a' })
    await w.emit('lead-1', 'turn_started', w.at(5))
    const resets = new Date(clock.now().getTime() + 3 * 86_400_000)
    await reading(95, 10, new Date(clock.now().getTime() + minutes(60)), resets)
    const [id] = (await evaluate()).created
    expect(id).toBe(`rotate:lead-1:${resets.toISOString()}`)

    await failed(id as string)
    clock.advance(REARM_AFTER_MS - 1_000)
    await reading(95, 10, new Date(clock.now().getTime() + minutes(60)), resets)
    expect((await evaluate()).created).toEqual([])
    clock.advance(2_000)
    await reading(95, 10, new Date(clock.now().getTime() + minutes(60)), resets)
    expect((await evaluate()).created).toEqual([id as string])
    expect((await prompts())[0]).toMatchObject({ status: 'pending', error: null })
    await replayIsSilent()

    await db.sql`UPDATE factory.prompts SET status = 'delivered' WHERE id = ${id}`
    clock.advance(REARM_AFTER_MS * 3)
    await reading(95, 10, new Date(clock.now().getTime() + minutes(60)), resets)
    expect((await evaluate()).created).toEqual([])
  })

  test('stops once the condition does not hold, and never revives a prompt that could not be delivered at all', async () => {
    await w.spawned('lead-1', { role: 'lead', account: 'a' })
    await w.emit('lead-1', 'turn_started', w.at(5))
    const resets = new Date(clock.now().getTime() + 3 * 86_400_000)
    await reading(95, 10, new Date(clock.now().getTime() + minutes(60)), resets)
    const [id] = (await evaluate()).created
    await failed(id as string)
    clock.advance(REARM_AFTER_MS + 1_000)
    await reading(60, 10, new Date(clock.now().getTime() + minutes(60)), resets)
    expect((await evaluate()).created).toEqual([])
    expect((await prompts())[0]?.status).toBe('failed')
  })
})

describe('blocked', () => {
  async function blockedChild(parentDead = false) {
    await w.spawned('boss')
    await w.emit('boss', 'turn_started', w.at(20))
    await w.emit('boss', 'turn_ended', w.at(19))
    await w.spawned('child', { parent: 'boss' })
    await w.emit('child', 'turn_started', w.at(10))
    await w.emit('child', 'prompt_blocked', clock.now(), { message: 'Dangerous rm of /tmp/x' })
    if (parentDead) await w.emit('boss', 'session_ended', w.at(1))
  }

  test('after two minutes the parent gets one note naming the confirmation; a replay adds nothing', async () => {
    await blockedChild()
    clock.advance(BLOCKED_AFTER_MS - 1_000)
    expect((await evaluate()).created).toEqual([])
    clock.advance(2_000)
    const { created } = await evaluate()
    expect(created).toHaveLength(1)
    expect(created[0]).toStartWith('blocked:child:prompt_blocked:')
    const [prompt] = await prompts()
    expect(prompt).toMatchObject({ session: 'boss', source: 'blocked', via: 'type' })
    expect(prompt?.text).toContain('child')
    // What the worker's prompt says is its own text: it stays out of a note typed into another agent.
    expect(prompt?.text).not.toContain('Dangerous rm')
    await replayIsSilent()
  })

  test('answering the prompt (a turn ends) or having no live parent leaves nothing to say', async () => {
    await blockedChild(true)
    clock.advance(minutes(5))
    await evaluate()
    expect(await prompts()).toEqual([])

    await db.reset()
    await blockedChild()
    clock.advance(minutes(5))
    await w.emit('child', 'turn_ended', clock.now())
    await evaluate()
    expect(await prompts()).toEqual([])
  })

  test('a session with no parent only shows in status', async () => {
    await w.spawned('alone')
    await w.emit('alone', 'turn_started', w.at(10))
    await w.emit('alone', 'prompt_blocked', w.at(5), { message: 'Dangerous rm' })
    await evaluate()
    expect(await prompts()).toEqual([])
  })
})

describe('herdr restart', () => {
  let herdr: FakeHerdr
  beforeAll(async () => {
    herdr = await createFakeHerdr()
  })
  afterAll(() => herdr.cleanup())
  beforeEach(() => herdr.reset())

  class FakeView implements HerdrView {
    list: AgentSeen[] = []
    server: string | undefined = '100@Sun Oct 11 14:11:39 2026'
    async agents() {
      return this.list
    }
    async serverId() {
      return this.server
    }
  }
  const pass = (view: FakeView) => witness({ sql: db.sql, herdr: view, clock, probe: async () => undefined })
  const NEW_SERVER = '200@Fri Oct 30 12:03:00 2026'

  test('a session whose turn was cut off is resumed by id with a note, once: the fake herdr sees `claude --resume`', async () => {
    await w.spawned('s', { account: 'b', repo: '/work/repo' })
    await w.emit('s', 'turn_started', w.at(10))
    const view = new FakeView()
    view.list = [{ paneId: 'w1:s', claudeSessionId: 'claude-s', status: 'working' }]
    await pass(view)

    // herdr restarts: its agents are gone.
    clock.advance(minutes(1))
    view.server = NEW_SERVER
    view.list = []
    expect((await pass(view)).restarted).toBe(true)
    expect((await evaluate()).created).toEqual([])

    clock.advance(minutes(1))
    await pass(view)
    clock.advance(minutes(1))
    await pass(view)
    expect((await getSession(db.sql, 's', clock.now()))?.state).toBe('dead')
    clock.advance(RESTART_SETTLE_MS)
    expect((await evaluate()).created).toEqual([`restart:${NEW_SERVER}:s`])
    const [prompt] = await prompts()
    expect(prompt).toMatchObject({ via: 'resume', source: 'restart', text: RESTART_NOTE, status: 'pending' })

    // The resume is admitted like a spawn: its account has room.
    await reading(
      10,
      10,
      new Date(clock.now().getTime() + minutes(60)),
      new Date(clock.now().getTime() + 3 * 86_400_000),
      'b',
    )
    const real = new HerdrRunner({
      bin: herdr.bin,
      clock,
      pretrustBin: herdr.pretrustBin,
      accountsFile: herdr.accountsFile,
      home: '/home/me',
      deliverWaitMs: 3_000,
    })
    expect((await deliverPrompts({ sql: db.sql, runner: real, clock })).sent).toEqual([`restart:${NEW_SERVER}:s`])
    const state = await herdr.state()
    expect(state.agents).toHaveLength(1)
    expect(state.agents[0]?.argv).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--resume',
      'claude-s',
    ])
    expect(state.panes[0]?.env).toContain('FACTORY_SESSION=s')
    expect(state.panes[0]?.env).toContain('CLAUDE_CONFIG_DIR=/home/me/.claude-b')
    expect(state.prompts.map((p) => p.text)).toEqual([RESTART_NOTE])
    expect((await db.sql`SELECT pane FROM factory.sessions WHERE id = 's'`)[0]?.pane).toBe(state.panes[0]?.pane_id)
    expect((await db.sql`SELECT session FROM factory.spawns WHERE key = 's'`)[0]?.session).toBe(state.panes[0]?.pane_id)

    // The resumed session reports in, and its first turn proves the note.
    clock.advance(5_000)
    await w.emit('s', 'session_started', clock.now(), { claudeSessionId: 'claude-s', source: 'resume' })
    await w.emit('s', 'turn_started', new Date(clock.now().getTime() + 1))
    await deliverPrompts({ sql: db.sql, runner: real, clock })
    expect((await prompts())[0]?.status).toBe('delivered')
    expect((await getSession(db.sql, 's', clock.now()))?.state).toBe('working')
    await replayIsSilent()
    expect((await herdr.state()).agents).toHaveLength(1)
  })

  const restartEvent = (at: Date) =>
    recordEvent(db.sql, {
      key: `herdr_restarted:${NEW_SERVER}`,
      session: HERDR_SESSION,
      kind: 'herdr_restarted',
      at,
      payload: { from: '100@x', to: NEW_SERVER },
    })

  test('leaves alone a session that was idle, one herdr still shows, one that went on, and a restart too fresh or too old', async () => {
    await w.spawned('idle')
    await w.emit('idle', 'turn_started', w.at(20))
    await w.emit('idle', 'turn_ended', w.at(15))
    await w.spawned('seen')
    await w.emit('seen', 'turn_started', w.at(20))
    await w.spawned('moved')
    await w.emit('moved', 'turn_started', w.at(20))
    await restartEvent(w.at(10))
    await db.sql`UPDATE factory.sessions SET herdr_seen_at = ${w.at(5)} WHERE id = 'seen'`
    await w.emit('moved', 'turn_ended', w.at(5))
    expect((await evaluate()).created).toEqual([])

    clock.advance(RESTART_SETTLE_MS)
    expect((await evaluate()).created).toEqual([])

    await db.reset()
    await w.spawned('late')
    await w.emit('late', 'turn_started', w.at(300))
    await restartEvent(w.at(240))
    expect((await evaluate()).created).toEqual([])
  })

  test('a fresh restart waits for the witness; a session the factory did not start is a line in status, not a resume', async () => {
    await w.emit('rd', 'session_started', w.at(30), { claudeSessionId: 'c-rd', account: 'a' })
    await w.emit('rd', 'turn_started', w.at(20))
    await restartEvent(w.at(1))
    expect((await evaluate()).created).toEqual([])

    clock.advance(RESTART_SETTLE_MS)
    expect((await evaluate()).created).toEqual([`restart:${NEW_SERVER}:rd`])
    const [prompt] = await prompts()
    expect(prompt).toMatchObject({ status: 'failed', via: 'resume' })
    expect(prompt?.error).toContain('was not started by the factory')
    expect((await deliver()).sent).toEqual([])
    expect(runner.started).toEqual([])
    await replayIsSilent()

    // Half an hour later the rule still names the session, and the reason it was given up on stands.
    clock.advance(REARM_AFTER_MS + 1_000)
    expect((await evaluate()).created).toEqual([])
    expect((await prompts())[0]).toMatchObject({ status: 'failed' })
    expect((await prompts())[0]?.error).toContain('was not started by the factory')
  })
})

describe('send-back (FL5)', () => {
  /** A lead that ended its turn with two workers running. */
  async function leadWithWorkers() {
    await w.spawned('lead', { role: 'lead' })
    await w.emit('lead', 'turn_started', w.at(20))
    await w.spawned('w1', { parent: 'lead' })
    await w.spawned('w2', { parent: 'lead' })
    await w.emit('w1', 'turn_started', w.at(10))
    await w.emit('w2', 'turn_started', w.at(10))
    await w.emit('lead', 'turn_ended', w.at(1))
  }
  const ask = (stopHookActive = false) => stopCheck(db.sql, 'lead', { stopHookActive }, clock.now())

  test('sends the session back once per turn, naming the count', async () => {
    await leadWithWorkers()
    expect(await ask()).toEqual({
      sendBack: true,
      message: '2 workers still running: wait for them (`factory session wait --on workers`) or collect them',
    })
    expect(await ask()).toEqual({ sendBack: false, message: null })

    // A new turn is a new key.
    await w.emit('lead', 'turn_started', clock.now())
    await w.emit('lead', 'turn_ended', new Date(clock.now().getTime() + 1))
    expect((await ask()).sendBack).toBe(true)
    expect(await db.sql`SELECT key FROM factory.effects ORDER BY key`).toEqual([
      { key: 'sendback:lead:1' },
      { key: 'sendback:lead:2' },
    ])
  })

  test('one worker reads in the singular', async () => {
    await w.spawned('lead')
    await w.emit('lead', 'turn_started', w.at(5))
    await w.spawned('w1', { parent: 'lead' })
    await w.emit('w1', 'turn_started', w.at(3))
    await w.emit('lead', 'turn_ended', w.at(1))
    expect((await ask()).message).toBe(
      '1 worker still running: wait for it (`factory session wait --on workers`) or collect it',
    )
  })

  test('lets the stop through after a send-back, with a declared wait, on a limit, with no live workers', async () => {
    await leadWithWorkers()
    expect((await ask(true)).sendBack).toBe(false)
    expect(await db.sql`SELECT key FROM factory.effects`).toEqual([])

    await w.emit('lead', 'wait_declared', clock.now(), { on: 'workers' })
    expect((await ask()).sendBack).toBe(false)
    await w.emit('lead', 'wait_cleared', new Date(clock.now().getTime() + 1))

    await w.emit('lead', 'limit_stop', new Date(clock.now().getTime() + 2), { error: 'rate_limit' })
    expect((await ask()).sendBack).toBe(false)
    expect(await db.sql`SELECT key FROM factory.effects`).toEqual([])

    await db.reset()
    await w.spawned('lead')
    await w.emit('lead', 'turn_started', w.at(5))
    await w.spawned('w1', { parent: 'lead' })
    await w.emit('w1', 'session_ended', w.at(2))
    await w.emit('lead', 'turn_ended', w.at(1))
    expect((await ask()).sendBack).toBe(false)
    expect((await stopCheck(db.sql, 'nobody', { stopHookActive: false }, clock.now())).sendBack).toBe(false)
  })

  test("counts only the workers the factory knows are this session's", async () => {
    await w.spawned('lead')
    await w.emit('lead', 'turn_started', w.at(5))
    await w.spawned('stranger')
    await w.emit('stranger', 'turn_started', w.at(3))
    await w.emit('lead', 'turn_ended', w.at(1))
    expect((await ask()).sendBack).toBe(false)
  })
})

describe('the tick', () => {
  test('records the rule and types it in one pass; a second pass, and a replayed spool, add nothing', async () => {
    await w.spawned('s', { account: 'a' })
    await w.emit('s', 'turn_started', w.at(30))
    await w.emit('s', 'limit_stop', w.at(20), { error: 'rate_limit' })
    await reading(
      50,
      100,
      new Date(clock.now().getTime() + minutes(1)),
      new Date(clock.now().getTime() + 5 * 86_400_000),
    )
    clock.advance(minutes(7))

    const first = await tick({ sql: db.sql, runner, clock })
    expect(first.errors).toEqual([])
    expect(runner.typed).toEqual([{ pane: 'w1:s', text: 'continue' }])
    const second = await tick({ sql: db.sql, runner, clock })
    expect(second.errors).toEqual([])
    expect(runner.typed).toHaveLength(1)
    expect(await prompts()).toHaveLength(1)
  })
})
