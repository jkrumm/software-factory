import type { SinceItem, SinceModel } from '@software-factory/contract'
import type { Tone } from '../components/kit/tone.ts'
import type { Origin } from './flow.ts'
import type { LANGUAGE } from './language.gen.ts'
import { agoWords } from './needs.ts'

export { agoWords }

type InfoWord = keyof typeof LANGUAGE

/** The band's categories, in the order they read: what he may want to act on first, what settled without him last. */
export const SINCE_KEYS = ['failed', 'incidents', 'dropped', 'shipped', 'filed', 'judge', 'screen', 'errands'] as const
export type SinceKey = (typeof SINCE_KEYS)[number]

export const SINCE_LABEL: Record<SinceKey, string> = {
  shipped: 'Shipped and verified',
  failed: 'Regressed',
  dropped: 'Dropped',
  judge: 'Answered by the Judge',
  screen: 'Turned away',
  errands: 'Errands closed without you',
  filed: 'New Issues',
  incidents: 'Incidents',
}

/** The tone of each category, decided here and nowhere else. A tone only paints the figure once the count is above zero. */
export const SINCE_TONE: Record<SinceKey, Tone> = {
  shipped: 'good',
  failed: 'bad',
  dropped: 'neutral',
  judge: 'accent',
  screen: 'neutral',
  errands: 'neutral',
  filed: 'accent',
  incidents: 'warn',
}

/** What happened to an item of a category, as one sentence for its popover; the category's label is the outcome. */
export const SINCE_HAPPENED: Record<SinceKey, string> = {
  shipped: 'It was deployed and the watch after the deploy passed.',
  failed: 'Production regressed while it was watched after the deploy.',
  dropped: 'Its lead gave it up, with a reason; nothing shipped.',
  judge: 'The Judge answered a Decision on it before it reached you.',
  screen: 'The screen turned it away before it reached you.',
  errands:
    'Its check said it was no longer needed, it expired, a newer request replaced it, the factory ran its MacBook command through a fixed verb, or your MacBook ran it by itself from a class you granted.',
  filed: 'It was filed as a new Issue.',
  incidents: 'An incident was opened for it.',
}

/** What a category says in plain words under its label: what happened, and whether it wants anything from the owner. */
export const SINCE_SUBTITLE: Record<SinceKey, string> = {
  failed: 'Was live, then its check failed. Its lead is fixing it; nothing to do unless it stalls.',
  incidents: 'Something in production raised an alarm and an Issue was opened for it. Its lead is on it.',
  dropped: 'Ended without shipping: the lead gave up and said why. Open one to read the reason.',
  shipped: 'Live, and its check passed. Nothing to do.',
  filed: 'New work, from you or from what the factory noticed. Nothing to do; it starts when there is room.',
  judge: 'Questions the Judge answered, so they never reached you. Nothing to do.',
  screen: 'Alerts and requests turned away before they reached you. Nothing to do.',
  errands: 'Requests for your hands that ended without you. Nothing to do.',
}

/** The domain word each category's InfoHint defines (docs/language.md, generated). */
const SINCE_HINT = {
  failed: 'regressed',
  incidents: 'incident',
  dropped: 'dropped',
  shipped: 'verified',
  filed: 'filed',
  judge: 'judge',
  screen: 'screen',
  errands: 'closed without you',
} as const satisfies Record<SinceKey, InfoWord>

/** An origin as it reads inside a sentence: "2 you, 1 GitHub". */
const ORIGIN_WORD = {
  you: 'you',
  application: 'application',
  infrastructure: 'infrastructure',
  github: 'GitHub',
  feedback: 'feedback',
  factory: 'factory',
} as const satisfies Record<Origin, string>

/** Items listed straight away; the rest of the arrived ones sit in a Fold. */
export const SHOWN = 3

/** "2 you, 1 GitHub": the biggest origin first, the empty ones left out; null when nothing was filed. */
export function originBreakdown(byOrigin: readonly { origin: string; count: number }[]): string | null {
  const parts = byOrigin
    .filter((entry) => entry.count > 0)
    .toSorted((a, b) => b.count - a.count)
    .map((entry) => `${entry.count} ${ORIGIN_WORD[entry.origin as Origin] ?? entry.origin}`)
  return parts.length === 0 ? null : parts.join(', ')
}

export interface SinceRow {
  key: SinceKey
  label: string
  count: number
  tone: Tone
  subtitle: string
  hint: InfoWord
  /** the newest `SHOWN`, newest first */
  shown: SinceItem[]
  /** the rest of what arrived (the server sends the newest 8) */
  folded: SinceItem[]
  /** what the count holds beyond what arrived */
  more: number
  /** the by-origin words of New Issues; null for every other category */
  breakdown: string | null
}

const newestFirst = (items: readonly SinceItem[]): SinceItem[] =>
  items.toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))

/** The band's rows in reading order; a category nothing happened in is left out. */
export function sinceRows(model: SinceModel): SinceRow[] {
  return SINCE_KEYS.filter((key) => model.categories[key].count > 0).map((key) => {
    const category = model.categories[key]
    const items = newestFirst(category.items)
    return {
      key,
      label: SINCE_LABEL[key],
      count: category.count,
      tone: SINCE_TONE[key],
      subtitle: SINCE_SUBTITLE[key],
      hint: SINCE_HINT[key],
      shown: items.slice(0, SHOWN),
      folded: items.slice(SHOWN),
      more: Math.max(0, category.count - items.length),
      breakdown: key === 'filed' ? originBreakdown(model.categories.filed.byOrigin) : null,
    }
  })
}

/** Nothing happened in any category. */
export const isQuiet = (rows: readonly SinceRow[]): boolean => rows.length === 0

/** The local wall-clock time of an instant: "09:12". */
export const clockOf = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** The visit as muted text beside the heading: "3 hours ago · Mon 09:12". */
export const visitWords = (iso: string, now: number): string =>
  `${agoWords(now - Date.parse(iso))} \u00b7 ${new Date(iso).toLocaleDateString([], { weekday: 'short' })} ${clockOf(iso)}`

/** The band's window in the head: "Since Mon 09:12 \u00b7 3 hours ago". */
export const windowWords = (iso: string, now: number): string =>
  `Since ${new Date(iso).toLocaleDateString([], { weekday: 'short' })} ${clockOf(iso)} \u00b7 ${agoWords(now - Date.parse(iso))}`
