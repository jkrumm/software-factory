import type { Fleet, Presence, PresenceAct, PresencePlace } from '@software-factory/contract'
import type { SQL } from 'bun'
import { readSnapshot } from './store.ts'

/**
 * Presence (FV Wave 4, docs/design.md §11 "The fleet view"): where the owner is, from acts only a person makes. An act is a row; presence
 * is derived by the clock and never stored. Nothing else moves it: no hook event, prompt, note, `rd say` or HID idle (the routes that
 * could are not wired to this module, and a test pins it).
 */

/** The desk is present while its last act is under this old. */
export const DESK_PRESENT_MS = 45 * 60_000
/** The phone, under this. */
export const PHONE_PRESENT_MS = 10 * 60_000
/** Acts are kept this long. */
export const PRESENCE_KEEP_MS = 30 * 24 * 3_600_000
/** The since reading looks back at most this far. */
export const SINCE_MAX_BACK_MS = 7 * 24 * 3_600_000

const TTL: Record<PresencePlace, number> = { desk: DESK_PRESENT_MS, phone: PHONE_PRESENT_MS }

/**
 * Where a reading ends: at `now`, or earlier at the build of the snapshot it was made from, or earlier still at the oldest time a repo's
 * commits were read (a build whose git timed out kept the previous commits). What landed after is in no reading, so the cursor never goes
 * past it. The one definition: the since reading, `caught_up` and the act that closes a window use it.
 */
export function readingEnd(now: Date, snapshot: Pick<Fleet, 'builtAt' | 'repos'>): Date {
  let end = now
  for (const at of [snapshot.builtAt, ...snapshot.repos.map((r) => r.git?.recentAt)]) {
    const time = at ? new Date(at) : undefined
    if (time && time < end) end = time
  }
  return end
}

/** One act of a person at a place; `caught_up` also moves the cursor. Short statements, no port inside. */
export async function recordPresence(
  sql: SQL,
  input: { place: PresencePlace; act: PresenceAct; now: Date; until?: Date },
): Promise<void> {
  const { place, act, now } = input
  await sql`INSERT INTO factory.fleet_presence_acts (place, act, at) VALUES (${place}, ${act}, ${now})`
  await sql`DELETE FROM factory.fleet_presence_acts WHERE at < ${new Date(now.getTime() - PRESENCE_KEEP_MS)}`
  if (act !== 'caught_up') return
  // The cursor goes to the end of the reading the owner saw, not to the click, and never past where the model was built: what landed in
  // between is in the next window. With no model built there was no reading, and the cursor stays.
  const snapshot = await readSnapshot(sql)
  if (!snapshot) return
  const end = readingEnd(now, snapshot)
  await moveSeen(sql, input.until && input.until < end ? input.until : end)
}

/** The cursor moves to `to` and never backwards. */
export async function moveSeen(sql: SQL, to: Date): Promise<void> {
  await sql`
    INSERT INTO factory.fleet_seen (id, seen_at) VALUES (1, ${to})
    ON CONFLICT (id) DO UPDATE SET seen_at = GREATEST(factory.fleet_seen.seen_at, EXCLUDED.seen_at)`
}

export async function readSeenAt(sql: SQL): Promise<Date | null> {
  const [row]: { seen_at: Date }[] = await sql`SELECT seen_at FROM factory.fleet_seen WHERE id = 1`
  return row?.seen_at ?? null
}

/**
 * Where the owner is as of `now`. Away is neither place present, also before the first act. `awaySince` is when presence ran out: the
 * later of the two places' expiries.
 */
export async function readPresence(sql: SQL, now: Date): Promise<Presence> {
  const rows: { place: PresencePlace; at: Date }[] = await sql`
    SELECT place, max(at) AS at FROM factory.fleet_presence_acts GROUP BY place`
  const last = new Map(rows.map((r) => [r.place, r.at]))
  const place = (name: PresencePlace) => {
    const at = last.get(name) ?? null
    const expires = at === null ? null : at.getTime() + TTL[name]
    return { at, expires, present: expires !== null && now.getTime() < expires }
  }
  const desk = place('desk')
  const phone = place('phone')
  const away = !desk.present && !phone.present
  const expiries = [desk.expires, phone.expires].filter((e): e is number => e !== null)
  return {
    desk: { at: desk.at?.toISOString() ?? null, present: desk.present },
    phone: { at: phone.at?.toISOString() ?? null, present: phone.present },
    away,
    awaySince: away && expiries.length > 0 ? new Date(Math.max(...expiries)).toISOString() : null,
    seenAt: (await readSeenAt(sql))?.toISOString() ?? null,
  }
}

/**
 * The start of the since window: `t` or, without one, the cursor (24 h back when the owner has never caught up); at most 7 days back.
 * `clamped` says it was cut.
 */
export function windowStart(input: { t?: Date | null; seenAt: Date | null; now: Date }): { t: Date; clamped: boolean } {
  const { now } = input
  const wanted = input.t ?? input.seenAt ?? new Date(now.getTime() - 24 * 3_600_000)
  const oldest = new Date(now.getTime() - SINCE_MAX_BACK_MS)
  return wanted < oldest ? { t: oldest, clamped: true } : { t: wanted, clamped: false }
}
