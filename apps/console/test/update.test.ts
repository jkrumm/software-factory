import { describe, expect, test } from 'bun:test'
import * as z from 'zod'
import { ApiError, awaitsUpdate, failureNote, parseShape, ShapeError } from '../src/lib/api.ts'
import { IDLE_RELOAD_MS, reloadNow } from '../src/lib/policy.ts'

const Model = z.strictObject({ id: z.string(), count: z.number() })
const field = { tagName: 'TEXTAREA', isContentEditable: false }

describe('an answer from a newer server', () => {
  test('one that only added a field is read as it is, and asks for the new bundle', () => {
    let asked = 0
    const data = { id: 'a', count: 2, added: true }
    expect(
      parseShape('/v1/x', Model, data, () => {
        asked += 1
      }),
    ).toBe(data as never)
    expect(asked).toBe(1)
  })

  test('one with a missing or retyped field is a ShapeError', () => {
    expect(() => parseShape('/v1/x', Model, { id: 'a' })).toThrow(ShapeError)
    expect(() => parseShape('/v1/x', Model, { id: 'a', count: 'two', added: true })).toThrow(ShapeError)
  })

  test('an answer that matches asks for nothing', () => {
    let asked = 0
    expect(
      parseShape('/v1/x', Model, { id: 'a', count: 1 }, () => {
        asked += 1
      }),
    ).toEqual({ id: 'a', count: 1 })
    expect(asked).toBe(0)
  })

  test('only a ShapeError waits for an update, and the words come after the wait', () => {
    expect(awaitsUpdate(new ShapeError('/v1/x', 'x'))).toBe(true)
    expect(awaitsUpdate(new ApiError(500, '/v1/x'))).toBe(false)
    expect(awaitsUpdate(null)).toBe(false)
    expect(failureNote(new ShapeError('/v1/x', 'x'))).toContain('Reload')
    expect(failureNote(new ApiError(503, '/v1/x'))).toBe('The server answered 503')
  })
})

describe('when a new bundle loads', () => {
  const idle = { waiting: true, blocked: false, focused: null, hasDraft: false }

  test('the moment the worker takes over reloads only a screen that has nothing to show', () => {
    expect(reloadNow('activated', idle)).toBe(false)
    expect(reloadNow('activated', { ...idle, blocked: true })).toBe(true)
  })

  test('a navigation, a hidden tab and an idle page each load it', () => {
    for (const moment of ['navigation', 'hidden', 'idle'] as const) expect(reloadNow(moment, idle)).toBe(true)
  })

  test('nothing reloads without a waiting worker, a focused field or a draft', () => {
    for (const moment of ['activated', 'navigation', 'hidden', 'idle'] as const) {
      expect(reloadNow(moment, { ...idle, blocked: true, waiting: false })).toBe(false)
      expect(reloadNow(moment, { ...idle, blocked: true, focused: field })).toBe(false)
      expect(reloadNow(moment, { ...idle, blocked: true, hasDraft: true })).toBe(false)
    }
  })

  test('idle means three quarters of a minute without input', () => {
    expect(IDLE_RELOAD_MS).toBe(45_000)
  })
})
