import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type SocketListener, listenOnSocket } from '../../src/adapters/socket/listener.ts'
import { healthOf, tickProblem } from '../../src/read/health.ts'
import { ok } from '../../src/kernel/result.ts'

const NOW = new Date('2026-11-07T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

describe('tick staleness on /health', () => {
  test('a tick that is off, or has had no time for its first pass, is not stale', () => {
    expect(tickProblem({ tickMs: 0, now: NOW, startedAt: ago(3_600_000), tickAt: null })).toBeNull()
    expect(tickProblem({ tickMs: 10_000, now: NOW, startedAt: ago(30_000), tickAt: null })).toBeNull()
  })

  test('no tick yet after a minute, or none for three intervals, is stale', () => {
    expect(tickProblem({ tickMs: 10_000, now: NOW, startedAt: ago(61_000), tickAt: null })).toBe(
      'no tick has succeeded yet',
    )
    expect(tickProblem({ tickMs: 10_000, now: NOW, startedAt: ago(3_600_000), tickAt: ago(50_000) })).toBeNull()
    expect(tickProblem({ tickMs: 10_000, now: NOW, startedAt: ago(3_600_000), tickAt: ago(61_000) })).toBe(
      'the last successful tick was 61 s ago',
    )
    expect(tickProblem({ tickMs: 120_000, now: NOW, startedAt: ago(3_600_000), tickAt: ago(300_000) })).toBeNull()
  })

  test('a stale tick is unhealthy with the heartbeat names unchanged; the database still comes first', () => {
    const stale = healthOf({
      version: 'v',
      databaseFailure: null,
      tickAt: ago(120_000).toISOString(),
      queueMovedAt: null,
      tickFailure: 'the last successful tick was 120 s ago',
    })
    expect(stale).toEqual({
      status: 'unhealthy',
      version: 'v',
      reason: 'the last successful tick was 120 s ago',
      heartbeat: {
        ok: false,
        reason: 'the last successful tick was 120 s ago',
        tickAt: ago(120_000).toISOString(),
        queueMovedAt: null,
      },
    })
    expect(
      healthOf({ version: 'v', databaseFailure: 'down', tickAt: null, queueMovedAt: null, tickFailure: 'x' }).reason,
    ).toBe('down')
    expect(healthOf({ version: 'v', databaseFailure: null, tickAt: null, queueMovedAt: null }).status).toBe('ok')
  })
})

describe('the hook socket', () => {
  let dir = ''
  let listener: SocketListener | undefined
  afterEach(async () => {
    await listener?.stop()
    listener = undefined
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const handlers = {
    event: async () => ok({ recorded: true, reacted: null }),
    stopCheck: async () => ok({ sendBack: false, message: null }),
  }

  test('is mode 0600 in a directory of its own, and is removed when it stops', async () => {
    dir = mkdtempSync('/tmp/factory-sock-')
    const path = join(dir, 'state', 'hook.sock')
    listener = await listenOnSocket(path, handlers)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700)
    await listener.stop()
    listener = undefined
    expect(existsSync(path)).toBe(false)
  })

  test('a socket file nothing answers on is replaced; one that answers is never taken over', async () => {
    dir = mkdtempSync('/tmp/factory-sock-')
    const path = join(dir, 'hook.sock')
    writeFileSync(path, '')
    chmodSync(path, 0o600)
    listener = await listenOnSocket(path, handlers)
    const answer = await fetch('http://localhost/sessions/lead-1-1/stop-check', {
      unix: path,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stopHookActive: false, backgroundTasks: false }),
    })
    expect(await answer.json()).toEqual({ sendBack: false, message: null })
    const refused = await listenOnSocket(path, handlers).then(
      () => 'listened',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(refused).toMatch(/not taking it over/)
    // the first listener still answers
    const again = await fetch('http://localhost/events', {
      unix: path,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'k', session: 'lead-1-1', kind: 'turn_started', at: '2026-11-07T12:00:00Z' }),
    })
    expect(again.status).toBe(200)
  })
})
