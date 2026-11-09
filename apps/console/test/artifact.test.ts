import { describe, expect, test } from 'bun:test'
import {
  composerTop,
  groupAnnotations,
  headingPath,
  indexText,
  locateQuote,
  MAX_PATH,
  MAX_QUOTE,
  normalizeQuote,
  parseFrameMessage,
} from '../src/lib/artifact.ts'

describe('normalizeQuote', () => {
  test('folds whitespace to single spaces and trims', () => {
    expect(normalizeQuote('  The  cost\n\nis   low\t ')).toBe('The cost is low')
  })
  test('cuts to the API limit', () => {
    expect(normalizeQuote('a'.repeat(MAX_QUOTE + 50))).toHaveLength(MAX_QUOTE)
  })
})

describe('headingPath', () => {
  test('is empty before any heading', () => {
    expect(headingPath([])).toBe('')
  })
  test('nests deeper headings and pops the ones at its level', () => {
    const h = (level: number, text: string) => ({ level, text })
    expect(headingPath([h(1, 'Spec'), h(2, 'Options'), h(3, 'Cost')])).toBe('Spec > Options > Cost')
    expect(headingPath([h(1, 'Spec'), h(2, 'Options'), h(3, 'Cost'), h(2, 'Risks')])).toBe('Spec > Risks')
    expect(headingPath([h(2, 'Options'), h(3, ' Cost\n of it ')])).toBe('Options > Cost of it')
  })
  test('stays within the API limit', () => {
    expect(headingPath([{ level: 1, text: 'x'.repeat(MAX_PATH * 2) }])).toHaveLength(MAX_PATH)
  })
})

describe('parseFrameMessage', () => {
  const rect = { top: 120.5, bottom: 144, left: 32 }
  const good = { type: 'factory.select', quote: 'a  quote', path: 'Options > Cost', rect }
  test('accepts exactly the select shape and normalises the quote', () => {
    expect(parseFrameMessage(good)).toEqual({ type: 'select', quote: 'a quote', path: 'Options > Cost', rect })
    expect(parseFrameMessage({ ...good, path: '' })).toEqual({ type: 'select', quote: 'a quote', path: '', rect })
  })
  test('keeps only the rect fields it knows', () => {
    expect(parseFrameMessage({ ...good, rect: { ...rect, right: 9 } })).toEqual({
      type: 'select',
      quote: 'a quote',
      path: 'Options > Cost',
      rect,
    })
  })
  test('accepts the ready message', () => {
    expect(parseFrameMessage({ type: 'factory.ready' })).toEqual({ type: 'ready' })
  })
  test('ignores everything else', () => {
    for (const data of [
      null,
      'factory.select',
      42,
      [],
      {},
      { ...good, type: 'factory.verdict' },
      { type: 'factory.render', html: '<p>x</p>' },
      { ...good, quote: '' },
      { ...good, quote: '   ' },
      { ...good, quote: 'a'.repeat(MAX_QUOTE + 1) },
      { ...good, path: 'p'.repeat(MAX_PATH + 1) },
      { ...good, quote: 7 },
      { type: 'factory.select', quote: 'q' },
      { type: 'factory.select', quote: 'q', path: '' },
      { ...good, rect: undefined },
      { ...good, rect: null },
      { ...good, rect: { top: 1, bottom: 2 } },
      { ...good, rect: { ...rect, top: '1' } },
      { ...good, rect: { ...rect, left: Number.NaN } },
      { ...good, rect: { ...rect, bottom: Infinity } },
    ]) {
      expect(parseFrameMessage(data)).toBeNull()
    }
  })
})

describe('indexText and locateQuote', () => {
  const parts = [
    { text: 'Options', block: 'h' },
    { text: 'The cost is ', block: 'p' },
    { text: 'low', block: 'p' },
    { text: ' and\n  safe.', block: 'p' },
    { text: 'Next block', block: 'q' },
  ]
  const index = indexText(parts)

  test('folds whitespace and separates blocks with a space', () => {
    expect(index.flat).toBe('Options The cost is low and safe. Next block')
  })
  test('finds a quote inside a part and across parts', () => {
    expect(locateQuote(index, 'cost is')).toEqual({ start: [1, 4], end: [1, 11] })
    expect(locateQuote(index, 'is low and safe.')).toEqual({ start: [1, 9], end: [3, 12] })
  })
  test('finds a quote across blocks the way a selection reads it', () => {
    expect(locateQuote(index, 'safe.\nNext')).toEqual({ start: [3, 7], end: [4, 4] })
  })
  test('does not find what is not there, or an empty quote', () => {
    expect(locateQuote(index, 'expensive')).toBeNull()
    expect(locateQuote(index, '  ')).toBeNull()
  })
})

describe('groupAnnotations', () => {
  test('global comments are General whichever list the API put them in', () => {
    const a = { id: 'a', path: 'Options' }
    const g1 = { id: 'g1', path: 'global' }
    const g2 = { id: 'g2', path: 'global' }
    const u = { id: 'u', path: null }
    expect(groupAnnotations([a, g1], [g2, u])).toEqual({ general: [g1, g2], anchored: [a], unanchored: [u] })
  })
})

describe('composerTop', () => {
  const column = { top: 100, height: 900 }
  test('is level with the selection, relative to the column', () => {
    expect(composerTop(400, column, 200)).toBe(300)
  })
  test('stays on screen above and below the column', () => {
    expect(composerTop(-50, column, 200)).toBe(8)
    expect(composerTop(5000, column, 200)).toBe(900 - 200 - 8)
  })
  test('a box taller than the column sits at the top', () => {
    expect(composerTop(500, column, 2000)).toBe(8)
  })
})
