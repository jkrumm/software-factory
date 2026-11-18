/**
 * Disk is admitted by fit, the way memory is (`leadcost.ts`): a repo's worktree (the checkout and its build output, `target/`
 * and `node_modules` included) is measured while its attempt runs, the footprint a new lead is expected to take is learned
 * from the newest attempts, and a lead starts only when the free disk less the headroom holds it. A repo needs no static
 * `leads:` for a disk reason: the figure is measured, and it moves with the repo (docs/decisions.md, NL48).
 */

const GIB = 1024
const PEAKS_KEPT = 10
const PEAKS_NEEDED = 3
/** The disk kept free for the host itself: 10 GiB, or 5 % of the volume when that is more. */
const HEADROOM_FLOOR_MIB = 10 * GIB
const HEADROOM_SHARE = 0.05
/** A worktree's size is measured at most this often per worktree; the factory restarts forget the last time and measure again. */
export const SIZE_EVERY_MS = 10 * 60_000
/** The worktrees measured in one host pass (`du` of a tree with a build output takes seconds): the rest wait for the next minute. */
export const SIZES_PER_PASS = 3
/** A lead admitted this recently has not finished taking its worktree's disk (the checkout and the dependency install are minutes): its learned size is still to come. */
export const DISK_RAMP_MS = 10 * 60_000

/** The disk kept free for the host itself. */
export const diskHeadroomMib = (totalMib: number | null): number =>
  Math.max(HEADROOM_FLOOR_MIB, Math.round((totalMib ?? 0) * HEADROOM_SHARE))

/**
 * What a new lead's worktree is expected to take: the p80 (nearest rank) of the newest ten attempts' largest measured size,
 * newest first as given. A size is a plateau, not a burst: the largest of an attempt is what it holds when it is done, so the
 * upper share is the right one (a lead that does not fit is refused, one that over-fits costs a minute's wait). Null with
 * fewer than three attempts: a guess from one or two is worse than none.
 */
export function learnedWorktreeMib(attemptSizesNewestFirst: readonly number[]): number | null {
  const newest = attemptSizesNewestFirst.slice(0, PEAKS_KEPT)
  if (newest.length < PEAKS_NEEDED) return null
  const sorted = [...newest].sort((a, b) => a - b)
  return sorted[Math.ceil(0.8 * sorted.length) - 1] ?? null
}

/** What a repo's worktree is learned to take against what the volume has free; every figure in MiB. */
export interface DiskFit {
  repo: string
  /** the learned footprint of the candidate's repo; null: fewer than three attempts measured */
  candidateMib: number | null
  /** the attempts measured for the repo */
  attempts: number
  /** free on the volume the worktrees live on; null: unknown */
  freeMib: number | null
  headroomMib: number
  /** the leads that hold a claim; a host that runs none always has room for one */
  running: number
  /** what the young leads are still learned to take on: the learned footprints of the claims younger than `DISK_RAMP_MS` */
  growingMib: number
}

const gib = (mib: number): number => Math.round((mib / GIB) * 10) / 10

/** The refusal of a lead whose worktree would not fit by what its repo's worktrees are learned to take; null: it fits or nothing is known. */
export function diskRefusal(fit: DiskFit): string | null {
  if (fit.candidateMib === null || fit.freeMib === null) return null
  if (fit.running === 0) return null
  if (fit.candidateMib <= fit.freeMib - fit.growingMib - fit.headroomMib) return null
  const growing =
    fit.growingMib > 0 ? `, of which ${gib(fit.growingMib)} GiB is still to come from leads that just started` : ''
  return (
    `disk: a worktree of ${fit.repo} takes ~${gib(fit.candidateMib)} GiB with its build output (p80 of ${fit.attempts} past attempts), ` +
    `the host has ${gib(fit.freeMib)} GiB free${growing}, headroom ${gib(fit.headroomMib)} GiB`
  )
}

/** The size of a tree in MiB from `du -sk` output (`<KiB>\t<path>`); null when it is not a number. */
export function mibOfDu(output: string): number | null {
  const kib = Number(/^\s*(\d+)/.exec(output)?.[1])
  return Number.isFinite(kib) ? Math.round(kib / 1024) : null
}

/** The worktrees due a measurement: the ones not measured within `SIZE_EVERY_MS`, the longest unmeasured first, at most `SIZES_PER_PASS`. */
export function dueWorktrees(
  worktrees: readonly { path: string }[],
  lastMeasuredAt: ReadonlyMap<string, number>,
  now: number,
): string[] {
  return worktrees
    .map((w) => ({ path: w.path, last: lastMeasuredAt.get(w.path) ?? 0 }))
    .filter((w) => now - w.last >= SIZE_EVERY_MS)
    .toSorted((a, b) => a.last - b.last || a.path.localeCompare(b.path))
    .slice(0, SIZES_PER_PASS)
    .map((w) => w.path)
}
