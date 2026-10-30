import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSpool, spoolFileName } from '@software-factory/contract/spool'
import { hookMain, runHook, toEvent } from '../src/hook.ts'

const BIN = join(import.meta.dir, '..', 'bin', 'factory.ts')

let dir: string
let socket: string
let received: unknown[]
let delayMs = 0
let stopChecks: string[]
let stopAnswer: unknown
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  dir = mkdtempSync('/tmp/factory-hook-')
  socket = join(dir, 'h.sock')
  server = Bun.serve({
    unix: socket,
    fetch: async (req) => {
      if (delayMs) await Bun.sleep(delayMs)
      if (new URL(req.url).pathname.endsWith('/stop-check')) {
        stopChecks.push(new URL(req.url).pathname)
        return Response.json(stopAnswer)
      }
      received.push(await req.json())
      return Response.json({ duplicate: false }, { status: 201 })
    },
  })
})
afterAll(async () => {
  await server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  received = []
  stopChecks = []
  stopAnswer = { sendBack: false, message: null }
  delayMs = 0
  rmSync(join(dir, 'spool'), { recursive: true, force: true })
})

const spoolDir = () => join(dir, 'spool')
const lines = (session: string) => {
  const file = join(spoolDir(), spoolFileName(session))
  return existsSync(file) ? parseSpool(readFileSync(file, 'utf8')) : []
}
const clockMs = Date.parse('2026-10-30T12:00:00.000Z')
const env = (extra: Record<string, string> = {}) => ({
  HOME: dir,
  FACTORY_SESSION: 's',
  FACTORY_SPOOL_DIR: spoolDir(),
  FACTORY_SOCKET: socket,
  ...extra,
})
const fire = (event: string, input: object | string, extra: Record<string, string> = {}) =>
  runHook(event, {
    env: env(extra),
    stdin: async () => (typeof input === 'string' ? input : JSON.stringify(input)),
    now: () => clockMs,
  })

describe('the payload becomes the §3 event', () => {
  test.each([
    [
      'session-start',
      {
        source: 'resume',
        session_id: 'c-1',
        transcript_path: '/t/c-1.jsonl',
        cwd: '/w',
        model: 'm',
        permission_mode: 'x',
      },
      {
        kind: 'session_started',
        payload: { source: 'resume', claudeSessionId: 'c-1', transcriptPath: '/t/c-1.jsonl', cwd: '/w', model: 'm' },
      },
    ],
    [
      'user-prompt-submit',
      { session_id: 'c-1', prompt: 'secret text' },
      { kind: 'turn_started', payload: { claudeSessionId: 'c-1' } },
    ],
    ['stop', { stop_hook_active: false, last_assistant_message: 'long text' }, { kind: 'turn_ended' }],
    ['stop', { stop_hook_active: true }, { kind: 'turn_ended', payload: { stopHookActive: true } }],
    [
      'stop-failure',
      { error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: 'API Error' },
      { kind: 'limit_stop', payload: { error: 'rate_limit', details: '429 Too Many Requests' } },
    ],
    [
      'notification',
      { notification_type: 'permission_prompt', message: 'Claude needs your permission' },
      { kind: 'prompt_blocked', payload: { message: 'Claude needs your permission' } },
    ],
    ['notification', { notification_type: 'idle_prompt', message: 'waiting' }, { kind: 'prompt_idle' }],
    [
      'notification',
      { notification_type: 'quota_auto_resume_fired' },
      { kind: 'quota_resume', payload: { state: 'fired' } },
    ],
    [
      'notification',
      { notification_type: 'quota_auto_resume_stale' },
      { kind: 'quota_resume', payload: { state: 'stale' } },
    ],
    [
      'notification',
      { notification_type: 'quota_auto_resume_disabled' },
      { kind: 'quota_resume', payload: { state: 'disabled' } },
    ],
    [
      'session-end',
      { reason: 'prompt_input_exit' },
      { kind: 'session_ended', payload: { reason: 'prompt_input_exit' } },
    ],
  ])('%s %j', (event, input, expected) => {
    expect(toEvent(event, input)).toEqual(expected as ReturnType<typeof toEvent>)
  })

  test.each([
    ['stop-failure', { error: 'overloaded' }],
    ['stop-failure', { error: 'server_error' }],
    ['stop-failure', {}],
    ['notification', { notification_type: 'agent_completed' }],
    ['notification', { notification_type: 'auth_success' }],
    ['notification', { notification_type: 'quota_auto_resume_other' }],
    ['notification', {}],
    ['no-such-hook', {}],
  ])('%s %j is not an event the factory uses', (event, input) => {
    expect(toEvent(event, input)).toBeUndefined()
  })

  test('nothing large or private goes into the payload', () => {
    const event = toEvent('notification', { notification_type: 'permission_prompt', message: 'x'.repeat(5000) })
    expect(JSON.stringify(event).length).toBeLessThan(700)
  })
})

describe('factory hook', () => {
  test('without FACTORY_SESSION it does nothing at all and never reads stdin', async () => {
    let read = false
    const code = await hookMain(['stop'], { HOME: dir, FACTORY_SPOOL_DIR: spoolDir(), FACTORY_SOCKET: socket })
    await runHook('stop', {
      env: { HOME: dir, FACTORY_SPOOL_DIR: spoolDir(), FACTORY_SOCKET: socket },
      stdin: async () => {
        read = true
        return '{}'
      },
      now: () => clockMs,
    })
    expect(code).toBe(0)
    expect(read).toBe(false)
    expect(existsSync(spoolDir())).toBe(false)
    expect(received).toEqual([])
  })

  test('appends to the spool, then posts the same line', async () => {
    await fire('session-start', { source: 'startup', session_id: 'c-1', transcript_path: '/t', cwd: '/w' })
    expect(lines('s')).toHaveLength(1)
    expect(received).toEqual(lines('s'))
    expect(lines('s')[0]).toMatchObject({ key: 's:session_started:0', session: 's', kind: 'session_started' })
  })

  test('the key is session, event and turn number counted from the spool: a replay carries the key it was born with', async () => {
    await fire('session-start', { source: 'startup' })
    await fire('user-prompt-submit', {})
    await fire('stop', {})
    await fire('user-prompt-submit', {})
    await fire('notification', { notification_type: 'idle_prompt' })
    await fire('notification', { notification_type: 'idle_prompt' })
    await fire('stop', {})
    await fire('session-end', { reason: 'other' })
    expect(lines('s').map((l) => l.key)).toEqual([
      's:session_started:0',
      's:turn_started:1',
      's:turn_ended:1',
      's:turn_started:2',
      's:prompt_idle:2',
      's:prompt_idle:2:2',
      's:turn_ended:2',
      's:session_ended:2',
    ])
  })

  test('time only moves forward inside a session, even inside one millisecond', async () => {
    await fire('user-prompt-submit', {})
    await fire('stop', {})
    await fire('user-prompt-submit', {})
    const times = lines('s').map((l) => Date.parse(l.at))
    expect(times[1]).toBeGreaterThan(times[0] as number)
    expect(times[2]).toBeGreaterThan(times[1] as number)
  })

  test('sessions have files of their own, named safely', async () => {
    await fire('stop', {}, { FACTORY_SESSION: 'a/b:../c' })
    await fire('stop', {}, { FACTORY_SESSION: 'other' })
    expect(lines('a/b:../c')).toHaveLength(1)
    expect(lines('other')).toHaveLength(1)
    expect(spoolFileName('a/b:../c')).not.toContain('/')
  })

  test('the spool has the event when the server is down, and the hook still returns', async () => {
    const started = performance.now()
    await fire('stop', {}, { FACTORY_SOCKET: join(dir, 'nobody-listens.sock') })
    expect(performance.now() - started).toBeLessThan(250)
    expect(lines('s')).toHaveLength(1)
  })

  test('a server that does not answer is given 300 ms and the event is in the spool', async () => {
    delayMs = 2000
    const started = performance.now()
    await fire('stop', {})
    const took = performance.now() - started
    expect(took).toBeGreaterThanOrEqual(250)
    expect(took).toBeLessThan(900)
    expect(lines('s')).toHaveLength(1)
  })

  test('an unreadable payload still records that the event happened; an unknown hook records nothing', async () => {
    await fire('stop', 'not json at all')
    await fire('stop', '')
    expect(lines('s')).toHaveLength(2)
    await fire('definitely-not-a-hook', {})
    expect(lines('s')).toHaveLength(2)
  })

  test('numbering carries on after a rotation, from the sums it left', async () => {
    const base = join(spoolDir(), `${spoolFileName('s')}.base`)
    await fire('stop', {})
    rmSync(join(spoolDir(), spoolFileName('s')))
    writeFileSync(
      base,
      JSON.stringify({ turns: 40, lastAt: '2026-10-30T11:59:00.000Z', current: { turn_started: 1, prompt_idle: 1 } }),
    )
    await fire('notification', { notification_type: 'idle_prompt' })
    await fire('user-prompt-submit', {})
    expect(lines('s').map((l) => l.key)).toEqual(['s:prompt_idle:40:2', 's:turn_started:41'])
  })

  test('hookMain returns 0 whatever happens', async () => {
    const stdin = async () => '{}'
    const unwritable = { FACTORY_SESSION: 's', FACTORY_SPOOL_DIR: '/proc/nope/never', HOME: '/proc/nope' }
    expect(await hookMain(['stop'], unwritable, stdin)).toBe(0)
    expect(await hookMain([], { FACTORY_SESSION: 's' }, stdin)).toBe(0)
    expect(await hookMain(['stop'], { FACTORY_SESSION: 's' }, stdin)).toBe(0)
    expect(
      await hookMain(['stop'], { FACTORY_SESSION: 's' }, async () => {
        throw new Error('stdin closed')
      }),
    ).toBe(0)
  })
})

describe('the binary', () => {
  const run = async (args: string[], stdin: string, extra: Record<string, string>) => {
    const proc = Bun.spawn(['bun', BIN, ...args], {
      env: { ...process.env, ...extra },
      stdin: new Response(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const started = performance.now()
    const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
    return { stdout, stderr, code, ms: performance.now() - started }
  }

  test('exits 0 at once without FACTORY_SESSION', async () => {
    const r = await run(['hook', 'stop'], '{}', { FACTORY_SESSION: '', FACTORY_SPOOL_DIR: spoolDir() })
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' })
    expect(existsSync(spoolDir())).toBe(false)
  })

  test('spools and posts when run as a process, exit 0, quietly', async () => {
    const r = await run(['hook', 'user-prompt-submit'], JSON.stringify({ session_id: 'c-1', prompt: 'hi' }), env())
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' })
    expect(lines('s')).toHaveLength(1)
    expect(received).toHaveLength(1)
  })

  // Claude Code adds a hook's stdout to the session's context on SessionStart and UserPromptSubmit.
  test.each([
    ['session-start', { source: 'startup', session_id: 'c-1', transcript_path: '/t', cwd: '/w' }],
    ['user-prompt-submit', { session_id: 'c-1', prompt: 'hello' }],
    ['stop', { stop_hook_active: false, last_assistant_message: 'done' }],
    ['stop-failure', { error: 'rate_limit', error_details: '429' }],
    ['stop-failure', { error: 'overloaded' }],
    ['notification', { notification_type: 'permission_prompt', message: 'm' }],
    ['notification', { notification_type: 'quota_auto_resume_fired' }],
    ['notification', { notification_type: 'agent_completed' }],
    ['session-end', { reason: 'other' }],
    ['no-such-hook', {}],
  ])('%s prints nothing on stdout or stderr, with the server up and down', async (event, input) => {
    for (const extra of [{}, { FACTORY_SOCKET: join(dir, 'nobody-listens.sock') }] as Record<string, string>[]) {
      const r = await run(['hook', event], JSON.stringify(input), env(extra))
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' })
    }
    const garbage = await run(['hook', event], 'not json', env())
    expect(garbage).toMatchObject({ code: 0, stdout: '', stderr: '' })
  })

  test('hooks of one session that overlap never write the same key', async () => {
    const runs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => run(['hook', i % 2 ? 'stop' : 'user-prompt-submit'], '{}', env())),
    )
    expect(runs.map((r) => r.code)).toEqual(Array<number>(8).fill(0))
    const written = lines('s')
    expect(written).toHaveLength(8)
    expect(new Set(written.map((l) => l.key)).size).toBe(8)
    expect(
      written
        .filter((l) => l.kind === 'turn_started')
        .map((l) => l.key)
        .sort(),
    ).toEqual(['s:turn_started:1', 's:turn_started:2', 's:turn_started:3', 's:turn_started:4'])
    expect(existsSync(`${join(spoolDir(), spoolFileName('s'))}.lock`)).toBe(false)
  })

  test('a lock that stays held does not hold the hook: it waits its budget, then writes a key that cannot collide', async () => {
    const file = join(spoolDir(), spoolFileName('s'))
    mkdirSync(`${file}.lock`, { recursive: true })
    const started = performance.now()
    await fire('user-prompt-submit', {})
    expect(performance.now() - started).toBeLessThan(900)
    const [line] = lines('s')
    expect(line?.key).toMatch(/^s:turn_started:1:[a-z0-9]+$/)
  })

  test('cold start to exit stays well inside the 1.5 s SessionEnd budget', async () => {
    const times: number[] = []
    for (let i = 0; i < 8; i++) {
      const r = await run(['hook', i % 2 ? 'stop' : 'user-prompt-submit'], '{}', env())
      expect(r.code).toBe(0)
      times.push(r.ms)
    }
    times.sort((a, b) => a - b)
    console.log(
      `hook wall time over 8 runs: min ${times[0]?.toFixed(0)} ms, median ${times[4]?.toFixed(0)} ms, max ${times[7]?.toFixed(0)} ms`,
    )
    expect(times[7]).toBeLessThan(1000)
  })
})

describe('the account of a session', () => {
  test('session-start reports the account the picker chose, for the sessions no spawn row describes', async () => {
    await fire('session-start', { source: 'startup', session_id: 'c-1' }, { CLAUDE_ACCOUNT_PICKED: 'iu' })
    expect(lines('s')[0]?.payload).toMatchObject({ claudeSessionId: 'c-1', account: 'iu' })
    expect(toEvent('session-start', { source: 'startup' }, {})?.payload).toEqual({ source: 'startup' })
  })

  test("a name outside the registry's alphabet is not reported at all", () => {
    for (const odd of ['has space', 'x'.repeat(65), '-lead', "a'; drop", '../x', '']) {
      expect(toEvent('session-start', { source: 'startup' }, { CLAUDE_ACCOUNT_PICKED: odd })?.payload).toEqual({
        source: 'startup',
      })
    }
  })
})

describe('send-back (FL5)', () => {
  const stop = (input: object, extra: Record<string, string> = {}) => {
    const err: string[] = []
    return hookMain(
      ['stop'],
      env(extra),
      async () => JSON.stringify(input),
      (text) => void err.push(text),
    ).then((code) => ({ code, err }))
  }
  const line = '2 workers still running: wait for them (`factory session wait --on workers`) or collect them'

  test('a stop the server turns back exits 2 with its one line on stderr', async () => {
    stopAnswer = { sendBack: true, message: line }
    expect(await stop({ stop_hook_active: false })).toEqual({ code: 2, err: [`${line}\n`] })
    expect(stopChecks).toEqual(['/sessions/s/stop-check'])
    // A stop that is sent back is no end: nothing is spooled or posted, so the turn stays open.
    expect(lines('s')).toEqual([])
    expect(received).toEqual([])
  })

  test('a stop that is let through is recorded after the question', async () => {
    expect(await stop({ stop_hook_active: false })).toEqual({ code: 0, err: [] })
    expect(stopChecks).toEqual(['/sessions/s/stop-check'])
    expect(lines('s').map((l) => l.kind)).toEqual(['turn_ended'])
    expect(received).toHaveLength(1)
  })

  test('is not asked when the stop is already a send-back, and other events never ask', async () => {
    stopAnswer = { sendBack: true, message: line }
    expect(await stop({ stop_hook_active: true })).toEqual({ code: 0, err: [] })
    expect(await stop({})).toMatchObject({ code: 2 })
    stopChecks.length = 0
    for (const event of ['user-prompt-submit', 'session-start', 'session-end']) {
      expect(
        await hookMain(
          [event],
          env(),
          async () => '{}',
          () => {},
        ),
      ).toBe(0)
    }
    expect(stopChecks).toEqual([])
  })

  test('fails open: a server that is down, slow, wrong or silent lets the session end', async () => {
    stopAnswer = { sendBack: true, message: line }
    expect(await stop({}, { FACTORY_SOCKET: join(dir, 'nobody.sock') })).toEqual({ code: 0, err: [] })

    delayMs = 500
    expect(await stop({})).toEqual({ code: 0, err: [] })
    delayMs = 0

    for (const odd of [
      { sendBack: 'yes', message: line },
      { sendBack: true },
      { sendBack: true, message: '' },
      null,
      'x',
    ]) {
      stopAnswer = odd
      expect(await stop({})).toEqual({ code: 0, err: [] })
    }
  })

  test('does nothing for a session the factory does not follow', async () => {
    stopAnswer = { sendBack: true, message: line }
    expect(await stop({}, { FACTORY_SESSION: '' })).toEqual({ code: 0, err: [] })
    expect(stopChecks).toEqual([])
  })
})
