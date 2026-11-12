import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deployingSince } from '../../src/read/deploy-window.ts'
import { DATABASE_FAILURE_GRACE_MS, startHealthProbe } from '../../src/read/health-probe.ts'

describe('the health probe', () => {
  let probe: { snapshot(): unknown; stop(): void } | undefined
  afterEach(() => probe?.stop())

  test('serves the last read at once, even while a read hangs', async () => {
    let calls = 0
    let release: () => void = () => {}
    const p = startHealthProbe({
      everyMs: 5,
      now: () => new Date(),
      read: async () => {
        calls++
        if (calls === 1) return { queueMovedAt: '2026-11-12T10:00:00.000Z', doorLines: ['a line'] }
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { queueMovedAt: null, doorLines: [] }
      },
    })
    probe = p
    await Bun.sleep(50)
    const started = performance.now()
    expect(p.snapshot()).toEqual({
      queueMovedAt: '2026-11-12T10:00:00.000Z',
      doorLines: ['a line'],
      databaseFailure: null,
    })
    expect(performance.now() - started).toBeLessThan(50)
    // one hung read holds one call: the next read is not started over it
    await Bun.sleep(50)
    expect(calls).toBe(2)
    release()
  })

  test('an error is a failure only once it has lasted the grace; a good read clears it', async () => {
    let at = new Date('2026-11-12T12:00:00Z')
    let fail = true
    const p = startHealthProbe({
      everyMs: 5,
      now: () => at,
      read: async () => {
        if (fail) throw new Error('connection refused')
        return { queueMovedAt: null, doorLines: [] }
      },
    })
    probe = p
    await Bun.sleep(30)
    expect(p.snapshot()).toMatchObject({ databaseFailure: null })
    at = new Date(at.getTime() + DATABASE_FAILURE_GRACE_MS)
    expect(p.snapshot()).toMatchObject({ databaseFailure: 'the database failed: connection refused' })
    fail = false
    await Bun.sleep(30)
    expect(p.snapshot()).toMatchObject({ databaseFailure: null })
  })
})

describe('the deploy window', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const dataDir = () => {
    dir = mkdtempSync(join(tmpdir(), 'factory-window-'))
    return dir
  }

  test('no lock is no deploy', () => {
    expect(deployingSince(dataDir())).toBeNull()
  })

  test('a lock held by a live pid is a deploy since it was taken', () => {
    const data = dataDir()
    symlinkSync(String(process.pid), join(data, 'deploy.lock'))
    const since = deployingSince(data)
    expect(since).toBeInstanceOf(Date)
    expect(Date.now() - (since?.getTime() ?? 0)).toBeLessThan(5_000)
  })

  test('a lock whose holder is dead, or that names no pid, holds nothing', () => {
    const data = dataDir()
    symlinkSync('2147483646', join(data, 'deploy.lock'))
    expect(deployingSince(data)).toBeNull()
    rmSync(join(data, 'deploy.lock'))
    symlinkSync('not-a-pid', join(data, 'deploy.lock'))
    expect(deployingSince(data)).toBeNull()
  })
})
