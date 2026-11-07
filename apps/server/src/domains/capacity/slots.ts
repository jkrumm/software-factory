/** A holder that has not renewed within this long has died: its slot is free. It renews well inside it. */
export const SLOT_LEASE_MS = 30_000
/** A waiter that has not asked again within this long has given up and no longer holds up the ones behind it. */
export const WAITER_TTL_MS = 15_000

export interface SlotRow {
  id: string
  name: string
  requestedAt: Date
  seenAt: Date
  /** the slot number, once granted */
  slot: number | null
  leasedUntil: Date | null
  grantedAt: Date | null
  runMs: number | null
}

export interface SlotView {
  id: string
  name: string
  granted: boolean
  slot: number | null
  leaseMs: number
  /** callers in line before this one */
  ahead: number
  /** how long the command may run once granted */
  runMs: number
}

/**
 * One call of a caller, which is a request for a slot and a renewal of the one it has: the first call makes it a
 * waiter; a call from a waiter first in line, with a slot free, gives it that slot; a call from a holder renews the
 * lease. Slots go to waiters in the order they asked. Rows past their lease (holders) or their poll window (waiters)
 * are removed first, so an expired lease frees its slot without anything else having to notice.
 */
export function touchSlots(
  rows: readonly SlotRow[],
  input: { id: string; name: string; slots: number; runMs: number },
  now: Date,
): { rows: SlotRow[]; view: SlotView } {
  const leaseEnd = new Date(now.getTime() + SLOT_LEASE_MS)
  const kept = rows.filter((row) =>
    row.slot === null
      ? row.seenAt.getTime() >= now.getTime() - WAITER_TTL_MS
      : (row.leasedUntil?.getTime() ?? 0) >= now.getTime(),
  )
  const existing = kept.find((row) => row.id === input.id)
  const mine: SlotRow = existing
    ? { ...existing, seenAt: now, leasedUntil: existing.slot === null ? null : leaseEnd }
    : {
        id: input.id,
        name: input.name,
        requestedAt: now,
        seenAt: now,
        slot: null,
        leasedUntil: null,
        grantedAt: null,
        runMs: null,
      }
  const others = kept.filter((row) => row.id !== input.id)
  const view = (row: SlotRow, ahead: number): SlotView => ({
    id: row.id,
    name: row.name,
    granted: row.slot !== null,
    slot: row.slot,
    leaseMs: SLOT_LEASE_MS,
    ahead,
    runMs: row.runMs ?? input.runMs,
  })
  if (mine.slot !== null) return { rows: [...others, mine], view: view(mine, 0) }

  const taken = new Set(others.flatMap((row) => (row.slot === null ? [] : [row.slot])))
  const free = Array.from({ length: input.slots }, (_, i) => i + 1).filter((n) => !taken.has(n))
  const line = [...others.filter((row) => row.slot === null), mine].sort(
    (a, b) => a.requestedAt.getTime() - b.requestedAt.getTime() || a.id.localeCompare(b.id),
  )
  const ahead = line.findIndex((row) => row.id === input.id)
  const slot = free[ahead]
  if (slot === undefined) return { rows: [...others, mine], view: view(mine, ahead) }
  const granted: SlotRow = { ...mine, slot, leasedUntil: leaseEnd, grantedAt: now, runMs: input.runMs }
  return { rows: [...others, granted], view: view(granted, 0) }
}

/** Gives the slot back (or leaves the line). */
export const releaseSlot = (rows: readonly SlotRow[], id: string): { rows: SlotRow[]; had: boolean } => ({
  rows: rows.filter((row) => row.id !== id),
  had: rows.some((row) => row.id === id),
})

/** `test slot 1 held by "<name>" for 20 min, limit 30 min`: a held slot past half its run limit. */
export function slotLines(rows: readonly SlotRow[], now: Date): string[] {
  return rows
    .filter(
      (row) =>
        row.slot !== null &&
        row.grantedAt &&
        row.runMs !== null &&
        (row.leasedUntil?.getTime() ?? 0) >= now.getTime() &&
        now.getTime() - row.grantedAt.getTime() > row.runMs / 2,
    )
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
    .map(
      (row) =>
        `test slot ${row.slot} held by "${row.name}" for ${Math.floor((now.getTime() - (row.grantedAt?.getTime() ?? 0)) / 60_000)} min, limit ${Math.round((row.runMs ?? 0) / 60_000)} min`,
    )
}
