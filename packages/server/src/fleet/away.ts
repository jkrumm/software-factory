import type { Presence, PresenceAct, PresencePlace } from '@software-factory/contract'
import type { SQL } from 'bun'
import { moveSeen, readPresence, readSeenAt, recordPresence, windowStart } from './presence.ts'
import { readSince, type SinceReader } from './since.ts'
import { readSnapshot } from './store.ts'

/**
 * `POST /fleet/presence` (FV Wave 4): the act is recorded and presence answered. The first desk act after the desk was away also queues
 * the window it is about to read (and starts the digest pass at once), so the board's card has its paragraph by the time it is read.
 * The headline is a courtesy: a failure to queue it never fails the act.
 */
export async function reportPresence(
  reader: SinceReader,
  input: { place: PresencePlace; act: PresenceAct; until?: Date },
): Promise<Presence> {
  const { sql } = reader
  const now = reader.now()
  const before = await readPresence(sql, now)
  await recordPresence(sql, { place: input.place, act: input.act, now, until: input.until })
  if (input.place === 'desk' && !before.desk.present && input.act !== 'caught_up') {
    try {
      await readSince(reader, { queue: 'now' })
    } catch (error) {
      console.error('fleet presence: queueing the window failed', error instanceof Error ? error.message : error)
    }
  }
  return readPresence(sql, now)
}

/**
 * Asks of the open window (raised since the cursor, at most 7 days back) that the stored snapshot still lists, besides `except`, and when
 * the snapshot was built: the cursor only reaches what the build saw.
 */
async function openAsks(sql: SQL, now: Date, except: string): Promise<{ open: number; builtAt: Date } | undefined> {
  const snapshot = await readSnapshot(sql)
  if (!snapshot) return undefined
  const { t } = windowStart({ seenAt: await readSeenAt(sql), now })
  return {
    open: snapshot.asks.filter((a) => a.id !== except && Date.parse(a.at) >= t.getTime()).length,
    builtAt: new Date(snapshot.builtAt),
  }
}

/**
 * The owner acted on an ask (`POST /fleet/asks/:id/act`): a presence act for the place it names, and the cursor moves to now when that act
 * leaves no other ask of the open window in Needs you: to the snapshot's build time (at most now), never backwards.
 */
export async function recordAskAct(
  sql: SQL,
  input: {
    place: PresencePlace
    ask: string
    now: Date
    /** false when the snapshot was not refreshed after the act: it may still list what is closed */
    moveCursor: boolean
  },
): Promise<void> {
  const { place, ask, now, moveCursor } = input
  // Acting on a card is a click on the board at the desk, and Iris in the foreground on the phone.
  await recordPresence(sql, { place, act: place === 'desk' ? 'board_click' : 'foreground', now })
  if (!moveCursor) return
  const window = await openAsks(sql, now, ask)
  // An ask that landed after the build is not in the count: the cursor stops at what the build saw.
  if (window?.open === 0) await moveSeen(sql, window.builtAt < now ? window.builtAt : now)
}
