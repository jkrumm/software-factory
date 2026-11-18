import { describe, expect, test } from 'bun:test'
import * as z from 'zod'
import { ApiError, awaitsUpdate, failureNote, parseShape, ShapeError } from '../src/lib/api.ts'
import { reloadNow } from '../src/lib/policy.ts'
import { keepOf, keptFor, placeKept, type Box, type Kept, type Surface } from '../src/lib/scroll-keep.ts'

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
    expect(failureNote(new ApiError(503, '/v1/x'))).toBe(
      'The server answered 503. Reload the page; if it stays, read the server log.',
    )
  })
})

describe('when a new bundle loads', () => {
  const idle = { waiting: true, blocked: false, focused: null, hasDraft: false }

  test('the moment the worker takes over reloads only a screen that has nothing to show', () => {
    expect(reloadNow('activated', idle)).toBe(false)
    expect(reloadNow('activated', { ...idle, blocked: true })).toBe(true)
  })

  test('a navigation, a hidden tab and a lazy chunk that is gone each load it', () => {
    for (const moment of ['navigation', 'hidden', 'broken'] as const) expect(reloadNow(moment, idle)).toBe(true)
  })

  test('nothing reloads without a waiting worker, a focused field or a draft', () => {
    for (const moment of ['activated', 'navigation', 'hidden', 'broken'] as const) {
      expect(reloadNow(moment, { ...idle, blocked: true, waiting: false })).toBe(false)
      expect(reloadNow(moment, { ...idle, blocked: true, focused: field })).toBe(false)
      expect(reloadNow(moment, { ...idle, blocked: true, hasDraft: true })).toBe(false)
    }
  })

  test('a quiet tab is someone reading: no moment of its own reloads a screen that has data', () => {
    // the type has no `idle` moment, and the worker taking over reloads only a blocked screen
    expect(reloadNow('activated', idle)).toBe(false)
  })
})

/** A page of containers: each id has the box a test gives it, and a skeleton that may still show. */
const surface = (boxes: Record<string, Box>, loading = false): Surface => ({
  box: (id) => boxes[id] ?? null,
  boxes: () => Object.entries(boxes),
  loading: () => loading,
})
const box = (scrollTop: number, scrollHeight = 5000, clientHeight = 800): Box => ({
  scrollTop,
  scrollLeft: 0,
  scrollHeight,
  clientHeight,
})

describe('the reading position across an update reload', () => {
  const url = '/artifacts/art_1'

  test('an artifact scrolled to the middle comes back at the same place after the reload', () => {
    // before the reload: the document scroller is in the middle of a long page
    const before = surface({ main: box(0), 'artifact-document': box(2100) })
    const kept = keepOf(before, url, 1_000)
    expect(kept).toEqual({ url, at: 1_000, boxes: { 'artifact-document': { top: 2100, left: 0 } } })
    // after the reload: the same page, rendered fresh and not scrolled
    const after = { main: box(0), 'artifact-document': box(0) }
    expect(keptFor(kept, url, 5_000)).toBe(true)
    const left = placeKept(surface(after), kept?.boxes ?? {})
    expect(after['artifact-document'].scrollTop).toBe(2100)
    expect(left).toEqual({})
  })

  test('nothing is put back while a skeleton shows, nor before the content is tall enough', () => {
    const pending = { 'artifact-document': { top: 2100, left: 0 } }
    const skeleton = { 'artifact-document': box(0, 5000) }
    expect(placeKept(surface(skeleton, true), pending)).toEqual(pending)
    expect(skeleton['artifact-document'].scrollTop).toBe(0)
    const short = { 'artifact-document': box(0, 1200) }
    expect(placeKept(surface(short), pending)).toEqual(pending)
    expect(short['artifact-document'].scrollTop).toBe(0)
  })

  test('a page read from its top stores nothing, and a position belongs to its address and the moment only', () => {
    expect(keepOf(surface({ main: box(0) }), url, 1)).toBeNull()
    const kept: Kept = { url, at: 1_000, boxes: { main: { top: 10, left: 0 } } }
    expect(keptFor(kept, '/artifacts/art_2', 2_000)).toBe(false)
    expect(keptFor(kept, url, 1_000 + 10 * 60_000)).toBe(false)
    expect(keptFor(null, url, 2_000)).toBe(false)
  })
})
