// A finder is a kind of finding a loop files (a probe, a kind of judgment, a friction pattern group). The first
// passes of a loop flood noise: the first friction pass filed 5 Issues of which 4 were noise, the co-change probe 11 of 11.
// The outcomes of a finder's Issues are the evidence: a finder whose Issues are mostly dropped or cancelled stops filing.

export type FindingLoop = 'friction' | 'hygiene' | 'selfwatch'

/** The ten newest decided Issues of the current epoch are judged: old history ages out, a long record does not mute a finder forever. */
export const FINDER_WINDOW = 10
/** Fewer decided Issues prove nothing: an unproven finder is never muted. */
export const MIN_DECIDED = 3
/** Muted when noise / window is strictly above this: exactly half noise is still a finder worth hearing from. */
const NOISE_SHARE = 0.5
/** A muted finder is asked again this long after its last Issue closed. */
export const MUTE_MS = 14 * 86_400_000

export type FinderOutcome = 'done' | 'healed' | 'dropped' | 'cancelled'

/** One Issue a finder filed; `closedAt` and `outcome` are null while it is open. */
export interface FinderIssue {
  issue: string
  filedAt: Date
  closedAt: Date | null
  outcome: FinderOutcome | null
}

/** `open` files freely, `probation` files one Issue at a time after it was muted, `muted` files nothing. */
export type FinderStatus = 'open' | 'probation' | 'muted'

export interface FinderVerdict {
  status: FinderStatus
  /** decided Issues in the judged window */
  decided: number
  noise: number
  /** noise / decided; null with nothing decided */
  share: number | null
  /** Issues of the finder not closed yet */
  open: number
  /** when a muted finder is asked again; null unless the window is over the share */
  mutedUntil: Date | null
}

/** A judgment finding belongs to the finder of its kind (`judgment:stale`); any other key by its first segment (`cochange:a|b` is `cochange`). */
export function finderOf(loop: FindingLoop, key: string): string {
  const parts = key.split(':')
  if (loop === 'hygiene' && parts[0] === 'judgment') return parts.slice(0, 2).join(':')
  return parts[0] ?? key
}

const isNoise = (issue: FinderIssue): boolean => issue.outcome === 'dropped' || issue.outcome === 'cancelled'

const noiseShare = (window: readonly FinderIssue[]): number | null => {
  const judged = window.slice(-FINDER_WINDOW)
  return judged.length === 0 ? null : judged.filter(isNoise).length / judged.length
}

const overShare = (window: readonly FinderIssue[]): boolean => {
  const share = noiseShare(window)
  return share !== null && Math.min(window.length, FINDER_WINDOW) >= MIN_DECIDED && share > NOISE_SHARE
}

const closedMs = (issue: FinderIssue): number => issue.closedAt?.getTime() ?? 0

/**
 * The state of a finder from its Issues. The window restarts when an Issue filed on probation (the whole mute after
 * the last close) closes done: what came before it is forgiven, so a finder that proved itself starts clean.
 */
export function verdictOf(issues: readonly FinderIssue[], now: Date): FinderVerdict {
  const decided = issues
    .filter((i) => i.outcome !== null && i.closedAt !== null)
    .sort((a, b) => closedMs(a) - closedMs(b) || (a.issue < b.issue ? -1 : a.issue > b.issue ? 1 : 0))
  let window: FinderIssue[] = []
  for (const next of decided) {
    const last = window[window.length - 1]
    const probationDone =
      last !== undefined &&
      overShare(window) &&
      next.outcome === 'done' &&
      next.filedAt.getTime() >= closedMs(last) + MUTE_MS
    window = probationDone ? [next] : [...window, next]
  }
  const judged = window.slice(-FINDER_WINDOW)
  const noise = judged.filter(isNoise).length
  const open = issues.filter((i) => i.outcome === null).length
  const base = { decided: judged.length, noise, share: noiseShare(window), open }
  const last = window[window.length - 1]
  if (!overShare(window) || last === undefined) return { ...base, status: 'open', mutedUntil: null }
  const mutedUntil = new Date(closedMs(last) + MUTE_MS)
  return { ...base, status: now.getTime() < mutedUntil.getTime() ? 'muted' : 'probation', mutedUntil }
}

/** A muted finder files nothing; one on probation files a single Issue, and none while another of its Issues is open. */
export function mayFile(verdict: FinderVerdict, filedThisPass: boolean): boolean {
  if (verdict.status === 'open') return true
  if (verdict.status === 'muted') return false
  return verdict.open === 0 && !filedThisPass
}
