import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  CONFIRM_MS,
  deliverPrompts,
  FAILURE_RETRY_MS,
  listOpenPrompts,
  MAX_FAILURES,
  PENDING_TTL_MS,
  recordPrompt,
  TYPING_LEASE_MS,
} from '../src/prompts.ts'
import { HerdrRunner, UncertainTyping } from '../src/runner.ts'
import { FakeClock } from './support/clock.ts'
import { createFakeHerdr, type FakeHerdr } from './support/herdr.ts'
import { startTestDb, type TestDb } from './support/pg.ts'
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

const deliver = () => deliverPrompts({ sql: db.sql, runner, clock })
const note = (id: string, text = 'please look at the failing test', session = 's') =>
  recordPrompt(db.sql, { id, session, source: 'note', text }, clock.now())
const row = async (id: string) => {
  const [r] = await db.sql`SELECT status, sent_count, failures, error FROM factory.prompts WHERE id = ${id}`
  return r as { status: string; sent_count: number; failures: number; error: string | null }
}
/** A session that is mid-turn. */
const working = async () => {
  await w.spawned('s')
  await w.emit('s', 'turn_started', w.at(5))
}
const endTurn = () => w.emit('s', 'turn_ended', clock.now())
const startTurn = () => w.emit('s', 'turn_started', clock.now())

describe('prompt delivery', () => {
  test('is recorded first, held while the session works, typed at the next turn_ended, delivered on the next turn_started', async () => {
    await working()
    await note('n1')
    expect((await row('n1')).status).toBe('pending')

    expect((await deliver()).sent).toEqual([])
    expect(runner.typed).toEqual([])
    expect((await row('n1')).status).toBe('pending')

    clock.advance(30_000)
    await endTurn()
    expect((await deliver()).sent).toEqual(['n1'])
    expect(runner.typed).toEqual([{ pane: 'w1:s', text: 'please look at the failing test' }])
    expect((await row('n1')).status).toBe('sent')

    clock.advance(5_000)
    await startTurn()
    await deliver()
    expect(await row('n1')).toMatchObject({ status: 'delivered', sent_count: 1 })
    await deliver()
    expect(runner.typed).toHaveLength(1)
  })

  test('is typed at once into a session that is already at its prompt', async () => {
    await working()
    await w.emit('s', 'turn_ended', w.at(1))
    await note('n1')
    expect((await deliver()).sent).toEqual(['n1'])
  })

  test('is idempotent by prompt id: the same id is one prompt, typed once', async () => {
    await working()
    await endTurn()
    const first = await note('same', 'first text')
    const second = await note('same', 'a different text')
    expect([first.created, second.created]).toEqual([true, false])
    expect(second.prompt.text).toBe('first text')
    await deliver()
    await deliver()
    expect(runner.typed).toEqual([{ pane: 'w1:s', text: 'first text' }])
    expect(await db.sql`SELECT id FROM factory.prompts`).toHaveLength(1)
  })

  test('with no turn_started within a minute it is typed once more, then given up with a line in status', async () => {
    await working()
    await endTurn()
    await note('n1')
    await deliver()
    expect(runner.typed).toHaveLength(1)

    clock.advance(CONFIRM_MS - 1_000)
    await deliver()
    expect(runner.typed).toHaveLength(1)

    clock.advance(2_000)
    await deliver()
    expect(runner.typed).toHaveLength(2)
    expect(await row('n1')).toMatchObject({ status: 'sent', sent_count: 2 })

    clock.advance(CONFIRM_MS + 1_000)
    const result = await deliver()
    expect(result.sent).toEqual([])
    expect(await row('n1')).toMatchObject({ status: 'failed', sent_count: 2 })
    expect((await row('n1')).error).toContain('not delivered')
    expect(runner.typed).toHaveLength(2)
    await deliver()
    expect(runner.typed).toHaveLength(2)
    expect((await listOpenPrompts(db.sql, clock.now())).map((p) => [p.id, p.status])).toEqual([['n1', 'failed']])
  })

  test('a late turn_started that proves the first typing stops the retry', async () => {
    await working()
    await endTurn()
    await note('n1')
    await deliver()
    clock.advance(CONFIRM_MS - 5_000)
    await startTurn()
    clock.advance(10_000)
    await deliver()
    expect(await row('n1')).toMatchObject({ status: 'delivered', sent_count: 1 })
    expect(runner.typed).toHaveLength(1)
  })

  test('a session that is busy in herdr leaves it pending, with nothing counted', async () => {
    await working()
    await endTurn()
    await note('n1')
    runner.answer = 'busy'
    await deliver()
    await deliver()
    expect(await row('n1')).toMatchObject({ status: 'pending', sent_count: 0, failures: 0 })
    runner.answer = 'typed'
    await deliver()
    expect(runner.typed).toHaveLength(1)
  })

  test('a Runner that fails is retried after 30 seconds, and given up after five failures', async () => {
    await working()
    await endTurn()
    await note('n1')
    runner.failure = new Error('herdr agent prompt: exited 1')
    await deliver()
    expect(await row('n1')).toMatchObject({ status: 'pending', failures: 1, error: 'herdr agent prompt: exited 1' })
    await deliver()
    expect((await row('n1')).failures).toBe(1)
    for (let i = 1; i < MAX_FAILURES; i++) {
      clock.advance(FAILURE_RETRY_MS)
      await deliver()
    }
    expect(await row('n1')).toMatchObject({ status: 'failed', failures: MAX_FAILURES })
  })

  test('a claim left by a crashed tick counts as sent: checked by the next turn, not typed blindly again', async () => {
    await working()
    await endTurn()
    await note('n1')
    await db.sql`UPDATE factory.prompts SET status = 'typing', claimed_at = ${clock.now()} WHERE id = 'n1'`
    clock.advance(TYPING_LEASE_MS + 1_000)
    await deliver()
    expect(runner.typed).toEqual([])
    expect(await row('n1')).toMatchObject({ status: 'sent', sent_count: 1 })
    // The minute to show a turn starts when the claim is found abandoned; with none, it is the one retry.
    clock.advance(CONFIRM_MS + 1_000)
    await deliver()
    expect(runner.typed).toHaveLength(1)
    expect(await row('n1')).toMatchObject({ status: 'sent', sent_count: 2 })
  })

  test('is not typed into a blocked, starting or dead session', async () => {
    await w.spawned('blocked')
    await w.emit('blocked', 'turn_started', w.at(5))
    await w.emit('blocked', 'prompt_blocked', w.at(4), { message: 'Dangerous rm' })
    await w.spawned('gone')
    await w.emit('gone', 'session_ended', w.at(1))
    await db.sql`INSERT INTO factory.sessions (id, spawn_key, pane, created_at) VALUES ('fresh', NULL, NULL, ${clock.now()})`
    for (const session of ['blocked', 'gone', 'fresh']) await note(`n-${session}`, 'hello', session)
    expect((await deliver()).sent).toEqual([])
    expect(runner.typed).toEqual([])
  })

  test('is typed into a walled session: that is how a wall is nudged', async () => {
    await w.spawned('s')
    await w.emit('s', 'turn_started', w.at(30))
    await w.emit('s', 'limit_stop', w.at(20), { error: 'rate_limit' })
    await note('n1', 'continue')
    expect((await deliver()).sent).toEqual(['n1'])
  })

  test('a prompt for an unknown session fails with the reason', async () => {
    await note('n1', 'hello', 'nobody')
    expect((await deliver()).failed).toEqual(['n1'])
    expect((await row('n1')).error).toContain('unknown session')
  })
})

describe('prompt delivery: guards', () => {
  test('prompts held for a working session do not use up the batch of a ready one', async () => {
    await w.spawned('busy')
    await w.emit('busy', 'turn_started', w.at(5))
    await w.spawned('ready')
    await w.emit('ready', 'turn_started', w.at(5))
    await w.emit('ready', 'turn_ended', w.at(4))
    for (let i = 0; i < 12; i++) await note(`held-${i}`, 'x', 'busy')
    await note('mine', 'for the ready one', 'ready')
    expect((await deliver()).sent).toEqual(['mine'])
  })

  test('a failure shows in status for a day from when it failed, not from when it was recorded', async () => {
    await working()
    await endTurn()
    await recordPrompt(db.sql, { id: 'old', session: 's', source: 'note', text: 'x' }, w.at(25 * 60))
    await deliver()
    clock.advance(CONFIRM_MS + 1_000)
    await deliver()
    clock.advance(CONFIRM_MS + 1_000)
    await deliver()
    expect((await row('old')).status).toBe('failed')
    expect((await listOpenPrompts(db.sql, clock.now())).map((p) => p.id)).toEqual(['old'])
    clock.advance(25 * 3_600_000)
    expect(await listOpenPrompts(db.sql, clock.now())).toEqual([])
  })

  test('an error that may have typed the text is waited out by a turn, not typed again at once', async () => {
    await working()
    await endTurn()
    await note('n1')
    runner.failure = new UncertainTyping('herdr agent prompt for w1:s: timed out')
    await deliver()
    expect(await row('n1')).toMatchObject({ status: 'sent', sent_count: 1, failures: 0 })
    runner.failure = undefined
    clock.advance(FAILURE_RETRY_MS)
    await deliver()
    expect(runner.typed).toEqual([])
    await startTurn()
    await deliver()
    expect((await row('n1')).status).toBe('delivered')
  })

  test('a resume is not made once the session has shown life since the prompt was recorded', async () => {
    await w.spawned('s')
    await w.emit('s', 'turn_started', w.at(10))
    await recordPrompt(
      db.sql,
      { id: 'r1', session: 's', source: 'restart', via: 'resume', text: 'cut off' },
      clock.now(),
    )
    clock.advance(10_000)
    await w.emit('s', 'turn_ended', clock.now())
    expect((await deliver()).failed).toEqual(['r1'])
    expect((await row('r1')).error).toContain('came back')
    expect(runner.started).toEqual([])
  })

  test("a prompt nobody could take expires: a rule's after six hours, a note's after a day", async () => {
    await w.spawned('s')
    await w.emit('s', 'turn_started', w.at(5))
    await note('n1')
    await recordPrompt(db.sql, { id: 'resume:s:1', session: 's', source: 'resume', text: 'continue' }, clock.now())
    clock.advance(PENDING_TTL_MS.rule + 1_000)
    await deliver()
    expect((await row('resume:s:1')).error).toContain('expired')
    expect((await row('n1')).status).toBe('pending')
    clock.advance(PENDING_TTL_MS.note)
    await deliver()
    expect((await row('n1')).status).toBe('failed')
  })
})

describe('the herdr adapter types into the agent', () => {
  let herdr: FakeHerdr
  beforeAll(async () => {
    herdr = await createFakeHerdr()
  })
  afterAll(() => herdr.cleanup())

  const start = async () => {
    await herdr.reset()
    const r = new HerdrRunner({
      bin: herdr.bin,
      clock,
      pretrustBin: herdr.pretrustBin,
      accountsFile: herdr.accountsFile,
      home: '/home/me',
      deliverWaitMs: 3_000,
    })
    const { session } = await r.start({
      key: 'k1',
      repo: '/work/repo',
      prompt: 'first',
      account: 'a',
      tier: 'sonnet',
      effort: 'high',
    })
    return { r, pane: session }
  }
  test('submits the text to an agent that is not working, and leaves a working one alone', async () => {
    const { r, pane } = await start()
    expect(await r.type({ pane, text: 'second' })).toBe('busy')
    expect((await herdr.state()).prompts.map((p) => p.text)).toEqual(['first'])

    await herdr.setAgentStatus(pane, 'idle')
    expect(await r.type({ pane, text: 'second' })).toBe('typed')
    expect((await herdr.state()).prompts.map((p) => p.text)).toEqual(['first', 'second'])
  })

  test('a prompt call that dies without an answer is uncertain; an error body from herdr is a refusal', async () => {
    const { r, pane } = await start()
    await herdr.setAgentStatus(pane, 'idle')
    await herdr.plan('agent prompt:exit1')
    expect(await r.type({ pane, text: 'second' }).catch((e: unknown) => e)).toBeInstanceOf(UncertainTyping)
    await herdr.plan('agent prompt:error')
    const refused = await r.type({ pane, text: 'second' }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(Error)
    expect(refused).not.toBeInstanceOf(UncertainTyping)
  })

  test('an agent herdr cannot read is an error and nothing is sent', async () => {
    const { r, pane } = await start()
    await herdr.plan('agent get:unreadable')
    const error = await r.type({ pane, text: 'second' }).catch((e: unknown) => e)
    expect((error as Error).message).toContain('unreadable')
    expect((await herdr.state()).prompts).toHaveLength(1)
  })
})
