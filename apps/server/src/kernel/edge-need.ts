// What the edges the factory added came to, and the rule that stops a kind of edge. Pure; the sweep and the queue loop (`domains/planning`)
// and the capacity read (`read/`) share it.

/**
 * Paths every Issue of a repo touches without that meaning the two work on the same thing: the plan's append-only
 * aggregator and the lockfiles. They are left out when two Issues' files are compared.
 */
export const SHARED_PATHS: readonly string[] = ['docs/plan.yaml', 'bun.lock', 'bun.lockb', 'package-lock.json']

/**
 * How many commits and paths a ship's evidence keeps (`CommitsEvidence`). Evidence with this many paths was cut: the files
 * of that Issue are not all known, so two Issues are never compared on it.
 */
export const EVIDENCE_SAMPLE_CAP = 100

/** The waits of an Issue that need the owner: a Decision, a Spec or Concept verdict, an Errand. */
export const OWNER_WAITS: ReadonlySet<string> = new Set(['decision', 'review', 'errand'])

/** The paths that say something about what an Issue works on. */
export const meaningfulPaths = (paths: readonly string[]): string[] => paths.filter((p) => !SHARED_PATHS.includes(p))

/** Whether two Issues' paths share one. */
export const sharesPath = (a: readonly string[], b: readonly string[]): boolean => {
  const mine = new Set(meaningfulPaths(a))
  return meaningfulPaths(b).some((path) => mine.has(path))
}

/** What the edges of one source (`triage`, `queue`) came to over a window. */
export interface EdgeNeed {
  source: string
  /** edges the factory added in the window, removed ones included */
  added: number
  /** both Issues shipped, and they touched a file in common: the order was needed */
  needed: number
  /** both Issues shipped and touched no file in common */
  notNeeded: number
  /** an edge whose Issues did not both ship (yet): nothing says either way */
  unknown: number
  /** of `added`, the edges the loop took back */
  removed: number
}

/** The days of added edges the loops judge a source by. */
export const EDGE_NEED_DAYS = 14

/** The measured edges of a source must reach this before the rule judges the kind. */
export const EDGE_STOP_MIN = 10
/** The share of measured edges that were not needed above which the kind is no longer added. */
const EDGE_STOP_SHARE = 0.6

/** The share of the measured edges (both Issues shipped) that were not needed; null when none was measured. */
export const notNeededShare = (need: Pick<EdgeNeed, 'needed' | 'notNeeded'>): number | null => {
  const measured = need.needed + need.notNeeded
  return measured === 0 ? null : need.notNeeded / measured
}

/** Whether the factory stops adding this source's edges: enough were measured and most of them were not needed. */
export function stopsEdges(need: EdgeNeed | undefined): boolean {
  if (!need) return false
  const share = notNeededShare(need)
  return need.needed + need.notNeeded >= EDGE_STOP_MIN && share !== null && share > EDGE_STOP_SHARE
}

/** Why a source's edges are not added, in the words the queue loop records. */
export const stopReason = (need: EdgeNeed): string =>
  `${need.source} edges are mostly not needed (${need.notNeeded} of ${need.needed + need.notNeeded} measured edges touched no common file)`
