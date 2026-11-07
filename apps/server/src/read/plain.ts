/**
 * Plain words for the read API (RS13): titles and summaries never show an id as display text. Pure. The stored text is
 * full of ids; what the read API shows is this text without them. Conservative: it removes what is certainly an id.
 */

export const SHORT_MAX = 60
export const SUMMARY_MAX = 160

/** One line cut at a word (`…` marks the cut). */
export function cut(text: string, max = 140): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  const head = one.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > max / 2 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/, '')}…`
}

/**
 * The first sentence of a text. One that is longer than `max` is cut at its last clause boundary (`;`, ` — `, `: `, `, `)
 * past half of `max`, else at a word; the cut ends in `…`.
 */
export function firstSentence(text: string, max = 160): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const end = /[.!?](\s|$)/.exec(one)
  const sentence = end ? one.slice(0, end.index + 1) : one
  if (sentence.length <= max) return sentence
  const window = sentence.slice(0, max)
  let at = -1
  for (const m of window.matchAll(/[;:,](?=\s)|\s—(?=\s)/g)) {
    if (m.index > max / 2 && m.index < max - 1) at = m.index
  }
  if (at < 0) return cut(sentence, max)
  return `${window.slice(0, at).replace(/[\s,;:.-]+$/, '')}…`
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const IDS: readonly (readonly [RegExp, string])[] = [
  [new RegExp(String.raw`\b${UUID}\b`, 'gi'), ''],
  [/\b(?:decision|artifact|errand|signal|event)_[\w-]+/gi, ''],
  [/(?:\bthe\s+)?\blead-\d+-\d+\b/gi, 'the lead'],
  [/\bIssues\s+#?\d+(?:(?:,|\s+and|\s*&)\s*#?\d+)*/g, 'some Issues'],
  [/\bIssue\s+#?\d+/gi, 'an Issue'],
  [/\bissue_\d+\b/g, 'an Issue'],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, ''],
  [/\bt\d+\b/g, ''],
]
/** An absolute path, but not the slash inside `origin/main`. */
const PATH = /(?<![\w/.])\/(?:[\w.@~+-]+\/)+[\w.@~+-]*/g

/** One line without ids: the lead, an Issue; no uuids, shas, record ids; a path as its last segment. */
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

/** The words of a line: the title from the first line, the sentence from the first sentence; never an id. */
export function fallbackWords(text: string, kind: LineKind): { short: string; summary: string } {
  const firstLine = text.split('\n').find((l) => plainText(l) !== '') ?? ''
  const short = cut(plainText(firstLine), SHORT_MAX)
  const summary = firstSentence(plainText(text), SUMMARY_MAX)
  return { short: short || NOTHING[kind], summary: summary || NOTHING[kind] }
}

/** A sentence of a goal that says where the request came from, not what it wants. */
const PROVENANCE =
  /^(filed (from|by|via)|seen |reported |raised |context\b|background\b|follow[- ]?ups? (of|to|from)\b)/i

/**
 * What an Issue is for, from its filed facts alone: the first sentence of the text that says what is wanted (not where it
 * was filed from), else the filed title, in plain words. Null when there is neither.
 */
export function aboutOf(title: string, goal: string | null): string | null {
  const sentences = goal?.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? []
  const wanted = sentences.map((x) => x.trim()).find((x) => x !== '' && !PROVENANCE.test(x))
  const words = wanted ? firstSentence(plainText(wanted)) : cut(plainText(title), 160)
  return words || null
}
