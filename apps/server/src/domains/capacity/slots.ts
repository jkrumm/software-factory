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
  /** the resident size of the command's process tree at its last renewal, and its peak */
  rssMib: number | null
  peakRssMib: number | null
  /** why a waiter is still waiting, as of its last call */
  why: string | null
  /** the caller's working directory, when it sent one */
  cwd: string | null
}

/** What the memory rule is given: the learned peak of the caller's step, the host's free memory, and the base the extras are measured from. */
export interface SlotFit {
  peakMib: number | null
  freeMib: number | null
  /** what the running steps will still grow by */
  growthMib: number
  /** the most steps at once, whatever the memory */
  max: number
  /** whether the host's load allows a step beyond the base slots */
  loadOk: boolean
  headroomMib: number
  /** for the message only */
  load?: number | null
  extraLoad?: number
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
  /** why the caller waits, when it does */
  why: string | null
}

const gib = (mib: number): string => `${(mib / 1024).toFixed(1)} GiB`

/** Whether the first waiter gets a slot with `holders` taken, and if not why. */
function decide(holders: number, base: number, fit: SlotFit): { grant: true } | { grant: false; why: string } {
  const max = Math.max(base, fit.max)
  if (holders >= max) return { grant: false, why: `all ${max} slots are busy` }
  if (holders === 0) return { grant: true }
  const { peakMib, freeMib } = fit
  const known = peakMib !== null && freeMib !== null
  const fits = known && peakMib + fit.growthMib <= freeMib - fit.headroomMib
  const memory = (): { grant: false; why: string } => ({
    grant: false,
    why: `waiting for memory: needs ${gib(peakMib ?? 0)} (learned from the last runs), ${gib(Math.max(0, (freeMib ?? 0) - fit.growthMib))} free after ${gib(fit.growthMib)} the running steps still grow, headroom ${gib(fit.headroomMib)}`,
  })
  if (holders < base) return !known || fits ? { grant: true } : memory()
  if (!fit.loadOk) {
    const over =
      fit.load != null && fit.extraLoad !== undefined ? `load ${fit.load} is over ${fit.extraLoad}` : 'load is too high'
    return { grant: false, why: `${over} for a slot beyond the first ${base}` }
  }
  if (peakMib === null)
    return { grant: false, why: `no learned peak for this step yet, so no slot beyond the first ${base}` }
  if (freeMib === null) return { grant: false, why: 'no recent free-memory reading, so no slot beyond the base' }
  return fits ? { grant: true } : memory()
}

/**
 * One call of a caller, which is a request for a slot and a renewal of the one it has: the first call makes it a
 * waiter; a call from a waiter first in line, with a slot free, gives it that slot; a call from a holder renews the
 * lease. Slots go to waiters in the order they asked. Rows past their lease (holders) or their poll window (waiters)
 * are removed first, so an expired lease frees its slot without anything else having to notice.
 */
export function touchSlots(
  rows: readonly SlotRow[],
  input: {
    id: string
    name: string
    slots: number
    runMs: number
    fit: SlotFit
    cwd?: string | undefined
    rssMib?: number | undefined
    peakRssMib?: number | undefined
  },
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
    ? {
        ...existing,
        seenAt: now,
        leasedUntil: existing.slot === null ? null : leaseEnd,
        rssMib: input.rssMib ?? existing.rssMib,
        peakRssMib:
          input.peakRssMib === undefined ? existing.peakRssMib : Math.max(input.peakRssMib, existing.peakRssMib ?? 0),
      }
    : {
        id: input.id,
        name: input.name,
        requestedAt: now,
        seenAt: now,
        slot: null,
        leasedUntil: null,
        grantedAt: null,
        runMs: null,
        rssMib: null,
        peakRssMib: null,
        why: null,
        cwd: input.cwd ?? null,
      }
  const others = kept.filter((row) => row.id !== input.id)
  const view = (row: SlotRow, ahead: number, why: string | null = null): SlotView => ({
    id: row.id,
    name: row.name,
    granted: row.slot !== null,
    slot: row.slot,
    leaseMs: SLOT_LEASE_MS,
    ahead,
    runMs: row.runMs ?? input.runMs,
    why,
  })
  if (mine.slot !== null) return { rows: [...others, mine], view: view(mine, 0) }

  const taken = new Set(others.flatMap((row) => (row.slot === null ? [] : [row.slot])))
  const line = [...others.filter((row) => row.slot === null), mine].sort(
    (a, b) => a.requestedAt.getTime() - b.requestedAt.getTime() || a.id.localeCompare(b.id),
  )
  const ahead = line.findIndex((row) => row.id === input.id)
  const verdict = decide(taken.size, input.slots, input.fit)
  const wait = (why: string): { rows: SlotRow[]; view: SlotView } => ({
    rows: [...others, { ...mine, why }],
    view: view(mine, ahead, why),
  })
  // Only the waiter first in line is given a slot; the ones behind it wait for their turn, for the same reason.
  if (!verdict.grant) return wait(verdict.why)
  if (ahead > 0) return wait(`waiting for the ${ahead} ahead in line`)
  const max = Math.max(input.slots, input.fit.max)
  const slot = Array.from({ length: max }, (_, i) => i + 1).find((n) => !taken.has(n))
  if (slot === undefined) return wait(`all ${max} slots are busy`)
  const granted: SlotRow = { ...mine, slot, leasedUntil: leaseEnd, grantedAt: now, runMs: input.runMs, why: null }
  return { rows: [...others, granted], view: view(granted, 0) }
}

/** The steps holding a live slot and the callers still asking for one. */
export function slotCounts(rows: readonly SlotRow[], now: Date): { holders: number; waiters: number } {
  const t = now.getTime()
  return {
    holders: rows.filter((row) => row.slot !== null && (row.leasedUntil?.getTime() ?? 0) >= t).length,
    waiters: rows.filter((row) => row.slot === null && row.seenAt.getTime() >= t - WAITER_TTL_MS).length,
  }
}

/** Gives the slot back (or leaves the line). */
export const releaseSlot = (rows: readonly SlotRow[], id: string): { rows: SlotRow[]; had: boolean } => ({
  rows: rows.filter((row) => row.id !== id),
  had: rows.some((row) => row.id === id),
})

/**
 * `test slot 1 held by "<name>" for 20 min, limit 30 min`: a held slot past half its run limit; and
 * `test slot wait "<name>": <why>` for a waiter that still asks.
 */
export function slotLines(rows: readonly SlotRow[], now: Date): string[] {
  const waits = rows
    .filter((row) => row.slot === null && row.why !== null && row.seenAt.getTime() >= now.getTime() - WAITER_TTL_MS)
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
    .map((row) => `test slot wait "${row.name}": ${row.why}`)
  const held = rows
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
  return [...held, ...waits]
}

/**
 * Whether a slot is held or asked for (the waiter still polls) by a command started in `dir` or below it: the live work
 * of the lead whose worktree `dir` is.
 */
export function slotLiveIn(rows: readonly SlotRow[], dir: string, now: Date): boolean {
  const root = dir.replace(/\/+$/, '')
  return rows.some(
    (row) =>
      row.cwd !== null &&
      (row.cwd === root || row.cwd.startsWith(`${root}/`)) &&
      (row.slot === null
        ? row.seenAt.getTime() >= now.getTime() - WAITER_TTL_MS
        : (row.leasedUntil?.getTime() ?? 0) >= now.getTime()),
  )
}
