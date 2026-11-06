import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { SQL } from 'bun'
import {
  BUDGET_HOURS,
  FINISHED_HEALTH_MS,
  HEARTBEAT_STALE_MS,
  healthKind,
  healthLines,
  heartbeat,
  SILENT_AFTER_MS,
} from '../src/health.ts'
import { MAX_REGRESSIONS } from '../src/issues/lifecycle.ts'
import { recordPrompt } from '../src/prompts.ts'
import { buildStatus } from '../src/status.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

const MIN = 60_000
const HOUR = 3_600_000

let db: TestDb
let clock: FakeClock
const sql = (): SQL => db.sql
const ago = (ms: number): Date => new Date(clock.now().getTime() - ms)

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(async () => {
  await db.stop()
})
beforeEach(async () => {
  await db.reset()
  clock = new FakeClock()
})

let seq = 0
/** An Issue in a state, with the events that put it there; `workingAt` is the time of its latest transition to `working`. */
async function issue(
  state: string,
  opts: { size?: string; reason?: string; attempt?: number; workingAt?: Date; updatedAt?: Date } = {},
): Promise<number> {
  const updated = opts.updatedAt ?? opts.workingAt ?? clock.now()
  const [row]: { id: number }[] = await sql()`
    INSERT INTO factory.issues (state, source, source_key, repo, title, facts, size, reason, attempt, created_at, updated_at)
    VALUES (${state}, 'request', ${`k${++seq}`}, '/r', 't', '{}'::jsonb, ${opts.size ?? null}, ${opts.reason ?? null}, ${opts.attempt ?? 1}, ${updated}, ${updated})
    RETURNING id`
  const id = row?.id ?? 0
  if (opts.workingAt) await event(id, 'admitted', 'working', opts.workingAt)
  return id
}

async function event(id: number, kind: string, to: string | null, at: Date): Promise<void> {
  await sql()`
    INSERT INTO factory.issue_events (issue_id, key, kind, from_state, to_state, at)
    VALUES (${id}, ${`e${++seq}`}, ${kind}, NULL, ${to}, ${at})`
}

async function sessionEvent(session: string, at: Date): Promise<void> {
  await sql()`INSERT INTO factory.events (key, session, kind, at) VALUES (${`s${++seq}`}, ${session}, 'turn_started', ${at})`
}

describe('the heartbeat', () => {
  test('a tick under 30 minutes old and an empty queue are ok, with the four names the pusher reads', async () => {
    const beat = await heartbeat(sql(), clock.now(), ago(29 * MIN).toISOString())
    expect(beat).toEqual({ ok: true, reason: null, tickAt: ago(29 * MIN).toISOString(), queueMovedAt: null })
  })

  test('a tick 30 minutes old, or none yet, fails and says so', async () => {
    const old = await heartbeat(sql(), clock.now(), ago(HEARTBEAT_STALE_MS).toISOString())
    expect(old).toMatchObject({ ok: false, reason: 'no successful tick for 30 min' })
    expect(await heartbeat(sql(), clock.now(), null)).toMatchObject({ ok: false, reason: 'no tick has succeeded yet' })
  })

  async function spawn(key: string, status: string, changed: Date, extra: { hold?: string; resume?: Date } = {}) {
    await sql()`
      INSERT INTO factory.spawns (key, repo, prompt, status, hold, resume_at, assigned_at, created_at)
      VALUES (${key}, '/r', 'p', ${status}, ${extra.hold ?? null}, ${extra.resume ?? null}, ${changed}, ${changed})`
  }

  test('queueMovedAt is the newest status change of any spawn', async () => {
    await spawn('a', 'started', ago(3 * HOUR))
    await spawn('b', 'started', ago(40 * MIN))
    const beat = await heartbeat(sql(), clock.now(), clock.now().toISOString())
    expect(beat).toMatchObject({ ok: true, queueMovedAt: ago(40 * MIN).toISOString() })
  })

  test('a queued spawn with no hold, due for 30 minutes, fails the queue half; held and young ones do not', async () => {
    await spawn('held', 'queued', ago(5 * HOUR), { hold: 'pace' })
    await spawn('young', 'queued', ago(29 * MIN))
    const tick = clock.now().toISOString()
    expect((await heartbeat(sql(), clock.now(), tick)).ok).toBe(true)
    await spawn('stale', 'queued', ago(31 * MIN))
    expect(await heartbeat(sql(), clock.now(), tick)).toMatchObject({
      ok: false,
      reason: 'spawn stale due for 31 min without a change of status',
    })
  })

  test('a waiting spawn counts from its resume_at, and only once that is past', async () => {
    await spawn('later', 'waiting', ago(2 * HOUR), { resume: new Date(clock.now().getTime() + HOUR) })
    const tick = clock.now().toISOString()
    expect((await heartbeat(sql(), clock.now(), tick)).ok).toBe(true)
    await spawn('due', 'waiting', ago(2 * HOUR), { resume: ago(45 * MIN) })
    expect(await heartbeat(sql(), clock.now(), tick)).toMatchObject({
      ok: false,
      reason: 'spawn due due for 45 min without a change of status',
    })
  })

  test('both halves failing are both named', async () => {
    await spawn('stale', 'queued', ago(HOUR))
    const beat = await heartbeat(sql(), clock.now(), ago(HOUR).toISOString())
    expect(beat.reason).toBe('no successful tick for 60 min; spawn stale due for 60 min without a change of status')
  })
})

describe('the new health lines', () => {
  test('a working Issue whose lead has stored no event for 20 minutes is silent; any event counts', async () => {
    const id = await issue('working', { workingAt: ago(HOUR), size: 'l' })
    await sessionEvent(`lead-${id}-1`, ago(SILENT_AFTER_MS - MIN))
    expect(await healthLines(sql(), clock.now())).toEqual([])
    await sessionEvent(`lead-${id}-1`, ago(SILENT_AFTER_MS))
    // the newest event is the one that counts, so this older one changes nothing
    expect(await healthLines(sql(), clock.now())).toEqual([])
    clock.advance(2 * MIN)
    expect(await healthLines(sql(), clock.now())).toEqual([`Issue ${id}: no hook event for 21 min`])
  })

  test('a lead that never stored an event is silent from the moment the Issue began working', async () => {
    const id = await issue('working', { workingAt: ago(25 * MIN), size: 'l' })
    expect(await healthLines(sql(), clock.now())).toEqual([`Issue ${id}: no hook event for 25 min`])
  })

  test("another attempt's events say nothing about this lead", async () => {
    const id = await issue('working', { workingAt: ago(HOUR), size: 'l', attempt: 2 })
    await sessionEvent(`lead-${id}-1`, ago(MIN))
    expect(await healthLines(sql(), clock.now())).toEqual([`Issue ${id}: no hook event for 60 min`])
  })

  test('over budget by size: s 2 h, m 6 h, l 24 h, unknown counts as m', async () => {
    const quiet = async (id: number) => sessionEvent(`lead-${id}-1`, ago(MIN))
    const s = await issue('working', { size: 's', workingAt: ago(2 * HOUR + 6 * MIN) })
    const sOk = await issue('working', { size: 's', workingAt: ago(2 * HOUR - MIN) })
    const m = await issue('working', { size: 'm', workingAt: ago(5 * HOUR) })
    const l = await issue('working', { size: 'l', workingAt: ago(25 * HOUR) })
    const none = await issue('working', { workingAt: ago(7 * HOUR) })
    for (const id of [s, sOk, m, l, none]) await quiet(id)
    expect(BUDGET_HOURS).toEqual({ s: 2, m: 6, l: 24 })
    expect(await healthLines(sql(), clock.now())).toEqual([
      `Issue ${s}: working 2.1 h, budget 2 h (size s)`,
      `Issue ${l}: working 25 h, budget 24 h (size l)`,
      `Issue ${none}: working 7 h, budget 6 h (size unknown)`,
    ])
  })

  test('the budget counts from the latest transition to working', async () => {
    const id = await issue('working', { size: 's', workingAt: ago(5 * HOUR) })
    await event(id, 'wake', 'working', ago(30 * MIN))
    await sessionEvent(`lead-${id}-1`, ago(MIN))
    expect(await healthLines(sql(), clock.now())).toEqual([])
  })

  test('an Issue that is not working is neither silent nor over budget', async () => {
    await issue('waiting', { reason: 'decision', updatedAt: ago(48 * HOUR) })
    await issue('queued')
    expect(await healthLines(sql(), clock.now())).toEqual([])
  })

  test('exactly two regressions on an open Issue; the park (a third) is a park line instead', async () => {
    const id = await issue('working', { size: 'l', workingAt: ago(10 * MIN) })
    await sessionEvent(`lead-${id}-1`, ago(MIN))
    await event(id, 'regression', 'working', ago(2 * HOUR))
    expect(await healthLines(sql(), clock.now())).toEqual([])
    await event(id, 'regression', 'working', ago(HOUR))
    expect(await healthLines(sql(), clock.now())).toEqual([
      `Issue ${id}: ${MAX_REGRESSIONS} regressions, the next one parks it`,
    ])
    await sql()`UPDATE factory.issues SET state = 'waiting', reason = 'parked' WHERE id = ${id}`
    expect(await healthLines(sql(), clock.now())).toEqual([])
    await sql()`UPDATE factory.issues SET state = 'closed', reason = NULL, outcome = 'dropped', closed_at = now() WHERE id = ${id}`
    expect(await healthLines(sql(), clock.now())).toEqual([])
  })
})

describe('asks and health are two lists', () => {
  test('a park is a health line with its reason and age, never an ask; a blocked Issue is an ask', async () => {
    const gone = await issue('waiting', { reason: 'lead_gone', updatedAt: ago(3 * HOUR) })
    const unreported = await issue('waiting', { reason: 'unreported', updatedAt: ago(10 * MIN) })
    const wall = await issue('waiting', { reason: 'wall', updatedAt: ago(5 * MIN) })
    const parked = await issue('waiting', { reason: 'parked', updatedAt: ago(MIN) })
    const blocked = await issue('waiting', { reason: 'blocked', updatedAt: ago(MIN) })
    const s = await buildStatus(sql(), clock.now())
    expect(s.attention).toEqual([`Issue ${blocked} blocked`])
    expect(s.health).toEqual([
      `Issue ${gone} parked for 3 h: its lead is gone`,
      `Issue ${unreported} parked for 10 min: its lead stopped twice with nothing reported`,
      `Issue ${wall} parked for 5 min: its account hit a limit wall`,
      `Issue ${parked} parked for 1 min`,
      // FACTORY_ALERT_LEADS is off by default in buildStatus: no alert is queued here, so no such line
    ])
  })

  test('the machine failures of an Issue are health lines', async () => {
    const id = await issue('queued')
    await sql()`INSERT INTO factory.issue_effects (issue_id, key, kind, created_at, error) VALUES (${id}, 'k1', 'start_lead', ${clock.now()}, 'hc is down')`
    const s = await buildStatus(sql(), clock.now())
    expect(s.attention).toEqual([])
    expect(s.health).toEqual([`Issue ${id}: its lead did not start: hc is down`])
  })

  test('the new lines reach factory status health, not attention', async () => {
    const id = await issue('working', { workingAt: ago(30 * MIN), size: 'l' })
    const s = await buildStatus(sql(), clock.now())
    expect(s.attention).toEqual([])
    expect(s.health).toEqual([`Issue ${id}: no hook event for 30 min`])
  })
})

describe('healthKind', () => {
  test('park, silent, over_budget, regressions; everything else is a machine failure', () => {
    expect(healthKind('Issue 7 parked for 5 min: its lead is gone')).toBe('park')
    expect(healthKind('Issue 7: no hook event for 25 min')).toBe('silent')
    expect(healthKind('Issue 7: working 2.5 h, budget 2 h (size s)')).toBe('over_budget')
    expect(healthKind('Issue 7: 2 regressions, the next one parks it')).toBe('regressions')
    for (const line of [
      'stuck w1: nothing moved for 40 min',
      'spawn k failed: x',
      'Issue 7: it cannot be finalized: x',
    ]) {
      expect(healthKind(line)).toBe('machine')
    }
  })
})

describe('a line about something finished ends 72 h after it finished', () => {
  const health = async (): Promise<string[]> => (await buildStatus(sql(), clock.now())).health

  async function failedSpawn(key: string, at: Date): Promise<void> {
    await sql()`
      INSERT INTO factory.spawns (key, repo, prompt, status, error, created_at)
      VALUES (${key}, '/r', 'p', 'failed', 'hc exited 1', ${at})`
  }
  async function failedNotification(key: string, at: Date): Promise<void> {
    await sql()`
      INSERT INTO factory.notifications (key, kind, text, created_at, next_at, attempts, error, failed_at)
      VALUES (${key}, 'test', 't', ${at}, ${at}, 5, 'gone', ${at})`
  }

  test('the constant is 72 h', () => {
    expect(FINISHED_HEALTH_MS).toBe(72 * HOUR)
  })

  test('a failed spawn: present at 71 h, gone at 73 h', async () => {
    await failedSpawn('young', ago(71 * HOUR))
    await failedSpawn('old', ago(73 * HOUR))
    expect(await health()).toEqual(['spawn young failed: hc exited 1'])
  })

  test('a failed note: present at 71 h, gone at 73 h', async () => {
    await recordPrompt(
      sql(),
      { id: 'n-young', session: 's', source: 'note', text: 'x', failed: 'gave up' },
      ago(71 * HOUR),
    )
    await recordPrompt(
      sql(),
      { id: 'n-old', session: 's', source: 'note', text: 'x', failed: 'gave up' },
      ago(73 * HOUR),
    )
    expect(await health()).toEqual(['note n-young to s failed: gave up'])
  })

  test('a failed notification: present at 71 h, gone at 73 h', async () => {
    await failedNotification('notify:test:young', ago(71 * HOUR))
    await failedNotification('notify:test:old', ago(73 * HOUR))
    expect(await health()).toEqual(['notification notify:test:young was not delivered: gone'])
  })

  test('a kept worktree: present at 71 h, gone at 73 h', async () => {
    const id = await issue('queued')
    await sql()`
      INSERT INTO factory.issue_events (issue_id, key, kind, payload, at) VALUES
        (${id}, 'wk1', 'worktree_kept', '{"path":"/w/a","kept":"dirty"}'::jsonb, ${ago(71 * HOUR)}),
        (${id}, 'wk2', 'worktree_kept', '{"path":"/w/b","kept":"dirty"}'::jsonb, ${ago(73 * HOUR)})`
    expect(await health()).toEqual([`Issue ${id}: its worktree was kept (dirty): /w/a`])
  })

  test('an ongoing line of the same age stays, with its id unchanged', async () => {
    const id = await issue('waiting', { reason: 'lead_gone', updatedAt: ago(100 * HOUR) })
    const silent = await issue('working', { workingAt: ago(100 * HOUR), size: 'l' })
    const lines = await health()
    expect(lines).toContain(`Issue ${id} parked for 100 h: its lead is gone`)
    expect(lines).toContain(`Issue ${silent}: no hook event for 6000 min`)
  })
})

describe('a decision that holds the repo', () => {
  async function claim(id: number, heldAt: Date | null, queuedAt: Date): Promise<void> {
    await sql()`
      INSERT INTO factory.claims (key, issue_id, urgent, queued_at, held_at)
      VALUES ('repo:iris', ${id}, false, ${queuedAt}, ${heldAt})`
  }

  test('one line once another Issue has been queued behind it for 15 min, naming the first and counting the rest', async () => {
    const holder = await issue('waiting', { reason: 'decision' })
    await claim(holder, ago(40 * MIN), ago(40 * MIN))
    const first = await issue('queued')
    const second = await issue('queued')
    await claim(first, null, ago(16 * MIN))
    await claim(second, null, ago(15 * MIN))
    expect(await healthLines(sql(), clock.now())).toEqual([
      `Issue ${holder} waits on the owner's decision and holds iris for 40 min: Issue ${first} (and 1 more) queued behind it`,
    ])
  })

  test('no line before 15 min, for one that is not waiting on a decision, or when nothing is queued', async () => {
    const holder = await issue('waiting', { reason: 'decision' })
    await claim(holder, ago(40 * MIN), ago(40 * MIN))
    const young = await issue('queued')
    await claim(young, null, ago(14 * MIN))
    expect(await healthLines(sql(), clock.now())).toEqual([])

    await sql()`UPDATE factory.claims SET queued_at = ${ago(20 * MIN)} WHERE issue_id = ${young}`
    await sql()`UPDATE factory.issues SET reason = 'wait' WHERE id = ${holder}`
    expect(await healthLines(sql(), clock.now())).toEqual([])
    await sql()`UPDATE factory.issues SET reason = 'decision' WHERE id = ${holder}`
    await sql()`UPDATE factory.issues SET state = 'working' WHERE id = ${young}`
    expect(await healthLines(sql(), clock.now())).toEqual([])
  })
})
