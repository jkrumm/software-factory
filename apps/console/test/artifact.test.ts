import { describe, expect, test } from 'bun:test'
import {
  linkTarget,
  displayPath,
  firstH1,
  headingIds,
  headingPath,
  indexText,
  locateQuote,
  MAX_PATH,
  MAX_QUOTE,
  normalizeQuote,
  parseFrameMessage,
  popoverPosition,
  slugOf,
  splitByRevision,
} from '../src/lib/artifact.ts'

/** A script URL the page must never follow, written so the linter does not take it for one. */
const SCRIPT_URL = ['javascript', 'alert(1)'].join(':')

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

describe('displayPath', () => {
  test('drops the leading segment when it is the document name, any case', () => {
    expect(displayPath('Queue storage > Options > Cost', ['The storage spec', 'queue storage'])).toBe('Options > Cost')
    expect(displayPath('The storage spec > Options', ['The storage spec'])).toBe('Options')
  })
  test('keeps a path whose first segment is a real section, and a path of one segment', () => {
    expect(displayPath('Options > Cost', ['Queue storage'])).toBe('Options > Cost')
    expect(displayPath('Queue storage', ['Queue storage'])).toBe('Queue storage')
  })
})

describe('firstH1', () => {
  test('is the first level-1 heading, without its markup', () => {
    expect(firstH1('intro\n\n# Queue `storage`\n\n## Options')).toBe('Queue storage')
    expect(firstH1('## Only a second level')).toBeNull()
  })
})

describe('headingIds', () => {
  test('slugs, numbers a repeat, and never leaves one empty', () => {
    expect(slugOf('Options & Cost: 2nd try')).toBe('options-cost-2nd-try')
    expect(headingIds(['Risks', 'Cost', 'Risks', 'Risks', '???'])).toEqual([
      'risks',
      'cost',
      'risks-1',
      'risks-2',
      'section',
    ])
  })
})

describe('linkTarget', () => {
  const origin = 'https://console.example'
  test('an anchor scrolls', () => {
    expect(linkTarget('#risks', origin)).toEqual({ kind: 'anchor', id: 'risks' })
    expect(linkTarget('#cost%20of%20it', origin)).toEqual({ kind: 'anchor', id: 'cost of it' })
    expect(linkTarget('#', origin)).toEqual({ kind: 'none' })
  })
  test('a web link opens a tab', () => {
    expect(linkTarget('https://example.com/a?b=1', origin)).toEqual({
      kind: 'external',
      url: 'https://example.com/a?b=1',
    })
  })
  test('a page of the Console opens in place, as a path or as an absolute URL of this origin', () => {
    expect(linkTarget('/artifacts/artifact_1', origin)).toEqual({ kind: 'route', path: '/artifacts/artifact_1' })
    expect(linkTarget('/issues/12?tab=activity', origin)).toEqual({ kind: 'route', path: '/issues/12?tab=activity' })
    expect(linkTarget('https://console.example/issues/12', origin)).toEqual({ kind: 'route', path: '/issues/12' })
  })
  test('anything without a destination here is none', () => {
    for (const href of [
      undefined,
      '',
      'WeatherOrb V2.md',
      './notes',
      '//evil.example/x',
      '/flow',
      'mailto:a@b.c',
      SCRIPT_URL,
    ])
      expect(linkTarget(href, origin)).toEqual({ kind: 'none' })
  })
})

describe('splitByRevision', () => {
  test('the shown revision, the earlier ones and the later ones', () => {
    const at = (revision: number) => ({ revision })
    expect(splitByRevision([at(1), at(2), at(3), at(2)], 2)).toEqual({
      current: [at(2), at(2)],
      previous: [at(1)],
      later: [at(3)],
    })
  })
})

describe('the frame messages of the review', () => {
  test('a click on a passage, a link out, the headings and the section', () => {
    expect(parseFrameMessage({ type: 'factory.open', quote: ' a  quote ' })).toEqual({ type: 'open', quote: 'a quote' })
    expect(parseFrameMessage({ type: 'factory.open', quote: '   ' })).toBeNull()
    expect(parseFrameMessage({ type: 'factory.link', href: 'https://example.com/x' })).toEqual({
      type: 'link',
      href: 'https://example.com/x',
    })
    expect(parseFrameMessage({ type: 'factory.link', href: SCRIPT_URL })).toBeNull()
    expect(parseFrameMessage({ type: 'factory.link', href: '/relative' })).toBeNull()
    expect(parseFrameMessage({ type: 'factory.headings', items: [{ level: 2, text: ' Risks\n' }] })).toEqual({
      type: 'headings',
      items: [{ level: 2, text: 'Risks' }],
    })
    expect(parseFrameMessage({ type: 'factory.headings', items: [{ level: 9, text: 'x' }] })).toBeNull()
    expect(parseFrameMessage({ type: 'factory.section', index: -1 })).toEqual({ type: 'section', index: -1 })
    expect(parseFrameMessage({ type: 'factory.section', index: 1.5 })).toBeNull()
  })
})

describe('popoverPosition', () => {
  const viewport = { width: 1800, height: 1200 }
  const box = { width: 352, height: 200 }
  test('opens below the selection, on its left edge', () => {
    expect(popoverPosition({ top: 300, bottom: 320, left: 500 }, box, viewport)).toEqual({ top: 328, left: 500 })
  })
  test('flips above when it does not fit below', () => {
    expect(popoverPosition({ top: 1100, bottom: 1120, left: 500 }, box, viewport)).toEqual({ top: 892, left: 500 })
  })
  test('stays inside the viewport sideways', () => {
    expect(popoverPosition({ top: 300, bottom: 320, left: 1700 }, box, viewport).left).toBe(1800 - 352 - 8)
    expect(popoverPosition({ top: 300, bottom: 320, left: -40 }, box, viewport).left).toBe(8)
  })
  test('a box that fits neither side sits at the bottom edge', () => {
    expect(popoverPosition({ top: 100, bottom: 1100, left: 10 }, { width: 352, height: 400 }, viewport).top).toBe(792)
  })
})
