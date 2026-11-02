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
  input: { place: PresencePlace; act: PresenceAct },
): Promise<Presence> {
  const { sql } = reader
  const now = reader.now()
  const before = await readPresence(sql, now)
  await recordPresence(sql, { place: input.place, act: input.act, now })
  if (input.place === 'desk' && !before.desk.present && input.act !== 'caught_up') {
    try {
      await readSince(reader, { queue: 'now' })
    } catch (error) {
      console.error('fleet presence: queueing the window failed', error instanceof Error ? error.message : error)
    }
  }
  return readPresence(sql, now)
}

/** Asks of the open window (raised since the cursor, at most 7 days back) that are still listed, besides `except`. */
async function openAsks(sql: SQL, now: Date, except: string): Promise<number> {
  const snapshot = await readSnapshot(sql)
  if (!snapshot) return 1
  const { t } = windowStart({ seenAt: await readSeenAt(sql), now })
  return snapshot.asks.filter((a) => a.id !== except && Date.parse(a.at) >= t.getTime()).length
}

/**
 * The owner acted on an ask (`POST /fleet/asks/:id/act`): a presence act for the place it names, and the cursor moves to now when that act
 * leaves no other ask of the open window in Needs you. Never backwards.
 */
export async function recordAskAct(sql: SQL, input: { place: PresencePlace; ask: string; now: Date }): Promise<void> {
  const { place, ask, now } = input
  // Acting on a card is a click on the board at the desk, and Iris in the foreground on the phone.
  await recordPresence(sql, { place, act: place === 'desk' ? 'board_click' : 'foreground', now })
  if ((await openAsks(sql, now, ask)) === 0) await moveSeen(sql, now)
}
