import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  CONFIRM_MS,
  deliverPrompts,
  FAILURE_RETRY_MS,
  listOpenPrompts,
  STATUS_PROMPTS,
  MAX_FAILURES,
  PENDING_TTL_MS,
  recordPrompt,
  TYPING_LEASE_MS,
} from '../src/prompts.ts'
import { recordReading } from '../src/capacity.ts'
import { setQueue } from '../src/queue.ts'
import { createSpawn } from '../src/spawns.ts'
import { HerdrRunner, UncertainTyping } from '../src/runner.ts'
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
    expect((await listOpenPrompts(db.sql, clock.now())).prompts.map((p) => [p.id, p.status])).toEqual([
      ['n1', 'failed'],
    ])
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
  test('a sent prompt that is both overdue and proven by a turn is delivered, not typed again', async () => {
    await working()
    await endTurn()
    await note('n1')
    await deliver()
    clock.advance(CONFIRM_MS + 5_000)
    await startTurn()
    await deliver()
    expect(await row('n1')).toMatchObject({ status: 'delivered', sent_count: 1, error: null })
    expect(runner.typed).toHaveLength(1)
  })

  test('only one prompt is typed to a session in a pass: the second waits for the first to show a turn', async () => {
    await working()
    await endTurn()
    await note('a')
    await note('b')
    expect((await deliver()).sent).toEqual(['a'])
    expect((await row('b')).status).toBe('pending')
    clock.advance(1_000)
    await startTurn()
    await endTurn()
    expect((await deliver()).sent).toEqual(['b'])
    expect(runner.typed.map((t) => t.text)).toHaveLength(2)
  })

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
    expect((await listOpenPrompts(db.sql, clock.now())).prompts.map((p) => p.id)).toEqual(['old'])
    clock.advance(25 * 3_600_000)
    expect(await listOpenPrompts(db.sql, clock.now())).toEqual({ prompts: [], more: 0 })
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

describe('prompt delivery: one at a time, and resumes are admitted', () => {
  test('a later prompt waits across passes while an earlier one is sent and unproven', async () => {
    await working()
    await endTurn()
    await note('a')
    await deliver()
    await note('b')
    clock.advance(5_000)
    // The session is still idle as far as the hooks know (the first turn has not started): b must not be typed yet.
    expect((await deliver()).sent).toEqual([])
    expect(runner.typed.map((t) => t.text)).toHaveLength(1)
    await startTurn()
    await endTurn()
    expect((await deliver()).sent).toEqual(['b'])
  })

  test('a retry is not typed when a turn showed up that the settle did not see', async () => {
    await working()
    await endTurn()
    await note('n1')
    await deliver()
    // A retry row as the settle leaves it, and a turn that started after its claim.
    await db.sql`UPDATE factory.prompts SET status = 'pending', next_at = ${clock.now()} WHERE id = 'n1'`
    clock.advance(1_000)
    await startTurn()
    await endTurn()
    await deliver()
    expect(await row('n1')).toMatchObject({ status: 'delivered', sent_count: 1 })
    expect(runner.typed).toHaveLength(1)
  })

  test('a busy agent leaves no claim behind: a later, unrelated turn does not make an untyped retry delivered', async () => {
    await working()
    await endTurn()
    await note('n1')
    await deliver()
    clock.advance(CONFIRM_MS + 1_000)
    runner.answer = 'busy'
    await deliver()
    expect(await db.sql`SELECT status, claimed_at FROM factory.prompts WHERE id = 'n1'`).toEqual([
      { status: 'pending', claimed_at: null },
    ])
    // The session runs a turn of its own meanwhile; it proves nothing about the note.
    runner.answer = 'typed'
    await startTurn()
    await endTurn()
    await deliver()
    expect(await row('n1')).toMatchObject({ status: 'sent', sent_count: 2 })
    expect(runner.typed).toHaveLength(2)
  })

  const resume = async () => {
    await w.spawned('s', { account: 'a' })
    await w.emit('s', 'turn_started', w.at(10))
    await recordPrompt(
      db.sql,
      { id: 'restart:x:s', session: 's', source: 'restart', via: 'resume', text: 'cut off' },
      clock.now(),
    )
  }
  const open = (account: string) =>
    recordReading(db.sql, { account, ...usage(10, 10, new Date(clock.now().getTime() + 3_600_000)) }, clock.now())

  test('a herdr-restart resume under drain starts nothing, and starts once the queue runs again', async () => {
    await resume()
    await open('a')
    await setQueue(db.sql, null, 'drain', clock.now())
    expect((await deliver()).sent).toEqual([])
    expect(runner.started).toEqual([])
    expect(await row('restart:x:s')).toMatchObject({ status: 'pending', error: 'held: drain' })

    await setQueue(db.sql, null, 'run', clock.now())
    expect((await deliver()).sent).toEqual(['restart:x:s'])
    expect(runner.started).toHaveLength(1)
    expect(runner.started[0]).toMatchObject({ key: 's', account: 'a', resume: 'claude-s' })
  })

  test('is held without room on its account, even if another account has some', async () => {
    await resume()
    await recordReading(
      db.sql,
      { account: 'a', ...usage(10, 100, new Date(clock.now().getTime() + 3_600_000)) },
      clock.now(),
    )
    await open('b')
    expect((await deliver()).sent).toEqual([])
    expect(runner.started).toEqual([])
    expect((await row('restart:x:s')).error).toContain('held')
    expect((await row('restart:x:s')).status).toBe('pending')
  })

  test('the reservation is made where the capacity is checked: a spawn claim during the start sees the account taken', async () => {
    await resume()
    await open('a')
    let other: string | undefined
    runner.onStart = async () => {
      const { spawn } = await createSpawn(
        db.sql,
        { key: 'other', repo: '/work/other', prompt: 'p', role: 'worker', tier: 'sonnet', effort: 'high' },
        clock.now(),
      )
      other = spawn.status
    }
    await deliver()
    expect(runner.started).toHaveLength(1)
    // Only account `a` has room, and the resume holds it: the new spawn waits.
    expect(other).toBe('waiting')
  })

  test('a start that fails gives the account back', async () => {
    await resume()
    await open('a')
    const [{ assigned_at: before }] = await db.sql`SELECT assigned_at FROM factory.spawns WHERE key = 's'`
    runner.failure = new Error('herdr agent start: exited 1')
    await deliver()
    const [{ assigned_at: after }] = await db.sql`SELECT assigned_at FROM factory.spawns WHERE key = 's'`
    expect(new Date(after).getTime()).toBe(new Date(before).getTime())
    expect(await row('restart:x:s')).toMatchObject({ status: 'pending', failures: 1 })
  })

  test('a resume uses up the capacity it was admitted on: the spawn counts as assigned from now', async () => {
    await resume()
    await open('a')
    await deliver()
    const [spawn] = await db.sql`SELECT assigned_at FROM factory.spawns WHERE key = 's'`
    expect(new Date(spawn.assigned_at).getTime()).toBe(clock.now().getTime())
  })
})

describe('the open prompts in status', () => {
  test('failed ones come first, and what does not fit is counted', async () => {
    await w.spawned('s')
    await w.emit('s', 'turn_started', w.at(5))
    for (let i = 0; i < STATUS_PROMPTS + 2; i++) await note(`p-${String(i).padStart(3, '0')}`, 'x')
    await recordPrompt(db.sql, { id: 'bad', session: 's', source: 'restart', text: 'x', failed: 'no' }, clock.now())
    const { prompts: shown, more } = await listOpenPrompts(db.sql, clock.now())
    expect(shown).toHaveLength(STATUS_PROMPTS)
    expect(shown[0]?.id).toBe('bad')
    expect(more).toBe(3)
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

  test('types nothing into an agent that is blocked on a dialog, or whose state herdr does not know', async () => {
    const { r, pane } = await start()
    for (const status of ['blocked', 'unknown', 'working']) {
      await herdr.setAgentStatus(pane, status)
      expect(await r.type({ pane, text: 'second' })).toBe('busy')
    }
    await herdr.setAgentStatus(pane, 'done')
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
