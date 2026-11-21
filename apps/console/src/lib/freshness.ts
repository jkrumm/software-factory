/** A poll that is this late is not a poll in flight: the read is stale. */
export const STALE_GRACE_MS = 15_000

/** An update that could not be applied for this long gets a notice with a button. */
export const UPDATE_STUCK_MS = 2 * 60_000

/** One polled read the page holds: when its data arrived and how often it is meant to refresh. */
export interface PolledRead {
  key: readonly unknown[]
  updatedAt: number
  intervalMs: number
}

export interface StaleRead {
  label: string
  ageMs: number
  /** a reading of the header strip, not of the screen on display */
  strip: boolean
}

const STRIP_ROOTS = new Set(['accounts', 'machine', 'host', 'project-digests'])

const LABELS: Record<string, string> = {
  needs: 'Needs you',
  flow: 'Overview',
  'flow-trend': 'Issues over time',
  chain: 'Chain',
  kpis: 'KPIs',
  friction: 'Friction',
  finders: 'Finders',
  'fix-commits': 'Fix commits',
  'capacity-loop': 'Capacity loop',
  throughput: 'Throughput',
  accounts: 'Accounts',
  machine: 'Host load',
  host: 'Host history',
  'project-digests': 'Project counts',
  'project-index': 'Projects',
  'project-page': 'Project',
  'project-plan': 'Project plan',
  'project-hygiene': 'Project hygiene',
  issue: 'Issue',
  decision: 'Decision',
  artifact: 'Artifact',
  errands: 'Errands',
}

const labelOf = (key: readonly unknown[]): string => LABELS[String(key[0])] ?? String(key[0])

/** The reads whose data is older than their poll interval and a grace, oldest first; strip readings are marked so a screen can leave them out. */
export function staleReads(reads: readonly PolledRead[], now: number): StaleRead[] {
  return reads
    .filter((read) => read.updatedAt > 0 && now - read.updatedAt > read.intervalMs + STALE_GRACE_MS)
    .map((read) => ({
      label: labelOf(read.key),
      ageMs: now - read.updatedAt,
      strip: STRIP_ROOTS.has(String(read.key[0])),
    }))
    .sort((a, b) => b.ageMs - a.ageMs)
    .filter((read, at, all) => all.findIndex((other) => other.label === read.label) === at)
}

/** What the strip says of the update: nothing while the bundle is current, `updating` quietly, `stuck` once it has not taken for `UPDATE_STUCK_MS`. */
export type UpdatePhase = 'current' | 'updating' | 'stuck'

export function updatePhase(updatingSince: number | null, now: number): UpdatePhase {
  if (updatingSince === null) return 'current'
  return now - updatingSince >= UPDATE_STUCK_MS ? 'stuck' : 'updating'
}

/** When a build was made, from its id (the base-36 time `vite.config.ts` bakes in); null for an id that is no such time. */
export function buildTime(id: string): number | null {
  const at = Number.parseInt(id, 36)
  return Number.isFinite(at) && at > 1e12 ? at : null
}
