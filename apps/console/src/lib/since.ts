import type { SinceItem, SinceModel } from '@software-factory/contract'
import type { Tone } from '../components/kit/tone.ts'
import type { Origin } from './flow.ts'
import { agoWords } from './needs.ts'

export { agoWords }

/** The band's categories, in the order they read. */
export const SINCE_KEYS = ['shipped', 'failed', 'dropped', 'judge', 'screen', 'filed', 'incidents'] as const
export type SinceKey = (typeof SINCE_KEYS)[number]

export const SINCE_LABEL: Record<SinceKey, string> = {
  shipped: 'Shipped and verified',
  failed: 'Regressed',
  dropped: 'Dropped',
  judge: 'Settled by the Judge',
  screen: 'Turned away',
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
  filed: 'accent',
  incidents: 'warn',
}

/** The domain words a category carries an InfoHint for. */
export const SINCE_HINT: Partial<Record<SinceKey, 'judge' | 'screen'>> = { judge: 'judge', screen: 'screen' }

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
  hint?: 'judge' | 'screen'
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

/** The band's rows in reading order. */
export function sinceRows(model: SinceModel): SinceRow[] {
  return SINCE_KEYS.map((key) => {
    const category = model.categories[key]
    const items = newestFirst(category.items)
    return {
      key,
      label: SINCE_LABEL[key],
      count: category.count,
      tone: SINCE_TONE[key],
      ...(SINCE_HINT[key] ? { hint: SINCE_HINT[key] } : {}),
      shown: items.slice(0, SHOWN),
      folded: items.slice(SHOWN),
      more: Math.max(0, category.count - items.length),
      breakdown: key === 'filed' ? originBreakdown(model.categories.filed.byOrigin) : null,
    }
  })
}

/** Nothing happened in any category. */
export const isQuiet = (rows: readonly SinceRow[]): boolean => rows.every((row) => row.count === 0)

/** The local wall-clock time of an instant: "09:12". */
export const clockOf = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** The visit as muted text beside the heading: "3 hours ago · Mon 09:12". */
export const visitWords = (iso: string, now: number): string =>
  `${agoWords(now - Date.parse(iso))} \u00b7 ${new Date(iso).toLocaleDateString([], { weekday: 'short' })} ${clockOf(iso)}`
