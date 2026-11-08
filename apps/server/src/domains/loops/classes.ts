// A finding class is a kind of finding a loop files (a probe, a kind of judgment, a friction pattern group). The first
// passes of a loop flood noise: the first friction pass filed 5 Issues of which 4 were noise, the co-change probe 11 of 11.
// The outcomes of a class's Issues are the evidence: a class whose Issues are mostly dropped or cancelled stops filing.

export type FindingLoop = 'friction' | 'hygiene'

/** The ten newest decided Issues of the current epoch are judged: old history ages out, a long record does not hold a class forever. */
export const CLASS_WINDOW = 10
/** Fewer decided Issues prove nothing: an unproven class is never held. */
export const MIN_DECIDED = 3
/** Held when noise / window is strictly above this: exactly half noise is still a class worth hearing from. */
export const NOISE_SHARE = 0.5
/** A held class is asked again this long after its last Issue closed. */
export const HOLD_MS = 14 * 86_400_000

export type ClassOutcome = 'done' | 'healed' | 'dropped' | 'cancelled'

/** One Issue a class filed; `closedAt` and `outcome` are null while it is open. */
export interface ClassIssue {
  issue: string
  filedAt: Date
  closedAt: Date | null
  outcome: ClassOutcome | null
}

/** `open` files freely, `probation` files one Issue at a time after a hold, `held` files nothing. */
export type ClassStatus = 'open' | 'probation' | 'held'

export interface ClassVerdict {
  status: ClassStatus
  /** decided Issues in the judged window */
  decided: number
  noise: number
  /** noise / decided; null with nothing decided */
  share: number | null
  /** Issues of the class not closed yet */
  open: number
  /** when a held class is asked again; null unless the window is over the share */
  heldUntil: Date | null
}

/** A judgment finding is classed by its kind (`judgment:stale`); any other key by its first segment (`cochange:a|b` is `cochange`). */
export function classOf(loop: FindingLoop, key: string): string {
  const parts = key.split(':')
  if (loop === 'hygiene' && parts[0] === 'judgment') return parts.slice(0, 2).join(':')
  return parts[0] ?? key
}

const isNoise = (issue: ClassIssue): boolean => issue.outcome === 'dropped' || issue.outcome === 'cancelled'

const noiseShare = (window: readonly ClassIssue[]): number | null => {
  const judged = window.slice(-CLASS_WINDOW)
  return judged.length === 0 ? null : judged.filter(isNoise).length / judged.length
}

const overShare = (window: readonly ClassIssue[]): boolean => {
  const share = noiseShare(window)
  return share !== null && Math.min(window.length, CLASS_WINDOW) >= MIN_DECIDED && share > NOISE_SHARE
}

const closedMs = (issue: ClassIssue): number => issue.closedAt?.getTime() ?? 0

/**
 * The state of a class from its Issues. The window restarts when an Issue filed on probation (a hold's whole length after
 * the last close) closes done: what came before it is forgiven, so a class that proved itself starts clean.
 */
export function verdictOf(issues: readonly ClassIssue[], now: Date): ClassVerdict {
  const decided = issues
    .filter((i) => i.outcome !== null && i.closedAt !== null)
    .sort((a, b) => closedMs(a) - closedMs(b) || (a.issue < b.issue ? -1 : a.issue > b.issue ? 1 : 0))
  let window: ClassIssue[] = []
  for (const next of decided) {
    const last = window[window.length - 1]
    const probationDone =
      last !== undefined &&
      overShare(window) &&
      next.outcome === 'done' &&
      next.filedAt.getTime() >= closedMs(last) + HOLD_MS
    window = probationDone ? [next] : [...window, next]
  }
  const judged = window.slice(-CLASS_WINDOW)
  const noise = judged.filter(isNoise).length
  const open = issues.filter((i) => i.outcome === null).length
  const base = { decided: judged.length, noise, share: noiseShare(window), open }
  const last = window[window.length - 1]
  if (!overShare(window) || last === undefined) return { ...base, status: 'open', heldUntil: null }
  const heldUntil = new Date(closedMs(last) + HOLD_MS)
  return { ...base, status: now.getTime() < heldUntil.getTime() ? 'held' : 'probation', heldUntil }
}

/** A held class files nothing; one on probation files a single Issue, and none while another of its Issues is open. */
export function mayFile(verdict: ClassVerdict, filedThisPass: boolean): boolean {
  if (verdict.status === 'open') return true
  if (verdict.status === 'held') return false
  return verdict.open === 0 && !filedThisPass
}
