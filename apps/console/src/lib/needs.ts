import type { NeedItem } from '@software-factory/contract'

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

/** When the factory takes the default, relative to `now`: "Default taken in 40 minutes", or "Default taken at the next pass" once due. */
export function defaultWords(defaultAt: string, now: number): string {
  const left = Date.parse(defaultAt) - now
  return left <= 0 ? 'Default taken at the next pass' : `Default taken in ${spanWords(left)}`
}

/** Where an item comes from, as a word: the repo, or "App feedback" for outside text that names none. */
export const originOf = (item: Pick<NeedItem, 'repo'>): string => item.repo ?? 'App feedback'

/** The Issue page's route parameter of an item's `issue_<n>`: the number. */
export const issueNumber = (ref: string): string => ref.replace(/^issue_/, '')

export const reversibleWords = (reversible: boolean): string => (reversible ? 'reversible' : 'not reversible')

export const KIND_LABEL = {
  decision: 'Decisions',
  review: 'Reviews',
  errand: 'Errands',
  held_signal: 'Held signals',
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
