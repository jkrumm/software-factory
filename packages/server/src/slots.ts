import type { Slot } from '@software-factory/contract'
import type { SQL } from 'bun'
import { LOCKS } from './locks.ts'

/** A holder that has not renewed within this long has died: its slot is free. It renews well inside it. */
export const SLOT_LEASE_MS = 30_000
/** A waiter that has not polled within this long has given up and no longer holds up the ones behind it. */
export const WAITER_TTL_MS = 15_000

interface SlotRow {
  id: string
  name: string
  requested_at: Date
  slot: number | null
}

/**
 * One call of a caller, which is a request for a slot and a renewal of the one it has: the first call makes it a waiter,
 * a call from a waiter first in line, with a slot free, gives it that slot, a call from a holder renews the lease. Slots go to
 * waiters in the order they asked. Rows past their lease (holders) or their poll window (waiters) are removed first, so
 * an expired lease frees its slot without anything else having to notice. Everything happens behind one advisory lock.
 */
export async function touchSlot(
  sql: SQL,
  input: { id: string; name: string; slots: number },
  now: Date,
): Promise<Slot> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCKS.slots})`
    const leaseEnd = new Date(now.getTime() + SLOT_LEASE_MS)
    await tx`
      DELETE FROM factory.slots
      WHERE (slot IS NULL AND seen_at < ${new Date(now.getTime() - WAITER_TTL_MS)}) OR (slot IS NOT NULL AND leased_until < ${now})`
    await tx`
      INSERT INTO factory.slots (id, name, requested_at, seen_at)
      VALUES (${input.id}, ${input.name}, ${now}, ${now})
      ON CONFLICT (id) DO UPDATE
        SET seen_at = ${now}, leased_until = CASE WHEN factory.slots.slot IS NULL THEN NULL ELSE ${leaseEnd}::timestamptz END`
    const rows: SlotRow[] = await tx`SELECT id, name, requested_at, slot FROM factory.slots`
    const mine = rows.find((r) => r.id === input.id)
    if (!mine) throw new Error(`slot ${input.id} was not stored`)
    if (mine.slot !== null) return view(mine, 0)

    const taken = new Set(rows.flatMap((r) => (r.slot === null ? [] : [r.slot])))
    const free = Array.from({ length: input.slots }, (_, i) => i + 1).filter((n) => !taken.has(n))
    const line = rows
      .filter((r) => r.slot === null)
      .sort((a, b) => a.requested_at.getTime() - b.requested_at.getTime() || a.id.localeCompare(b.id))
    const ahead = line.findIndex((r) => r.id === input.id)
    const slot = free[ahead]
    if (slot === undefined) return view(mine, ahead)
    await tx`UPDATE factory.slots SET slot = ${slot}, leased_until = ${leaseEnd} WHERE id = ${input.id}`
    return view({ ...mine, slot }, 0)
  })
}

const view = (row: SlotRow, ahead: number): Slot => ({
  id: row.id,
  name: row.name,
  granted: row.slot !== null,
  slot: row.slot,
  leaseMs: SLOT_LEASE_MS,
  ahead,
})

/** Gives the slot back (or leaves the line). True if the caller had a row. */
export async function releaseSlot(sql: SQL, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM factory.slots WHERE id = ${id} RETURNING id`
  return rows.length > 0
}

/** Who holds a slot and who waits, for the status screen and tests. */
export async function listSlots(sql: SQL): Promise<{ id: string; name: string; slot: number | null }[]> {
  return sql`SELECT id, name, slot FROM factory.slots ORDER BY slot NULLS LAST, requested_at, id`
}
