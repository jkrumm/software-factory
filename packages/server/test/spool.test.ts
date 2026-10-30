import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  EMPTY_SUMMARY,
  nextKey,
  parseSpool,
  parseSummary,
  type SpoolLine,
  spoolFileName,
  summarize,
} from '@software-factory/contract/spool'
import { recordReading } from '../src/capacity.ts'
import { getSession, recordEvent } from '../src/sessions.ts'
import { createSpawn } from '../src/spawns.ts'
import { SpoolReplayer } from '../src/spool.ts'
import { type Runner, type StartInput } from '../src/runner.ts'
import { tick } from '../src/tick.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

let db: TestDb
let dir: string
let clock: FakeClock

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(async () => {
  await db.stop()
})
beforeEach(async () => {
  await db.reset()
  dir = mkdtempSync('/tmp/factory-spool-')
  clock = new FakeClock()
})

const replayer = (extra: { rotateBytes?: number; quietMs?: number } = {}) =>
  new SpoolReplayer({ sql: db.sql, dir, now: () => clock.now(), ...extra })
const fileOf = (session: string) => join(dir, spoolFileName(session))
const count = async () => ((await db.sql`SELECT count(*)::int AS n FROM factory.events`)[0] as { n: number }).n

/** What a hook appends: the next key from the file as it is, one line. */
function hookAppend(
  session: string,
  kind: SpoolLine['kind'],
  at: string,
  payload?: Record<string, unknown>,
): SpoolLine {
  const file = fileOf(session)
  const lines = existsSync(file) ? parseSpool(readFileSync(file, 'utf8')) : []
  const base = existsSync(`${file}.base`) ? parseSummary(readFileSync(`${file}.base`, 'utf8')) : EMPTY_SUMMARY
  const line: SpoolLine = { key: nextKey(summarize(base, lines), session, kind), session, kind, at, payload }
  appendFileSync(file, `${JSON.stringify(line)}\n`)
  return line
}

describe('spool replay', () => {
  test('stores what the hooks appended, once, however often it is read', async () => {
    hookAppend('s', 'session_started', '2026-10-30T10:00:00.000Z', { claudeSessionId: 'c-1' })
    hookAppend('s', 'turn_started', '2026-10-30T10:01:00.000Z')
    const r = replayer()
    expect((await r.replay()).lines).toBe(2)
    expect((await r.replay()).lines).toBe(0)
    expect(await count()).toBe(2)

    hookAppend('s', 'turn_ended', '2026-10-30T10:02:00.000Z')
    expect((await r.replay()).lines).toBe(1)
    expect(await count()).toBe(3)
  })

  test('a restart posts everything again and the keys make it one event each', async () => {
    hookAppend('s', 'session_started', '2026-10-30T10:00:00.000Z')
    hookAppend('s', 'turn_started', '2026-10-30T10:01:00.000Z')
    await replayer().replay()
    const second = await replayer().replay()
    expect(second.lines).toBe(2)
    expect(await count()).toBe(2)
  })

  test('a line the hook already posted live is the same event when the spool brings it again', async () => {
    const line = hookAppend('s', 'turn_started', '2026-10-30T10:01:00.000Z')
    await db.sql`INSERT INTO factory.events (key, session, kind, at) VALUES (${line.key}, 's', 'turn_started', ${line.at})`
    await replayer().replay()
    expect(await count()).toBe(1)
  })

  test('a write still in flight (no newline yet) is read on the next pass, whole', async () => {
    const half = JSON.stringify({
      key: 's:turn_started:1',
      session: 's',
      kind: 'turn_started',
      at: '2026-10-30T10:01:00.000Z',
    })
    writeFileSync(fileOf('s'), half.slice(0, 20))
    const r = replayer()
    expect((await r.replay()).lines).toBe(0)
    appendFileSync(fileOf('s'), `${half.slice(20)}\n`)
    expect((await r.replay()).lines).toBe(1)
    expect(await count()).toBe(1)
  })

  test('a line that is not an event is rejected and does not hold up the rest', async () => {
    writeFileSync(
      fileOf('s'),
      [
        'not json',
        JSON.stringify({ key: 'x', session: 's', kind: 'not_a_kind', at: '2026-10-30T10:00:00.000Z' }),
        JSON.stringify({ key: 'ok', session: 's', kind: 'turn_started', at: '2026-10-30T10:01:00.000Z' }),
        '',
      ].join('\n'),
    )
    const result = await replayer().replay()
    expect(result).toMatchObject({ lines: 1, rejected: 1 })
    expect(await count()).toBe(1)
  })

  test('a missing spool directory is nothing to replay', async () => {
    rmSync(dir, { recursive: true })
    expect(await replayer().replay()).toEqual({ lines: 0, rejected: 0, rotated: [] })
  })

  test('the tick replays the spool before it claims anything', async () => {
    hookAppend('s', 'session_started', '2026-10-30T10:00:00.000Z')
    const runner: Runner = { start: async (_input: StartInput) => ({ session: 'p' }) }
    const result = await tick({ sql: db.sql, runner, clock, spool: replayer() })
    expect(result.replayed).toBe(1)
    expect(await count()).toBe(1)
  })
})

describe('rotation', () => {
  const big = (session: string, turns: number) => {
    for (let i = 0; i < turns; i++) {
      hookAppend(
        session,
        'turn_started',
        `2026-10-30T10:${String(i % 60).padStart(2, '0')}:00.${String(i % 1000).padStart(3, '0')}Z`,
        { pad: 'x'.repeat(100) },
      )
    }
  }
  // The replayer's clock is the fake one, so "quiet for an hour" is measured against it.
  const age = (file: string) => {
    const quiet = new Date(clock.now().getTime() - 3_600_000)
    utimesSync(file, quiet, quiet)
  }

  test('an acknowledged, large, quiet spool is retired and numbering carries on from its .base', async () => {
    big('s', 40)
    hookAppend('s', 'prompt_idle', '2026-10-30T11:00:00.000Z')
    const r = replayer({ rotateBytes: 1000, quietMs: 1000 })
    age(fileOf('s'))
    expect((await r.replay()).rotated).toEqual([spoolFileName('s')])

    expect(existsSync(fileOf('s'))).toBe(false)
    expect(readdirSync(dir).filter((f) => f.endsWith('.retired'))).toEqual([])
    expect(parseSummary(await Bun.file(`${fileOf('s')}.base`).text())).toMatchObject({
      turns: 40,
      current: { turn_started: 1, prompt_idle: 1 },
    })

    // The next hook starts a new file and still counts from 41, and the sums keep the turn's events.
    expect(hookAppend('s', 'turn_started', '2026-10-30T11:05:00.000Z').key).toBe('s:turn_started:41')
    expect(await count()).toBe(41)
  })

  test('a repeated kind in the turn that was rotated away gets the next ordinal, not the first key again', async () => {
    big('s', 40)
    hookAppend('s', 'prompt_idle', '2026-10-30T11:00:00.000Z')
    const r = replayer({ rotateBytes: 1000, quietMs: 1000 })
    age(fileOf('s'))
    expect((await r.replay()).rotated).toEqual([spoolFileName('s')])
    expect(hookAppend('s', 'prompt_idle', '2026-10-30T11:01:00.000Z').key).toBe('s:prompt_idle:40:2')
  })

  test("not while a hook holds the session's lock; rotates once it lets go", async () => {
    big('s', 40)
    const r = replayer({ rotateBytes: 1000, quietMs: 1000 })
    age(fileOf('s'))
    mkdirSync(`${fileOf('s')}.lock`)
    expect((await r.replay()).rotated).toEqual([])
    expect(existsSync(fileOf('s'))).toBe(true)
    rmdirSync(`${fileOf('s')}.lock`)
    expect((await r.replay()).rotated).toEqual([spoolFileName('s')])
    expect(existsSync(`${fileOf('s')}.lock`)).toBe(false)
  })

  test('a line a hook wrote without the lock is stored like any other', async () => {
    big('s', 40)
    const r = replayer({ rotateBytes: 1000, quietMs: 1000 })
    age(fileOf('s'))
    await r.replay()
    // Appended after the file was fully read and before it is rotated again.
    big('s', 1)
    appendFileSync(
      fileOf('s'),
      `${JSON.stringify({ key: 's:stray:abc', session: 's', kind: 'prompt_idle', at: '2026-10-30T11:30:00.000Z' })}\n`,
    )
    age(fileOf('s'))
    expect((await r.replay()).lines).toBe(2)
    expect(await count()).toBe(42)
  })

  test('not while the session is writing, and not before the lines are acknowledged', async () => {
    big('s', 40)
    const r = replayer({ rotateBytes: 1000, quietMs: 60_000 })
    const justNow = new Date(clock.now().getTime() - 10_000)
    utimesSync(fileOf('s'), justNow, justNow)
    expect((await r.replay()).rotated).toEqual([])
    expect(statSync(fileOf('s')).size).toBeGreaterThan(1000)
  })
})

describe('session_started binds', () => {
  const spawnStarted = async (key: string, pane: string) => {
    await recordReading(
      db.sql,
      'a',
      { weeklyUsed: 1, fiveHourUsed: 1, resetsAt: new Date(clock.now().getTime() + 3_600_000) },
      clock.now(),
    )
    await createSpawn(db.sql, { key, repo: '/work/repo', prompt: 'p' }, clock.now())
    const runner: Runner = { start: async () => ({ session: pane }) }
    await tick({ sql: db.sql, runner, clock })
  }

  test('a spawn is a session as soon as it has its pane: `starting` until its first event', async () => {
    await spawnStarted('spawn-1', 'w1:p1')
    expect(await getSession(db.sql, 'spawn-1', clock.now())).toMatchObject({
      id: 'spawn-1',
      state: 'starting',
      spawn: 'spawn-1',
      pane: 'w1:p1',
      claudeSessionId: null,
    })
  })

  test("session_started binds Claude's session id, transcript path and cwd to the spawn", async () => {
    await spawnStarted('spawn-1', 'w1:p1')
    hookAppend('spawn-1', 'session_started', '2026-10-30T10:00:00.000Z', {
      source: 'startup',
      claudeSessionId: 'c-1',
      transcriptPath: '/t/c-1.jsonl',
      cwd: '/work/repo',
    })
    await replayer().replay()
    expect(await getSession(db.sql, 'spawn-1', clock.now())).toMatchObject({
      state: 'idle',
      spawn: 'spawn-1',
      pane: 'w1:p1',
      claudeSessionId: 'c-1',
      transcriptPath: '/t/c-1.jsonl',
      cwd: '/work/repo',
    })
  })

  test('an rd agent name that no spawn made gets its own row, with no spawn', async () => {
    hookAppend('software-factory-w2', 'session_started', '2026-10-30T10:00:00.000Z', {
      claudeSessionId: 'c-2',
      transcriptPath: '/t/c-2.jsonl',
    })
    await replayer().replay()
    expect(await getSession(db.sql, 'software-factory-w2', clock.now())).toMatchObject({
      id: 'software-factory-w2',
      spawn: null,
      pane: null,
      claudeSessionId: 'c-2',
    })
  })

  test('a resume rebinds, and an older session_started arriving late does not undo it', async () => {
    hookAppend('s', 'session_started', '2026-10-30T10:00:00.000Z', { claudeSessionId: 'old' })
    hookAppend('s', 'session_started', '2026-10-30T12:00:00.000Z', { claudeSessionId: 'new', source: 'resume' })
    await replayer().replay()
    await recordEvent(db.sql, {
      key: 'late',
      session: 's',
      kind: 'session_started',
      at: new Date('2026-10-30T09:00:00Z'),
      payload: { claudeSessionId: 'older' },
    })
    expect((await getSession(db.sql, 's', clock.now()))?.claudeSessionId).toBe('new')
  })
})
