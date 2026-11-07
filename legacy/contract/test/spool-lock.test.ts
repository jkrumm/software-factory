import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { LOCK_STALE_MS, tryLock } from '../src/spool-lock.ts'

const dir = mkdtempSync('/tmp/factory-lock-')
const file = join(dir, 's.jsonl')
const lock = `${file}.lock`
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => rmSync(lock, { recursive: true, force: true }))

const age = () => {
  const old = new Date(Date.now() - LOCK_STALE_MS - 1000)
  utimesSync(lock, old, old)
}

describe('the spool lock', () => {
  test('one holder at a time; the next gets it once the first lets go', async () => {
    const first = await tryLock(file, 50)
    expect(first).toBeDefined()
    expect(await tryLock(file, 30)).toBeUndefined()
    first?.()
    expect(existsSync(lock)).toBe(false)
    const second = await tryLock(file, 50)
    expect(second).toBeDefined()
    second?.()
  })

  test('a waiter gets the lock when the holder releases inside its budget', async () => {
    const first = await tryLock(file, 50)
    setTimeout(() => first?.(), 30)
    const second = await tryLock(file, 500)
    expect(second).toBeDefined()
    second?.()
  })

  test('a lock held past the stale limit is a crashed holder: broken, moved aside, taken', async () => {
    mkdirSync(lock)
    age()
    const taken = await tryLock(file, 100)
    expect(taken).toBeDefined()
    taken?.()
    expect(existsSync(lock)).toBe(false)
  })

  test("a holder whose lock was broken cannot remove its successor's", async () => {
    const slow = await tryLock(file, 50)
    age()
    const successor = await tryLock(file, 100)
    expect(successor).toBeDefined()
    slow?.()
    expect(existsSync(lock)).toBe(true)
    expect(await tryLock(file, 30)).toBeUndefined()
    successor?.()
    expect(existsSync(lock)).toBe(false)
  })

  test('a lock directory with no owner yet is held, not free', async () => {
    mkdirSync(lock)
    expect(await tryLock(file, 30)).toBeUndefined()
  })
})
