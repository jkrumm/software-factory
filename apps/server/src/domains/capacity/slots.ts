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
  /** when a step behind this waiter was first granted past it, and which one: the start of the passing window */
  passedAt: Date | null
  passedBy: string | null
  /** what the waiter was told it waits for at its last call (`WaitKind`); null once granted */
  whyKind: WaitKind | null
  /** the ms this waiter has spent under each reason so far: the time between two calls counts to the reason of the first */
  waitSplit: Readonly<Partial<Record<WaitKind, number>>>
  /**
   * where the row stands: a holder on the VPS (`vps`) counts in the VPS's fit and never in the mini's; a waiter with `vps` waits for
   * the VPS alone (`FACTORY_SLOT_HOST=vps`). Null is the mini, and a waiter either host may take.
   */
  host?: StepHost | null | undefined
}

/** The hosts a step may run on (the contract's `STEP_HOSTS`): domains import no contract. */
export type StepHost = 'mini' | 'vps'

/**
 * What a wait waits for: every slot taken, the memory fit, swap growing, the load gate (the tripwire under the aim), a step
 * with no size known, the line ahead, the cores fit, or its host-wide class held by another step.
 */
export const WAIT_KINDS = ['slots', 'memory', 'swap', 'load', 'unsized', 'line', 'cores', 'class'] as const
export type WaitKind = (typeof WAIT_KINDS)[number]

/**
 * The host-wide class of a step, or null: at most one step of a class holds a slot at a time, whichever repo runs it.
 * `apple` is every step named `<repo>-apple` or `<project> apple`, the name dotfiles `docs/apple-signing.md` gives every
 * xcodebuild, devicectl, archive and notarisation (iris, ntfy-mac, shutterflow and any later Xcode user). One at a time
 * not for memory (the 14 days to 2026-11-16: iris-apple peaked at 2.8 GiB, ntfy-mac-apple 2.7, shutterflow-apple 2.1, so
 * two would fit beside the leads on 32 GiB) but because the simulators and the signing keychain are the host's: iris's
 * `scripts/apple-slot --sim` shuts every simulator down when its job ends. Cargo builds are no class: measured at 5.6 GiB
 * and 3 cores (shutterflow cargo test, p80), they are packed by the memory and cores fit like any other step.
 */
export function stepClassOf(name: string): string | null {
  return /(^|[\s-])apple$/.test(name) ? 'apple' : null
}

/**
 * The cores a step with none learned is taken to need: the p85 of every step's cores (CPU seconds over its run) on the
 * day to 2026-11-16 was 0.83. That ledger counted only the processes alive at a `ps` sample, so the figure is rounded up
 * to the next core; runs since `factory slot run` reads the exit's resource usage (every reaped descendant) replace it.
 */
export const DEFAULT_STEP_CORES = 1

/**
 * How long a waiter may be passed by smaller steps before its memory is reserved (`FACTORY_SLOT_PASS_MIN`): from then on a
 * step passes it only when it fits now and is learned to end before the reserved start (`reservedStartMs`).
 */
export const DEFAULT_PASS_AFTER_MS = 10 * 60_000

/** What the memory rule is given: the learned peak of the caller's step, the host's free memory, and the base the extras are measured from. */
/** Where a step's size comes from: its own learned runs, else a prior from the steps of its project. */
export type PeakFrom = 'learned' | 'kind' | 'project' | 'default'

const PEAK_SOURCE: Record<PeakFrom, string> = {
  learned: 'learned from the last runs',
  kind: 'a guess: the largest step of this kind in the project, none of this one run yet',
  project: "a guess: the project's largest step, none of this one run yet",
  default: 'a guess: nothing of this project learned yet',
}

export interface SlotFit {
  peakMib: number | null
  /** how `peakMib` was known; absent means learned */
  peakFrom?: PeakFrom
  /** the learned peak of each waiter's step by name, for the waiters ahead of the caller (a missing name is unknown) */
  peaksByName?: ReadonlyMap<string, number | null>
  /** how each of those peaks was known; a missing name reads as learned */
  peakFromByName?: ReadonlyMap<string, PeakFrom>
  /** the learned peak of each holder's step by the holder's id (a missing id has none: its growth reads as 0) */
  heldPeakById?: ReadonlyMap<string, number | null>
  freeMib: number | null
  /** what the running steps will still grow by */
  growthMib: number
  /** the most steps at once, whatever the memory */
  max: number
  /** whether the host's load allows a step beyond the base slots */
  loadOk: boolean
  headroomMib: number
  /** swap in use rose over the newest host samples (`swapGrowing`): a second step would page the first one's memory out */
  swapGrowing?: boolean
  /** for the message only */
  load?: number | null
  extraLoad?: number
  /** where `extraLoad` comes from, for the message: the setting or the aim's multiple of the cores */
  extraLoadFrom?: string
  /** why `loadOk` is false in words of its own (the tripwire's), in place of `load` and `extraLoad` */
  loadWhy?: string
  /**
   * The cores the steps beyond the base may use together: the host's cores. Null or absent: no cores fit. Steps are
   * packed by what each is learned to take, so several light steps run beside one heavy one.
   */
  cores?: number | null
  /** what the caller's step is learned to take in cores; absent: `DEFAULT_STEP_CORES` */
  stepCores?: number
  /** the cores of each waiter's step ahead of the caller, by name; a missing name takes `DEFAULT_STEP_CORES` */
  coresByName?: ReadonlyMap<string, number>
  /** the cores the running steps are learned to take, summed */
  heldCores?: number
  /** each waiter's learned run in ms by name, for the order of the line; a missing or null name has none learned */
  runMsByName?: ReadonlyMap<string, number | null>
  /** the caller's step's learned run in ms (null or absent: none learned, so it never backfills ahead of a reserved head) */
  stepRunMs?: number | null
  /** each holder's step's learned run in ms by the holder's id; a missing or null id has none learned and reads as ending now */
  heldRunMsById?: ReadonlyMap<string, number | null>
}

/** One step as the grant weighs it: its name (and so its class), its learned memory peak and its cores. */
interface StepSize {
  name: string
  peakMib: number | null
  peakFrom: PeakFrom
  cores: number
}

/** The slots taken: how many, and how many of each host-wide class. */
interface Taken {
  count: number
  classes: ReadonlyMap<string, number>
}

/** What a granted step waited for: its whole wait and the split of it by reason (the time between two calls counts to the reason given at the first). */
export interface Waited {
  ms: number
  split: Readonly<Partial<Record<WaitKind, number>>>
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
  /** where the granted step runs */
  host: StepHost
}

const gib = (mib: number): string => `${(mib / 1024).toFixed(1)} GiB`

const cores = (n: number): string => `${Math.round(n * 10) / 10}`

/** Whether `step` gets a slot with `taken` held, and if not why. */
function decide(
  taken: Taken,
  base: number,
  fit: SlotFit,
  step: StepSize,
): { grant: true } | { grant: false; why: string; kind: WaitKind } {
  const holders = taken.count
  const max = Math.max(base, fit.max)
  if (holders >= max) return { grant: false, kind: 'slots', why: `all ${max} slots are busy` }
  const cls = stepClassOf(step.name)
  if (cls !== null && (taken.classes.get(cls) ?? 0) > 0)
    return {
      grant: false,
      kind: 'class',
      why: `a step of the host-wide class ${cls} holds a slot: one at a time, whichever repo runs it`,
    }
  if (holders === 0) return { grant: true }
  if (fit.swapGrowing)
    return {
      grant: false,
      kind: 'swap',
      why: 'swap in use is growing: one step at a time until it settles, whatever memory is free',
    }
  const { peakMib } = step
  const { freeMib } = fit
  const known = peakMib !== null && freeMib !== null
  // The base slots are the concurrency the host is sized for: they keep no headroom, only the step's own fit (swap growing
  // is already refused above). The headroom guards the host against the slots beyond the base.
  const room = holders < base ? 0 : fit.headroomMib
  const fits = known && peakMib + fit.growthMib <= freeMib - room
  const memory = (): { grant: false; why: string; kind: WaitKind } => ({
    grant: false,
    kind: 'memory',
    why: `waiting for memory: needs ${gib(peakMib ?? 0)} (${PEAK_SOURCE[step.peakFrom]}), ${gib(Math.max(0, (freeMib ?? 0) - fit.growthMib))} free after ${gib(fit.growthMib)} the running steps still grow${room === 0 ? ', no headroom for a base slot' : `, headroom ${gib(room)}`}`,
  })
  if (holders < base) return !known || fits ? { grant: true } : memory()
  if (!fit.loadOk) {
    const over =
      fit.loadWhy ??
      (fit.load != null && fit.extraLoad !== undefined
        ? `load ${fit.load} is over ${fit.extraLoad}${fit.extraLoadFrom ? ` (${fit.extraLoadFrom})` : ''}`
        : 'load is too high')
    return { grant: false, kind: 'load', why: `${over} for a slot beyond the first ${base}` }
  }
  const held = fit.heldCores ?? 0
  if (fit.cores != null && held > 0 && held + step.cores > fit.cores)
    return {
      grant: false,
      kind: 'cores',
      why: `waiting for cores: needs ${cores(step.cores)}, the ${holders} running steps are learned to take ${cores(held)} of the ${fit.cores} cores`,
    }
  if (peakMib === null)
    return {
      grant: false,
      kind: 'unsized',
      why: `no learned peak for this step yet, so no slot beyond the first ${base}`,
    }
  if (freeMib === null)
    return { grant: false, kind: 'unsized', why: 'no recent free-memory reading, so no slot beyond the base' }
  return fits ? { grant: true } : memory()
}

/**
 * Whether a step may pass a head that was passed for the whole window anyway: the freeze exists so small steps cannot keep
 * the head out for ever, and a step does not keep it out when the head still fits beside it once the holders granted
 * before the passing began have ended (their resident size is then free again). Both sizes must be learned or guessed and
 * the free memory known; otherwise the freeze holds. The holders granted since the passing began are the passers: they stay
 * and are already in the used memory. `headroomMib` is what the head's slot keeps free: none when both fit in the base.
 */
function headFitsBeside(
  head: SlotRow,
  step: SlotRow,
  held: readonly SlotRow[],
  fit: SlotFit,
  headroomMib: number,
): boolean {
  const headMib = fit.peaksByName?.get(head.name) ?? null
  const stepMib = fit.peaksByName?.get(step.name) ?? fit.peakMib
  if (headMib === null || stepMib === null || fit.freeMib === null || head.passedAt === null) return false
  const passedAt = head.passedAt.getTime()
  const before = (row: SlotRow): boolean => row.grantedAt !== null && row.grantedAt.getTime() < passedAt
  const released = held.filter(before).reduce((sum, row) => sum + (row.rssMib ?? 0), 0)
  // what the holders that stay (the passers) will still take on, as the head's own fit counts the growth of every holder
  const staying = held
    .filter((row) => !before(row))
    .reduce((sum, row) => sum + Math.max(0, (fit.heldPeakById?.get(row.id) ?? 0) - (row.rssMib ?? 0)), 0)
  return headMib + stepMib + staying + headroomMib <= fit.freeMib + released
}

/**
 * The reservation of a head that was passed for the whole window: in how many ms its memory is free, counted from the running
 * steps' learned remaining runtime (the learned run less the time they ran). The holders are taken to end in that order, each
 * freeing its resident size, until the head's size, what the holders left still grow by and the headroom fit in the free memory
 * plus what ended. A holder with no learned run reads as ending now, so the reserved start is never later than the true one:
 * a step that ends before it cannot delay the head. A holder that has run past its learned run is still running, so "now" is
 * known to be wrong for it (the head would be reserved a start that never comes and every step behind it would wait, a base
 * slot idle, for as long as the holder runs): it is taken to need as much longer as it has already overrun. Null when the head's size or the free memory is unknown, or when it does
 * not fit even with every holder gone: no step backfills then, and the head keeps the whole line. `base` is the number of
 * base slots: below it the head keeps no headroom.
 */
export function reservedStartMs(
  head: SlotRow,
  held: readonly SlotRow[],
  fit: SlotFit,
  base: number,
  now: Date,
): number | null {
  const headMib = fit.peaksByName?.get(head.name) ?? null
  if (headMib === null || fit.freeMib === null) return null
  const ending = held
    .map((row) => {
      const learned = fit.heldRunMsById?.get(row.id) ?? null
      const ran = now.getTime() - (row.grantedAt?.getTime() ?? now.getTime())
      return {
        row,
        remainingMs: learned === null ? 0 : Math.abs(learned - ran),
        growMib: Math.max(0, (fit.heldPeakById?.get(row.id) ?? 0) - (row.rssMib ?? 0)),
      }
    })
    .sort((a, b) => a.remainingMs - b.remainingMs)
  let released = 0
  let growing = ending.reduce((sum, h) => sum + h.growMib, 0)
  for (let k = 0; k <= ending.length; k++) {
    const staying = ending.length - k
    const room = staying < base ? 0 : fit.headroomMib
    if (headMib + growing + room <= (fit.freeMib ?? 0) + released) return ending[k - 1]?.remainingMs ?? 0
    const gone = ending[k]
    if (!gone) break
    released += gone.row.rssMib ?? 0
    growing -= gone.growMib
  }
  return null
}

/**
 * One call of a caller, which is a request for a slot and a renewal of the one it has: the first call makes it a
 * waiter; a call from a waiter first in line, with a slot free, gives it that slot; a call from a holder renews the
 * lease. Slots go to waiters in the line's order (`lineOrder`). Rows past their lease (holders) or their poll window (waiters)
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
    /** the caller's command is running under this slot: a lapsed lease is taken back whatever the fit says */
    holding?: boolean | undefined
    /** how long a waiter may be passed before its memory is reserved for it */
    passAfterMs?: number | undefined
  },
  now: Date,
): { rows: SlotRow[]; view: SlotView; waited?: Waited } {
  const leaseEnd = new Date(now.getTime() + SLOT_LEASE_MS)
  const kept = rows.filter((row) =>
    row.slot === null
      ? row.seenAt.getTime() >= now.getTime() - WAITER_TTL_MS
      : (row.leasedUntil?.getTime() ?? 0) >= now.getTime(),
  )
  const existing = kept.find((row) => row.id === input.id)
  // A waiter's time since its last call was spent under the reason that call gave it.
  const split = { ...existing?.waitSplit }
  if (existing?.slot === null && existing.whyKind !== null) {
    const spent = Math.min(Math.max(0, now.getTime() - existing.seenAt.getTime()), WAITER_TTL_MS)
    split[existing.whyKind] = (split[existing.whyKind] ?? 0) + spent
  }
  const mine: SlotRow = existing
    ? {
        ...existing,
        waitSplit: split,
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
        passedAt: null,
        passedBy: null,
        whyKind: null,
        waitSplit: {},
        host: null,
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
    host: 'mini',
  })
  if (mine.slot !== null) return { rows: [...others, mine], view: view(mine, 0) }

  const taken = new Set(others.flatMap((row) => (row.slot === null ? [] : [row.slot])))
  // A command already running uses the machine whether or not the lease lapsed (the server was out of reach, the host
  // stalled): it gets a slot back at once, past the limit if need be, so the budget keeps counting it.
  if (input.holding) {
    const free = Array.from({ length: taken.size + 1 }, (_, i) => i + 1).find((n) => !taken.has(n)) ?? taken.size + 1
    const reclaimed: SlotRow = {
      ...mine,
      slot: free,
      leasedUntil: leaseEnd,
      grantedAt: now,
      runMs: input.runMs,
      why: null,
      whyKind: null,
    }
    return { rows: [...others, reclaimed], view: view(reclaimed, 0) }
  }
  const line = lineOrder([...others.filter((row) => row.slot === null), mine], input.fit.runMsByName)
  const ahead = line.findIndex((row) => row.id === input.id)
  const passAfterMs = input.passAfterMs ?? DEFAULT_PASS_AFTER_MS
  const passedNote = (row: SlotRow): string =>
    row.passedAt === null
      ? ''
      : ` (passed by "${row.passedBy ?? '?'}" since ${Math.floor((now.getTime() - row.passedAt.getTime()) / 60_000)} min; after ${Math.round(passAfterMs / 60_000)} min its memory is reserved and only a step that ends before its start passes it)`
  const held = others.filter((row) => row.slot !== null)
  const classes = new Map<string, number>()
  for (const row of held) {
    const cls = stepClassOf(row.name)
    if (cls !== null) classes.set(cls, (classes.get(cls) ?? 0) + 1)
  }
  const takenNow: Taken = { count: taken.size, classes }
  const verdict = decide(takenNow, input.slots, input.fit, {
    name: input.name,
    peakMib: input.fit.peakMib,
    peakFrom: input.fit.peakFrom ?? 'learned',
    cores: input.fit.stepCores ?? DEFAULT_STEP_CORES,
  })
  const wait = (why: string, kind: WaitKind): { rows: SlotRow[]; view: SlotView } => ({
    rows: [...others, { ...mine, why, whyKind: kind }],
    view: view(mine, ahead, why),
  })
  if (!verdict.grant) return wait(verdict.why + passedNote(mine), verdict.kind)
  // The slot goes to the first waiter in line that fits: a waiter ahead that does not fit is passed, unless it has been
  // passed for the whole window (then its memory is reserved: the caller passes it only when it still fits beside the caller,
  // `headFitsBeside`, or the caller ends before the reserved start, `reservedStartMs`), and
  // one that fits takes the slot on its own next call. A waiter
  // whose host-wide class is held never holds the line: the line standing still frees no class.
  const passed: SlotRow[] = []
  for (const waiter of line.slice(0, ahead)) {
    const theirs = decide(takenNow, input.slots, input.fit, {
      name: waiter.name,
      peakMib: input.fit.peaksByName?.get(waiter.name) ?? null,
      peakFrom: input.fit.peakFromByName?.get(waiter.name) ?? 'learned',
      cores: input.fit.coresByName?.get(waiter.name) ?? DEFAULT_STEP_CORES,
    })
    if (theirs.grant) return wait(`waiting for the ${ahead} ahead in line`, 'line')
    if (
      theirs.kind !== 'class' &&
      waiter.passedAt !== null &&
      now.getTime() - waiter.passedAt.getTime() >= passAfterMs &&
      !headFitsBeside(waiter, mine, held, input.fit, takenNow.count + 2 <= input.slots ? 0 : input.fit.headroomMib)
    ) {
      // Backfill: the reservation is the memory the head waits for; the caller fits now (its own verdict) and passes when it is
      // learned to end before that memory is free, so the head's start is not delayed. Any other reason the head waits holds.
      const reservedMs = theirs.kind === 'memory' ? reservedStartMs(waiter, held, input.fit, input.slots, now) : null
      const runMs = input.fit.stepRunMs ?? null
      if (reservedMs === null || runMs === null || runMs > reservedMs)
        return wait(
          `"${waiter.name}" ahead was passed for ${Math.round(passAfterMs / 60_000)} min and its memory is reserved${reservedMs === null ? '' : ` (free in ~${Math.ceil(reservedMs / 60_000)} min`}${reservedMs === null ? '' : runMs === null ? '; this step has no learned run' : `; this step runs ~${Math.ceil(runMs / 60_000)} min`}${reservedMs === null ? '' : ')'}: ${theirs.why}`,
          'line',
        )
    }
    passed.push(waiter)
  }
  const max = Math.max(input.slots, input.fit.max)
  const slot = Array.from({ length: max }, (_, i) => i + 1).find((n) => !taken.has(n))
  if (slot === undefined) return wait(`all ${max} slots are busy`, 'slots')
  const granted: SlotRow = {
    ...mine,
    slot,
    leasedUntil: leaseEnd,
    grantedAt: now,
    runMs: input.runMs,
    why: null,
    whyKind: null,
  }
  const passedIds = new Set(passed.map((row) => row.id))
  const rest = others.map((row) =>
    passedIds.has(row.id) ? { ...row, passedAt: row.passedAt ?? now, passedBy: row.passedBy ?? mine.name } : row,
  )
  const ms = Object.values(split).reduce((sum, v) => sum + v, 0)
  return { rows: [...rest, granted], view: view(granted, 0), ...(existing ? { waited: { ms, split } } : {}) }
}

/**
 * The line in the order slots go out: by the time a waiter asked plus the time its step is learned to run, so a short
 * step passes a long one that asked a little earlier (the mean wait falls), and the passing has its own ageing: a waiter's
 * place is fixed when it asks, so a step asking later passes it only by being shorter by more than the gap, and once the
 * clock is past its place nothing new passes it. A step with no learned run takes the median of the line's learned ones
 * (none learned: the order is the order of asking).
 */
export function lineOrder(rows: readonly SlotRow[], runMsByName?: ReadonlyMap<string, number | null>): SlotRow[] {
  const known = rows
    .map((row) => runMsByName?.get(row.name))
    .filter((ms): ms is number => typeof ms === 'number')
    .sort((a, b) => a - b)
  const median = known.length === 0 ? 0 : (known[Math.floor((known.length - 1) / 2)] ?? 0)
  const place = (row: SlotRow): number => row.requestedAt.getTime() + (runMsByName?.get(row.name) ?? median)
  return [...rows].sort(
    (a, b) => place(a) - place(b) || a.requestedAt.getTime() - b.requestedAt.getTime() || a.id.localeCompare(b.id),
  )
}

/**
 * The host's test line for the lead admission (`TestLine` of `admission.ts`): the live waiters and holders, and the median
 * of how long the waiters have waited so far. A waiter its host-wide class holds back waits for that class, not for a
 * slot, and is left out: a queue of Apple builds behind one is no reason to hold leads back.
 */
export function testLineOf(
  rows: readonly SlotRow[],
  now: Date,
): { waiters: number; holders: number; medianWaitMs: number } {
  const t = now.getTime()
  const mini = miniRowsOf(rows)
  const waits = mini
    .filter((row) => row.slot === null && row.whyKind !== 'class' && row.seenAt.getTime() >= t - WAITER_TTL_MS)
    .map((row) => Math.max(0, t - row.requestedAt.getTime()))
    .sort((a, b) => a - b)
  const holders = mini.filter((row) => row.slot !== null && (row.leasedUntil?.getTime() ?? 0) >= t).length
  const mid = waits.length === 0 ? 0 : (waits[Math.floor((waits.length - 1) / 2)] ?? 0)
  return { waiters: waits.length, holders, medianWaitMs: mid }
}

/** The steps holding a live slot and the callers still asking for one. */
export function slotCounts(rows: readonly SlotRow[], now: Date): { holders: number; waiters: number } {
  const t = now.getTime()
  const mini = miniRowsOf(rows)
  return {
    holders: mini.filter((row) => row.slot !== null && (row.leasedUntil?.getTime() ?? 0) >= t).length,
    waiters: mini.filter((row) => row.slot === null && row.seenAt.getTime() >= t - WAITER_TTL_MS).length,
  }
}

/** The rows of the mini's line: the VPS's holders and the waiters pinned to it load the VPS, not the mini. */
const miniRowsOf = (rows: readonly SlotRow[]): SlotRow[] => rows.filter((row) => row.host !== 'vps')

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
        `${row.host === 'vps' ? 'vps ' : ''}test slot ${row.slot} held by "${row.name}" for ${Math.floor((now.getTime() - (row.grantedAt?.getTime() ?? 0)) / 60_000)} min, limit ${Math.round((row.runMs ?? 0) / 60_000)} min`,
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
