import { cut, firstSentence } from './describe.ts'

/**
 * Plain words for an ask or a health line (docs/design.md §11 "The read API"). Pure. The raw text is full of ids; what the read
 * API shows, and what the digest is given to title, is this text without them. Conservative: it removes what is certainly an id.
 */

export const SHORT_MAX = 60
export const SUMMARY_MAX = 160

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const IDS: readonly (readonly [RegExp, string])[] = [
  [new RegExp(String.raw`\bnote[\s:]+note[\s:]*${UUID}`, 'gi'), 'a note'],
  [new RegExp(String.raw`\bnote[\s:]*${UUID}`, 'gi'), 'a note'],
  [new RegExp(String.raw`\b${UUID}\b`, 'gi'), ''],
  [/\bspawn\s+(?=[\w:.-]*\d)[\w:.-]+/gi, 'a spawn'],
  [/(?:\bthe\s+)?\blead-\d+-\d+\b/gi, 'the lead'],
  [/\bIssues\s+#?\d+(?:(?:,|\s+and|\s*&)\s*#?\d+)*/g, 'some Issues'],
  [/\bIssue\s+#?\d+/g, 'an Issue'],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, ''],
  [/\btb-[0-9a-f]+\b/g, ''],
  [/\bt\d+\b/g, ''],
]
/** An absolute path, but not the slash inside `origin/main`. */
const PATH = /(?<![\w/.])\/(?:[\w.@~+-]+\/)+[\w.@~+-]*/g

/** One line without ids: the lead, an Issue, a note; no uuids, shas, pane and tab ids; a path as its last segment. */
export function plainText(text: string): string {
  let out = text.replace(PATH, (path) => path.split('/').findLast(Boolean) ?? '')
  for (const [pattern, words] of IDS) out = out.replace(pattern, words)
  out = out
    .replace(/\s+/g, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\b(the|a|an)\s+\1\b/gi, '$1')
    .trim()
  return out.charAt(0).toUpperCase() + out.slice(1)
}

export type LineKind = 'ask' | 'health'

const NOTHING: Record<LineKind, string> = { ask: 'A question for the owner', health: 'A line that needs a look' }

/** The words without a model: the title from the first line, the sentence from the first sentence; never an id. */
export function fallbackWords(text: string, kind: LineKind): { short: string; summary: string } {
  const firstLine = text.split('\n').find((l) => plainText(l) !== '') ?? ''
  const short = cut(plainText(firstLine), SHORT_MAX)
  const summary = firstSentence(plainText(text), SUMMARY_MAX)
  return { short: short || NOTHING[kind], summary: summary || NOTHING[kind] }
}
