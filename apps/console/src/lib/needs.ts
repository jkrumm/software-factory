import type { NeedItem, NeedKind } from '@software-factory/contract'
import type { LozengeState } from '../components/kit/lozenge.tsx'
import { plainExcerpt } from './plain.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`

/** A span in plain words, rounded down: "5 minutes", "2 hours", "3 days"; under a minute, "under a minute". */
export function spanWords(ms: number): string {
  if (ms < MINUTE) return 'under a minute'
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), 'minute')
  if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour')
  return plural(Math.floor(ms / DAY), 'day')
}

/** How long an item has waited: "Waiting 2 hours". */
export const waitingWords = (ageMs: number): string => `Waiting ${spanWords(ageMs)}`

/** When the factory takes the default, relative to `now`: "in 40 minutes", or "at the next pass" once due. */
export function defaultWhen(defaultAt: string, now: number): string {
  const left = Date.parse(defaultAt) - now
  return left <= 0 ? 'at the next pass' : `in ${spanWords(left)}`
}

/** The default on its option's card, the time first: "In 7 hours, if nobody answers: The lead waits." */
export function defaultLine(consequence: string, defaultAt: string, now: number): string {
  const when = defaultWhen(defaultAt, now)
  return `${when.charAt(0).toUpperCase()}${when.slice(1)}, if nobody answers: ${consequence}`
}

/** "Default taken in 40 minutes", or "Default taken at the next pass" once due. */
export const defaultWords = (defaultAt: string, now: number): string => `Default taken ${defaultWhen(defaultAt, now)}`

/** An age as one phrase everywhere: "3 hours ago", or "just now" under a minute. */
export function agoWords(ms: number): string {
  const span = spanWords(Math.max(0, ms))
  return span === 'under a minute' ? 'just now' : `${span} ago`
}

/** How long an item has been there, in the verb of its kind: "Waiting 2 hours", "Raised 2 hours ago", "Received just now". */
export function metaParts(item: Pick<NeedItem, 'kind' | 'ageMs'>): {
  lead: 'Waiting' | 'Raised' | 'Received' | 'Held'
  age: string
} {
  if (item.kind === 'long_wait') return { lead: 'Held', age: spanWords(item.ageMs) }
  if (item.kind === 'errand') return { lead: 'Raised', age: agoWords(item.ageMs) }
  if (item.kind === 'held_signal') return { lead: 'Received', age: agoWords(item.ageMs) }
  return { lead: 'Waiting', age: spanWords(item.ageMs) }
}

/** `metaParts` as one phrase. */
export function metaWords(item: Pick<NeedItem, 'kind' | 'ageMs'>): string {
  const { lead, age } = metaParts(item)
  return `${lead} ${age}`
}

/** Where an item comes from, as a word: the repo; "Requests" for an Errand no Issue raised; "App feedback" for outside text that names none. */
export const originOf = (item: Pick<NeedItem, 'repo'> & Partial<Pick<NeedItem, 'kind' | 'source'>>): string =>
  item.repo ?? (item.kind === 'errand' && item.source != null ? 'Requests' : 'App feedback')

/** The project filter's value and the chip's word: the repo, or "App feedback" for an item that names none. */
export const projectOf = originOf

/** The collapsed card's summary line, or null when it only repeats the title or the Issue's title. */
export function summaryLine(item: Pick<NeedItem, 'title' | 'summary'>, issueTitle: string | null): string | null {
  const summary = item.summary.trim().toLowerCase()
  if (summary === '' || summary === item.title.trim().toLowerCase()) return null
  if (summary === issueTitle?.trim().toLowerCase()) return null
  return plainExcerpt(item.summary) || null
}

/** The Issue page's route parameter of an item's `issue_<n>`: the number. */
export const issueNumber = (ref: string): string => ref.replace(/^issue_/, '')

/** What a Decision is, in one line for the card that opens it. */
export function decisionParts(
  project: string,
  issueTitle: string | null,
): { before: string; issue: string | null; after: string } {
  const after = ': the lead hears your answer as a note and carries on'
  const before = `A decision for you from the lead of ${project}`
  return issueTitle ? { before: `${before}, Issue `, issue: issueTitle, after } : { before, issue: null, after }
}

/** Whether the question is the card's title already (the title is the question, cut and without ids). */
export function repeatsTitle(question: string, title: string): boolean {
  const cut = norm(title)
    .replace(/(…|\.\.\.)$/, '')
    .trim()
  return cut !== '' && norm(question).startsWith(cut)
}

/** The page note: everything that waits on the owner, or how much of it the filters show. */
export const needsNote = (shown: number, total: number, filtered: boolean): string =>
  filtered ? `Showing ${shown} of ${total}` : `${total} need you`

export const KIND_LABEL = {
  decision: 'Decisions',
  review: 'Reviews',
  errand: 'Errands',
  held_signal: 'Held signals',
  long_wait: 'Long waits',
} as const satisfies Record<NeedItem['kind'], string>

export const ARTIFACT_KIND_LABEL: Record<string, string> = {
  concept: 'Concept',
  spec: 'Spec',
  decision: 'Decision',
  report: 'Report',
}

export const VERDICTS = [
  { value: 'looks_good', label: 'Looks good', needsNote: false },
  { value: 'with_notes', label: 'With notes', needsNote: true },
  { value: 'changes', label: 'Changes', needsNote: true },
  { value: 'no_longer_applies', label: 'No longer applies', needsNote: false },
] as const

/** The words an error shows inline: a settled thing says so, anything else says what the API said. */
export function errorWords(status: number | null, detail: string | null): string {
  if (status === 409) return 'Already settled elsewhere'
  if (status === null) return 'Could not reach the factory'
  return detail ?? 'The factory refused this'
}

/** A Lozenge for an option's reversibility, from an explicit map: reversible is good, not reversible is a warning. */
export const reversibleLozenge = (reversible: boolean): { state: LozengeState; words: string } =>
  reversible ? { state: 'done', words: 'Reversible' } : { state: 'waiting', words: 'Not reversible' }

const norm = (text: string): string => text.trim().toLowerCase()

/** The option a sentence names (its label, ignoring case and spaces), or -1: a recommendation may be a sentence of its own. */
export function optionIndex(options: readonly { label: string }[], sentence: string | null): number {
  if (sentence === null || norm(sentence) === '') return -1
  return options.findIndex((option) => norm(option.label) === norm(sentence))
}

/** An external link the Console may open: only http and https. */
export function httpLink(link: string | null): string | null {
  if (link === null) return null
  try {
    const url = new URL(link)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export interface NeedFilters {
  kind?: NeedKind
  project?: string
}

/**
 * The items the filters leave, in order. The deep-linked item (`keepId`) stays even when the filters would hide it, so a
 * link to an item always opens it.
 */
export function visibleNeeds(items: readonly NeedItem[], filters: NeedFilters, keepId?: string): NeedItem[] {
  return items.filter(
    (item) =>
      item.id === keepId ||
      ((!filters.kind || item.kind === filters.kind) && (!filters.project || projectOf(item) === filters.project)),
  )
}

/** How many items of each kind, under the project filter alone. */
export function kindCounts(items: readonly NeedItem[], project?: string): Record<NeedKind, number> {
  const counts: Record<NeedKind, number> = { decision: 0, review: 0, errand: 0, held_signal: 0, long_wait: 0 }
  for (const item of items) if (!project || projectOf(item) === project) counts[item.kind] += 1
  return counts
}

/** How many items each project has, under the kind filter alone. */
export function projectCounts(items: readonly NeedItem[], kind?: NeedKind): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items)
    if (!kind || item.kind === kind) counts[projectOf(item)] = (counts[projectOf(item)] ?? 0) + 1
  return counts
}

/** Every project that has an item, sorted; a filter on one that has none is still listed so it can be removed. */
export function projectsOfNeeds(items: readonly NeedItem[], keep?: string): string[] {
  const projects = new Set(items.map(projectOf))
  if (keep) projects.add(keep)
  return [...projects].sort((a, b) => a.localeCompare(b))
}

/** Where the owner's hands must be, in the order a desk is worked through. */
export const DESK_HOSTS = ['macbook', 'iphone', 'portal', 'any'] as const satisfies readonly NonNullable<
  NeedItem['host']
>[]
export type DeskHost = (typeof DESK_HOSTS)[number]

export const DESK_LABEL: Record<DeskHost, string> = {
  macbook: 'On the MacBook',
  iphone: 'On the iPhone',
  portal: 'In a portal',
  any: 'Anywhere',
}

/** The Errands grouped by where the hands must be (the groups with none are left out), the oldest first inside a group. */
export function deskGroups(items: readonly NeedItem[]): { host: DeskHost; label: string; items: NeedItem[] }[] {
  const errands = items.filter((item) => item.kind === 'errand')
  return DESK_HOSTS.flatMap((host) => {
    const mine = errands.filter((item) => (item.host ?? 'any') === host).toSorted((a, b) => b.ageMs - a.ageMs)
    return mine.length === 0 ? [] : [{ host, label: DESK_LABEL[host], items: mine }]
  })
}

/** The browser tab's title: the count of what waits on the owner, or the page's name alone. */
export const needsTitle = (count: number, desk: boolean): string =>
  `${count > 0 ? `(${count}) ` : ''}${desk ? 'Back at desk' : 'Needs you'} \u00b7 Software Factory`

/** What a done on an Errand says: the server leaves it open when its check still says it is needed. */
export const doneWords = (reply: { errand: { doneAt: string | null } }): string =>
  reply.errand.doneAt === null ? 'Not done: its check says it is still needed' : 'Marked done'
