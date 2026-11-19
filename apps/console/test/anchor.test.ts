import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, test } from 'bun:test'
import { anchorAround, normalizeQuote, occurrencesOf, resolveQuote, type QuoteHint } from '../src/lib/artifact.ts'

/**
 * The resolver exists twice: in src/lib/artifact.ts (the Markdown page) and in public/frame/annotator.js (the HTML frame,
 * plain JavaScript with no imports). One table of cases runs against both, so they cannot drift apart.
 */

type Resolve = (flat: string, wanted: string, hint?: QuoteHint | null, pathAt?: (index: number) => string) => number
type Around = (
  flat: string,
  wanted: string,
  near: number | null,
) => { occurrence: number; prefix: string; suffix: string } | null
interface Resolver {
  occurrencesOf: (flat: string, wanted: string) => number[]
  anchorAround: Around
  resolveQuote: Resolve
}

const source = readFileSync(join(import.meta.dir, '../public/frame/annotator.js'), 'utf8')
const block = source.slice(source.indexOf('// anchor:begin'), source.indexOf('// anchor:end'))
if (!block.includes('function resolveQuote')) throw new Error('annotator.js lost its anchor:begin / anchor:end block')

// the block runs in a context of its own, as the frame runs it; what it returns is copied back as plain data
const inFrame = runInNewContext(`${block}; ({ occurrencesOf, anchorAround, resolveQuote })`) as Resolver
const plain = <Args extends unknown[], Out>(fn: (...args: Args) => Out) => {
  return (...args: Args): Out => JSON.parse(JSON.stringify(fn(...args) ?? null)) as Out
}
const mirror: Resolver = {
  occurrencesOf: plain(inFrame.occurrencesOf),
  anchorAround: plain(inFrame.anchorAround),
  resolveQuote: plain(inFrame.resolveQuote),
}
const lib: Resolver = { occurrencesOf, anchorAround, resolveQuote }

const SENTENCE = 'We keep the queue in Postgres.'
/** the same sentence three times, under three headings: a space between blocks, as the text index has it */
const TEXT = `Intro ${SENTENCE} Options Cost ${SENTENCE} Risks Retries ${SENTENCE} Done`
const at = (n: number) => occurrencesOf(TEXT, SENTENCE)[n] ?? -1
const headingOf = (index: number) => (index < at(1) ? 'Intro' : index < at(2) ? 'Options > Cost' : 'Risks > Retries')

const wanted = SENTENCE

describe('the occurrence resolver, in the page and in the frame', () => {
  test('the copies agree on where every occurrence is', () => {
    expect(lib.occurrencesOf(TEXT, wanted)).toEqual(mirror.occurrencesOf(TEXT, wanted))
    expect(lib.occurrencesOf('aaa', 'aa')).toEqual([0, 1])
    expect(mirror.occurrencesOf('aaa', 'aa')).toEqual([0, 1])
    expect(lib.occurrencesOf('abc', '')).toEqual([])
  })

  for (const [name, resolver] of [
    ['artifact.ts', lib],
    ['annotator.js', mirror],
  ] as const) {
    describe(name, () => {
      const around = (n: number) => {
        const found = resolver.anchorAround(TEXT, wanted, at(n))
        if (!found) throw new Error('no anchor')
        return found
      }

      test('a selection records its occurrence and 32 characters either side', () => {
        for (const n of [0, 1, 2]) expect(around(n).occurrence).toBe(n)
        const second = around(1)
        expect(second.prefix).toBe(TEXT.slice(at(1) - 32, at(1)))
        expect(second.suffix).toBe(TEXT.slice(at(1) + wanted.length, at(1) + wanted.length + 32))
        // at the start of the text there is less to keep
        expect(resolver.anchorAround('Hi there. Hi there.', 'Hi there.', 0)).toEqual({
          occurrence: 0,
          prefix: '',
          suffix: ' Hi there.',
        })
      })

      test('a selection takes the occurrence nearest to where it starts', () => {
        expect(resolver.anchorAround(TEXT, wanted, at(1) + 4)?.occurrence).toBe(1)
        expect(resolver.anchorAround(TEXT, wanted, at(2) - 3)?.occurrence).toBe(2)
      })

      test('with no position, or no match, nothing is recorded', () => {
        expect(resolver.anchorAround(TEXT, wanted, null)).toBeNull()
        expect(resolver.anchorAround(TEXT, 'absent', 0)).toBeNull()
      })

      test('the second and the third occurrence each resolve to their own', () => {
        for (const n of [0, 1, 2]) expect(resolver.resolveQuote(TEXT, wanted, around(n), headingOf)).toBe(at(n))
      })

      test('no hint, or an empty one, resolves to the first occurrence, as a comment always did', () => {
        expect(resolver.resolveQuote(TEXT, wanted)).toBe(at(0))
        expect(resolver.resolveQuote(TEXT, wanted, null)).toBe(at(0))
        expect(resolver.resolveQuote(TEXT, wanted, {})).toBe(at(0))
        expect(resolver.resolveQuote(TEXT, wanted, { path: null, occurrence: null, prefix: null, suffix: null })).toBe(
          at(0),
        )
      })

      test('a quote that is not in the text resolves to nothing', () => {
        expect(resolver.resolveQuote(TEXT, 'Redis', { occurrence: 0 })).toBe(-1)
        expect(resolver.resolveQuote(TEXT, '', { occurrence: 0 })).toBe(-1)
      })

      test('the prefix and suffix win over the occurrence number: a paragraph inserted above keeps the comment in place', () => {
        const third = around(2)
        const revised = `New paragraph. ${SENTENCE} ${TEXT}`
        const moved = occurrencesOf(revised, wanted)
        expect(moved).toHaveLength(4)
        // the number is now the second occurrence's, the text around it is the third's old one
        expect(resolver.resolveQuote(revised, wanted, third)).toBe(moved[3] ?? -1)
        expect(resolver.resolveQuote(revised, wanted, around(1))).toBe(moved[2] ?? -1)
      })

      test('when the text around changed, the occurrence number is next', () => {
        const edited = TEXT.replace('Retries', 'Backoff and retries')
        const hint = { ...around(2), prefix: 'text that is gone', suffix: 'text that is gone' }
        expect(resolver.resolveQuote(edited, wanted, hint)).toBe(occurrencesOf(edited, wanted)[2] ?? -1)
      })

      test('with no such occurrence number, the first one under the stored heading path is next', () => {
        const hint = { occurrence: 9, prefix: 'gone', suffix: 'gone', path: 'Risks > Retries' }
        expect(resolver.resolveQuote(TEXT, wanted, hint, headingOf)).toBe(at(2))
        // a path that is gone, or no way to name one, falls to the first occurrence
        expect(resolver.resolveQuote(TEXT, wanted, { ...hint, path: 'Gone' }, headingOf)).toBe(at(0))
        expect(resolver.resolveQuote(TEXT, wanted, hint)).toBe(at(0))
      })

      test('a prefix or suffix alone is used, and a text at the very start still matches', () => {
        expect(resolver.resolveQuote(TEXT, wanted, { suffix: ' Risks Retries' })).toBe(at(1))
        expect(resolver.resolveQuote('Hi. Hi.', 'Hi.', { prefix: '', suffix: ' Hi.' })).toBe(0)
        expect(resolver.resolveQuote('Hi. Hi.', 'Hi.', { prefix: 'Hi. ', suffix: '' })).toBe(4)
      })

      test('when the text around matches twice, the occurrence number picks between them', () => {
        const twice = 'x. A b. y. A b. y. A b. z'
        const hint = { prefix: 'y. ', suffix: '', occurrence: 2 }
        expect(resolver.resolveQuote(twice, 'A b.', hint)).toBe(occurrencesOf(twice, 'A b.')[2] ?? -1)
        expect(resolver.resolveQuote(twice, 'A b.', { ...hint, occurrence: 0 })).toBe(
          occurrencesOf(twice, 'A b.')[1] ?? -1,
        )
      })
    })
  }

  test('the copies give one answer on every case of the table', () => {
    const hints: QuoteHint[] = [
      {},
      { occurrence: 1 },
      { occurrence: 7 },
      { prefix: TEXT.slice(at(2) - 32, at(2)), suffix: ' Done', occurrence: 0 },
      { prefix: 'gone', suffix: 'gone', occurrence: 1 },
      { path: 'Options > Cost', occurrence: 5 },
    ]
    for (const hint of hints) {
      expect(mirror.resolveQuote(TEXT, wanted, hint, headingOf)).toBe(lib.resolveQuote(TEXT, wanted, hint, headingOf))
    }
    for (let near = 0; near < TEXT.length; near += 7) {
      expect(mirror.anchorAround(TEXT, wanted, near)).toEqual(lib.anchorAround(TEXT, wanted, near))
    }
  })

  test('a quote is the selection with its whitespace folded, as the page sends it', () => {
    expect(normalizeQuote('  We keep\n the   queue ')).toBe('We keep the queue')
  })
})
