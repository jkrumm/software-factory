import type { SQL } from 'bun'
import { readSeenAt, windowStart } from '../fleet/presence.ts'
import { buildSince, type SinceGroups } from '../fleet/since.ts'
import { readSnapshot } from '../fleet/store.ts'
import { quote } from './text.ts'

/** The morning reading looks back to the owner's last catch-up, at most this far. */
export const DIGEST_WINDOW_MS = 24 * 60 * 60_000
/** A server that was down at the digest time sends it at start, but only before this local time. */
export const DIGEST_LATEST = '12:00'
/** Hard limit of the morning reading, in characters. */
export const DIGEST_MAX_CHARS = 3000
const SHOWN = 6
/** A list's line is cut here, so the five groups, the spend and the count fit the 3000 whatever the titles are. */
const LINE_MAX = 450
const QUOTA_SHOWN = 8

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

const percent = (value: number | null): string => (value === null ? '?' : `${Math.round(value)}%`)

/**
 * The morning reading (FV Wave 4): the since reading's groups for the window from the owner's cursor (24 h back at most) as plain text under
 * 3000 characters. A message is a template filled with facts (SF2): **no model text** (the headline paragraph stays on the board), agent
 * words are cut, quoted and scrubbed (`quote`), and an IuRoot item is a count only.
 */
export function renderMorning(groups: SinceGroups, date: string, reserve = 0): string {
  const shown = <T extends { visible: boolean }>(items: readonly T[]): T[] => items.filter((i) => !i.visible)
  const hidden = [groups.needsYou, groups.shipped, groups.recovered, groups.running, groups.handled].reduce(
    (n, items) => n + items.filter((i) => i.visible).length,
    0,
  )
  const lines = [
    `Factory morning reading ${date}, since ${groups.t.slice(0, 16).replace('T', ' ')}Z${groups.seenAt === groups.t ? ' (your last catch-up)' : ''}`,
  ]
  const list = <T extends { visible: boolean }>(
    label: string,
    items: readonly T[],
    show: (item: T) => string,
  ): void => {
    const own = shown(items)
    const rest = items.length - own.length
    const line =
      items.length === 0
        ? `${label}: none`
        : `${label}: ${items.length}${own.length > 0 ? `: ${own.slice(0, SHOWN).map(show).join('; ')}${own.length > SHOWN ? ` (+${own.length - SHOWN} more)` : ''}` : ''}${rest > 0 && own.length > 0 ? ` (+${rest} elsewhere)` : ''}`
    lines.push(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line)
  }
  list('Needs you', groups.needsYou, (n) => `${n.yours ? 'yours ' : ''}${n.ask.kind} ${quote(n.ask.text, 60)}`)
  list('Shipped', groups.shipped, (s) => quote(s.text, 60))
  list('Went wrong, then recovered', groups.recovered, (r) => quote(r.text, 70))
  const triage = groups.handled.filter((h) => h.kind === 'triage')
  const reaped = groups.handled.filter((h) => h.kind === 'reaped')
  const acts = groups.handled.filter((h) => h.kind === 'act')
  lines.push(
    `Handled for you: ${triage.length} by the triage (${triage.filter((h) => h.undoId !== null).length} undoable), ${acts.length} by you`,
  )
  if (reaped.length > 0) {
    lines.push(
      `Closed for you: ${reaped.length} finished worker session${reaped.length === 1 ? '' : 's'} (the worktrees stay)`,
    )
  }
  lines.push(
    groups.running.length === 0
      ? 'Still running: none'
      : `Still running: ${groups.running.length}${
          shown(groups.running).length > 0
            ? `: ${shown(groups.running)
                .slice(0, SHOWN)
                .map((r) => quote(r.id, 40))
                .join('; ')}`
            : ''
        }`.slice(0, LINE_MAX),
  )
  const accounts = groups.spend.accounts
  lines.push(
    accounts.length === 0
      ? 'Spend: no reading'
      : `Spend: ${accounts
          .slice(0, QUOTA_SHOWN)
          .map((a) => `${a.account.slice(0, 24)} week ${percent(a.weeklyAtStart)} to ${percent(a.weeklyNow)}`)
          .join(
            '; ',
          )}${accounts.length > QUOTA_SHOWN ? ` (+${accounts.length - QUOTA_SHOWN} more)` : ''}; digest $${groups.spend.digestUsd.toFixed(2)}`,
  )
  if (groups.incomplete.length > 0)
    lines.push(`Shipped may miss commits in ${groups.incomplete.length} repos (git did not answer)`)
  if (hidden > 0) lines.push(`Read-only area: ${hidden} items, counted only`)
  const text = lines.join('\n')
  const max = DIGEST_MAX_CHARS - reserve
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The morning reading as of `now` for the local `date`. */
export async function loadMorning(
  sql: SQL,
  input: { now: Date; date: string; isVisible: (path: string) => boolean },
): Promise<string> {
  const { now } = input
  const seenAt = await readSeenAt(sql)
  const oldest = new Date(now.getTime() - DIGEST_WINDOW_MS)
  const cursor = windowStart({ seenAt, now }).t
  const t = cursor > oldest ? cursor : oldest
  const snapshot = await readSnapshot(sql)
  const groups = await buildSince(sql, {
    snapshot,
    now,
    t,
    clamped: false,
    seenAt,
    isVisible: input.isVisible,
  })
  // No fleet model yet: the asks, commits and sessions are not in this reading, and it must not read as "nothing happened".
  const note = '\nThe fleet model was not built yet: asks, commits and sessions are missing from this reading'
  const text = renderMorning(groups, input.date, snapshot ? 0 : note.length)
  return snapshot ? text : `${text}${note}`
}
