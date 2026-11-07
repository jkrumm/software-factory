import type { SQL } from 'bun'
import type { Fleet } from '@software-factory/contract'
import { readSnapshot } from '../fleet/store.ts'
import { quote } from './text.ts'

/** The morning reading looks back this far for the Issues that shipped. */
export const DIGEST_WINDOW_MS = 24 * 60 * 60_000
/** A server that was down at the digest time sends it at start, but only before this local time. */
export const DIGEST_LATEST = '12:00'
/** Hard limit of the morning reading, in characters. */
export const DIGEST_MAX_CHARS = 3000
const SHOWN = 6
/** A list's line is cut here, so the five groups, the spend and the count fit the 3000 whatever the titles are. */
const LINE_MAX = 450

/** The local date and `HH:MM` of an instant in a time zone. */
export function localParts(at: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` }
}

/**
 * The local date the digest is due for, or none: from `at` on, until noon. Before `at` it is not time yet; after noon a server
 * that was down missed it, and a digest at three in the afternoon is not the morning's. `HH:MM` strings of one day compare as text.
 */
export function digestDue(now: Date, input: { at: string; timeZone: string }): string | null {
  const local = localParts(now, input.timeZone)
  return local.time >= input.at && local.time < DIGEST_LATEST ? local.date : null
}

/** What the morning reading is made of: the Issues closed as done in the window, and the stored fleet snapshot's asks, health lines and open Issues. */
export interface MorningFacts {
  since: Date
  shipped: { id: number; title: string; repo: string }[]
  /** `undefined` before the first fleet build */
  snapshot: Pick<Fleet, 'asks' | 'health' | 'issues'> | undefined
  isVisible: (path: string | null) => boolean
}

/**
 * The morning reading: facts only, as plain text under 3000 characters. A message is a template filled with facts (SF2): **no model
 * text**, agent words are cut, quoted and scrubbed (`quote`), and an IuRoot item is a count only.
 */
export function renderMorning(facts: MorningFacts, date: string): string {
  const { snapshot, isVisible } = facts
  const lines = [`Factory morning reading ${date}, since ${facts.since.toISOString().slice(0, 16).replace('T', ' ')}Z`]
  let hidden = 0
  const list = <T extends { repo: string | null }>(
    label: string,
    items: readonly T[],
    show: (item: T) => string,
  ): void => {
    const own = items.filter((i) => !isVisible(i.repo))
    hidden += items.length - own.length
    const line =
      items.length === 0
        ? `${label}: none`
        : `${label}: ${items.length}${own.length > 0 ? `: ${own.slice(0, SHOWN).map(show).join('; ')}${own.length > SHOWN ? ` (+${own.length - SHOWN} more)` : ''}` : ''}`
    lines.push(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line)
  }
  list('Needs you', snapshot?.asks ?? [], (a) => `${a.kind} ${quote(a.text, 60)}`)
  list('Health', snapshot?.health ?? [], (h) => quote(h.text, 70))
  list('Shipped', facts.shipped, (i) => `Issue ${i.id} ${quote(i.title, 60)}`)
  list('Open Issues', snapshot?.issues ?? [], (i) => `Issue ${i.id} ${i.state} ${quote(i.title, 50)}`)
  if (hidden > 0) lines.push(`Read-only area: ${hidden} items, counted only`)
  // No fleet model yet: the asks, health and open Issues are not in this reading, and it must not read as "nothing happened".
  if (!snapshot)
    lines.push('The fleet model was not built yet: asks, health and open Issues are missing from this reading')
  const text = lines.join('\n')
  return text.length > DIGEST_MAX_CHARS ? `${text.slice(0, DIGEST_MAX_CHARS - 1)}…` : text
}

/** The morning reading as of `now` for the local `date`. */
export async function loadMorning(
  sql: SQL,
  input: { now: Date; date: string; isVisible: (path: string) => boolean },
): Promise<string> {
  const { now } = input
  const since = new Date(now.getTime() - DIGEST_WINDOW_MS)
  const rows: { id: number; title: string; repo: string }[] = await sql`
    SELECT id, title, repo FROM factory.issues
    WHERE outcome = 'done' AND closed_at >= ${since} AND closed_at <= ${now} ORDER BY closed_at DESC, id DESC LIMIT 50`
  // An item with no repo is the factory's own; a path is IuRoot's when the places say so.
  const isVisible = (path: string | null): boolean => path !== null && input.isVisible(path)
  return renderMorning(
    {
      since,
      shipped: rows,
      snapshot: await readSnapshot(sql),
      isVisible,
    },
    input.date,
  )
}
