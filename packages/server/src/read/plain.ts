import { localParts } from '../notify/digest.ts'
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

export const DEFAULT_TIME_ZONE = 'Europe/Berlin'

/** Where a reader is and when: with it, a UTC time in a text becomes the owner's local one. */
export interface Locale {
  now: Date
  timeZone?: string
}

/** An instant as the owner's local time: `HH:MM` within 18 h of `now` (so "until 00:12" past midnight), else `D Mon HH:MM`. */
export function localTime(at: Date, { now, timeZone = DEFAULT_TIME_ZONE }: Locale): string {
  const { time } = localParts(at, timeZone)
  if (Math.abs(at.getTime() - now.getTime()) < 18 * 3_600_000) return time
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(at)
  return `${day} ${time}`
}

const ISO_UTC = /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?\s?(?:Z|UTC)\b/g
const CLOCK_UTC = /(?<!\d{4}-\d{2}-\d{2}[T ])\b(\d{1,2}):(\d{2})\s?(?:Z|UTC)\b/g

/** UTC times in a text as local ones. A bare `23:12Z` is the next such time around `now`. */
function localTimes(text: string, locale: Locale): string {
  const { now } = locale
  return text
    .replace(ISO_UTC, (all, date: string, time: string) => {
      const at = new Date(`${date}T${time}:00Z`)
      return Number.isNaN(at.getTime()) ? all : localTime(at, locale)
    })
    .replace(CLOCK_UTC, (_all, hour: string, minute: string) => {
      const at = new Date(`${now.toISOString().slice(0, 10)}T${hour.padStart(2, '0')}:${minute}:00Z`)
      if (Number.isNaN(at.getTime())) return _all
      if (at.getTime() < now.getTime() - 12 * 3_600_000) at.setUTCDate(at.getUTCDate() + 1)
      return localTime(at, locale)
    })
}

/**
 * One line without ids: the lead, an Issue, a note; no uuids, shas, pane and tab ids; a path as its last segment. With a `locale`, a
 * UTC time is the owner's local one (left alone without: a text that is fingerprinted must not change with the clock).
 */
export function plainText(text: string, locale?: Locale): string {
  let out = text.replace(PATH, (path) => path.split('/').findLast(Boolean) ?? '')
  if (locale) out = localTimes(out, locale)
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

/** A sentence about a message, not about the thing: the digest reads a request as a session's last message and sometimes says so. */
export const describesMessage = (text: string): boolean =>
  /^(the |a |an )?(last |latest |first |only )?(message|request|text)\s+(asks|lists|says|contains|mentions|describes|states|is|was|reads|names|wants|has)\b/i.test(
    text.trim(),
  ) || /\blast message\b/i.test(text)
