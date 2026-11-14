/** How many of a step's newest peaks its learned peak is taken from. */
export const LEARNED_RUNS = 8

/**
 * The p80 (nearest rank) of the newest measured peaks, newest first: a step usually peaks near it, and one inflated run
 * (a peak measured while the host thrashed) does not reserve its size for the next eight. Null when none was measured.
 */
export function learnedPeakMib(peaksNewestFirst: readonly (number | null)[]): number | null {
  const peaks = peaksNewestFirst
    .slice(0, LEARNED_RUNS)
    .filter((peak): peak is number => peak !== null)
    .sort((a, b) => a - b)
  return peaks.length === 0 ? null : (peaks[Math.ceil(peaks.length * 0.8) - 1] ?? null)
}

/** The memory the running steps will still take on: what each is learned to peak at, less what it holds now. */
export function growthMib(
  holders: readonly { name: string; rssMib: number | null }[],
  learned: ReadonlyMap<string, number | null>,
): number {
  return holders.reduce((sum, h) => sum + Math.max(0, (learned.get(h.name) ?? 0) - (h.rssMib ?? 0)), 0)
}

/** A host sample older than this says nothing about the memory now. */
export const SAMPLE_MAX_AGE_MS = 5 * 60_000
const MIB_HEADROOM_FLOOR = 2048
const HEADROOM_SHARE = 0.08

/** The memory kept free for the host itself: 2 GiB, or 8 % of RAM when that is more. */
export const headroomMib = (ramMib: number | null): number =>
  Math.max(MIB_HEADROOM_FLOOR, Math.round((ramMib ?? 0) * HEADROOM_SHARE))

/** The memory free by the newest host sample (not older than five minutes) and the machine's RAM; null when either is unknown. */
export function freeMibOf(
  sample: { at: Date; memoryUsedPct: number | null } | null,
  ramMib: number | null,
  now: Date,
): number | null {
  if (!sample || sample.memoryUsedPct === null || ramMib === null) return null
  if (now.getTime() - sample.at.getTime() > SAMPLE_MAX_AGE_MS) return null
  return Math.round(ramMib * (1 - sample.memoryUsedPct / 100))
}

/** The peak a step with nothing learned and nothing like it in its project is sized at: about the p85 of every step peak on 2026-11-14 (p50 0.3 GiB, p80 1.7, p90 2.5). */
export const DEFAULT_PRIOR_MIB = 2048

/**
 * The name a step is learned and stored under. A caller in a linked worktree (`<repo>/.claude/worktrees/<dir>`) may name its step
 * after the worktree directory (`factory-1146-1 unit`): every lead's step would be new to the server, so the directory word is
 * replaced by the project's name (`basalt-ui unit`), the way a repo is always stored as its project name. Any other name stays.
 */
export function stepNameOf(name: string, cwd: string | null | undefined, project: string | null | undefined): string {
  if (!cwd || !project) return name
  const space = name.indexOf(' ')
  const first = space === -1 ? name : name.slice(0, space)
  const parts = cwd.split('/')
  const at = parts.lastIndexOf('worktrees')
  if (at === -1 || parts[at + 1] !== first) return name
  return `${project}${space === -1 ? '' : name.slice(space)}`
}

/** The last word of a step's name: what it runs (`unit`, `make check-fast`'s `check-fast`). */
export const stepKindOf = (name: string): string => name.slice(name.lastIndexOf(' ') + 1)

/**
 * The size an unknown step is given, as the largest learned peak of a step with the same last word in its project, else the
 * project's largest learned peak, else `DEFAULT_PRIOR_MIB`.
 */
export function stepPrior(
  name: string,
  projectPeaks: ReadonlyMap<string, number | null>,
): { mib: number; from: 'kind' | 'project' | 'default' } {
  const kind = stepKindOf(name)
  const known = [...projectPeaks].flatMap(([step, peak]) => (peak === null ? [] : [{ step, peak }]))
  const sameKind = known.filter((k) => stepKindOf(k.step) === kind)
  if (sameKind.length > 0) return { mib: Math.max(...sameKind.map((k) => k.peak)), from: 'kind' }
  if (known.length > 0) return { mib: Math.max(...known.map((k) => k.peak)), from: 'project' }
  return { mib: DEFAULT_PRIOR_MIB, from: 'default' }
}
