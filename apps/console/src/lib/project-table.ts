import { openOfWork, type ProjectIndexRow, type ProjectMedian } from '@software-factory/contract'
import type { Tone } from '@/components/kit/tone'

/**
 * The pure logic of the Projects table: what each cell says, what it sorts by, the quick filters and the choices a browser
 * remembers. The table itself is `components/project/table.tsx`, the read `GET /v1/projects`.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "45 min", "3.2 h", "2.1 d": a duration of minutes to days, one decimal from an hour. */
export function durationShort(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} min`
  if (ms < DAY) return `${(ms / HOUR).toFixed(1)} h`
  return `${(ms / DAY).toFixed(1)} d`
}

/** "now", "12 min", "3 h", "2 d": an age in a cell, the words without "ago". */
export function ageShort(ms: number): string {
  if (ms < MINUTE) return 'now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h`
  return `${Math.floor(ms / DAY)} d`
}

// -- trend ---------------------------------------------------------------------------------------------------------------

export type TrendDirection = 'down' | 'up' | 'flat'

export interface Trend {
  direction: TrendDirection
  /** a duration is better lower: down is good, up is bad, flat is neutral */
  tone: Tone
  /** "against 4.2 h the 7 days before" */
  words: string
}

/** Within this share of the week before, a median has not moved. */
const FLAT_SHARE = 0.1

/** The last 7 days against the 7 before; null without a median in both. */
export function trendOf(median: ProjectMedian): Trend | null {
  if (median.ms === null || median.beforeMs === null) return null
  const words = `against ${durationShort(median.beforeMs)} the 7 days before`
  const base = Math.max(median.beforeMs, 1)
  const change = (median.ms - median.beforeMs) / base
  if (Math.abs(change) <= FLAT_SHARE) return { direction: 'flat', tone: 'neutral', words }
  return change < 0 ? { direction: 'down', tone: 'good', words } : { direction: 'up', tone: 'bad', words }
}

/** Why a median cell is a dash. */
export const medianEmpty = (median: ProjectMedian): string =>
  median.beforeN > 0 ? 'Nothing in the last 7 days; some in the 7 before' : 'Nothing counted in the last 14 days'

// -- production ----------------------------------------------------------------------------------------------------------

export type Lamp = 'incident' | 'regressed' | 'checking' | 'quiet'

/** The tone of each lamp, decided here and nowhere else: an incident is bad, a regression warn, Checking is the live accent. */
export const LAMP_TONES: Record<Lamp, Tone> = {
  incident: 'bad',
  regressed: 'warn',
  checking: 'accent',
  quiet: 'neutral',
}

export const LAMP_WORDS: Record<Lamp, string> = {
  incident: 'Incident open',
  regressed: 'Regressed in 7 days',
  checking: 'Checking: shipped, its watch is on',
  quiet: 'Quiet',
}

const LAMP_RANK: Record<Lamp, number> = { incident: 3, regressed: 2, checking: 1, quiet: 0 }

export interface Production {
  lamp: Lamp
  /** when what the lamp shows began: the oldest open incident, the newest regression; null for Checking and quiet */
  since: string | null
}

export function productionOf(row: ProjectIndexRow): Production {
  if (row.production.incidents > 0) return { lamp: 'incident', since: row.production.incidentAt }
  if (row.production.regressionAt) return { lamp: 'regressed', since: row.production.regressionAt }
  if (row.counts.work.checking > 0) return { lamp: 'checking', since: null }
  return { lamp: 'quiet', since: null }
}

/** Severity first, then the longest-standing (the earlier start ranks higher): an incident open 3 days sorts above one open an hour. */
export function productionRank(row: ProjectIndexRow): number {
  const { lamp, since } = productionOf(row)
  return LAMP_RANK[lamp] * 1e13 - (since ? Date.parse(since) : 0)
}

// -- the row's figures ---------------------------------------------------------------------------------------------------

export const openOf = (row: ProjectIndexRow): number => openOfWork(row.counts.work)
export const shippedOf = (row: ProjectIndexRow): number => row.shipped.hours.reduce((a, b) => a + b, 0)
/** done of all, 0 to 1; null with no plan */
export const planShare = (row: ProjectIndexRow): number | null =>
  row.plan.total === 0 ? null : row.plan.done / row.plan.total
/** clean of run, 0 to 1; null when the newest pass ran nothing */
export const hygieneShare = (row: ProjectIndexRow): number | null =>
  row.hygiene.run === 0 ? null : row.hygiene.clean / row.hygiene.run

/** A probe not clean, or a finding raised for over this long, is a hygiene gap. */
const STALE_FINDING_MS = 7 * DAY

/** The tone of the hygiene figure: clean is quiet, a gap warns, a finding raised for over 7 days is bad. */
export function hygieneTone(row: ProjectIndexRow, now: number): Tone {
  const oldest = row.hygiene.oldestFindingAt ? now - Date.parse(row.hygiene.oldestFindingAt) : 0
  if (oldest > STALE_FINDING_MS) return 'bad'
  if (row.hygiene.run > row.hygiene.clean) return 'warn'
  return 'neutral'
}

/** The busiest first: running leads, then open Issues, then shipped, then name. The order with no sort chosen. */
export function busiest(a: ProjectIndexRow, b: ProjectIndexRow): number {
  return (
    b.counts.work.running - a.counts.work.running ||
    openOf(b) - openOf(a) ||
    shippedOf(b) - shippedOf(a) ||
    a.name.localeCompare(b.name)
  )
}

// -- filters -------------------------------------------------------------------------------------------------------------

export const QUICK_FILTERS = ['all', 'alarm', 'hygiene', 'moving', 'idle'] as const
export type QuickFilter = (typeof QUICK_FILTERS)[number]

export const QUICK_WORDS: Record<QuickFilter, string> = {
  all: 'All',
  alarm: 'Red',
  hygiene: 'Hygiene gaps',
  moving: 'Moving',
  idle: 'Idle',
}

export const QUICK_HINTS: Record<QuickFilter, string> = {
  all: 'Every project',
  alarm: 'An incident open, or a regression in the last 7 days',
  hygiene: 'A probe of the newest pass not clean, or a finding raised for over 7 days',
  moving: 'Shipped something in the last 7 days',
  idle: 'Nothing open and nothing shipped in 7 days',
}

export function matchesQuick(row: ProjectIndexRow, filter: QuickFilter, now: number): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'alarm': {
      const { lamp } = productionOf(row)
      return lamp === 'incident' || lamp === 'regressed'
    }
    case 'hygiene':
      return hygieneTone(row, now) !== 'neutral'
    case 'moving':
      return shippedOf(row) > 0
    case 'idle':
      return openOf(row) === 0 && shippedOf(row) === 0
  }
}

// -- what a browser remembers --------------------------------------------------------------------------------------------

export const COLUMN_IDS = [
  'name',
  'now',
  'shipped',
  'last',
  'cycle',
  'wait',
  'production',
  'hygiene',
  'plan',
  'leads',
] as const
export type ColumnId = (typeof COLUMN_IDS)[number]

export type Density = 'compact' | 'comfortable'

export interface TablePrefs {
  /** columns hidden; the name is never hidden */
  hidden: ColumnId[]
  sort: { id: ColumnId; desc: boolean }[]
  grouped: boolean
  density: Density
}

export const DEFAULT_PREFS: TablePrefs = { hidden: [], sort: [], grouped: true, density: 'compact' }

const PREFS_KEY = 'factory.projects.table.v1'

const isColumn = (value: unknown): value is ColumnId =>
  typeof value === 'string' && (COLUMN_IDS as readonly string[]).includes(value)

/** The stored choices, each field checked on its own: a field that does not read falls back to its default. */
export function parsePrefs(text: string | null): TablePrefs {
  if (!text) return DEFAULT_PREFS
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return DEFAULT_PREFS
  }
  if (typeof raw !== 'object' || raw === null) return DEFAULT_PREFS
  const value = raw as Record<string, unknown>
  const hidden = Array.isArray(value.hidden) ? value.hidden.filter(isColumn).filter((id) => id !== 'name') : []
  const sort = Array.isArray(value.sort)
    ? value.sort.flatMap((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null) return []
        const { id, desc } = entry as Record<string, unknown>
        return isColumn(id) && typeof desc === 'boolean' ? [{ id, desc }] : []
      })
    : []
  return {
    hidden,
    sort,
    grouped: typeof value.grouped === 'boolean' ? value.grouped : DEFAULT_PREFS.grouped,
    density: value.density === 'comfortable' ? 'comfortable' : 'compact',
  }
}

export function loadPrefs(): TablePrefs {
  try {
    return parsePrefs(window.localStorage.getItem(PREFS_KEY))
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(prefs: TablePrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // a browser that keeps nothing (private mode, a full quota) keeps the choices for the visit only
  }
}

// -- groups --------------------------------------------------------------------------------------------------------------

/** Rows in the server's group order, each group keeping the rows' own order; an empty group is left out. */
export function groupRows<R extends { group: string }>(
  rows: readonly R[],
  order: readonly string[],
): { group: string; rows: R[] }[] {
  const known = [...order, ...rows.map((r) => r.group).filter((g) => !order.includes(g))]
  return [...new Set(known)]
    .map((group) => ({ group, rows: rows.filter((r) => r.group === group) }))
    .filter((g) => g.rows.length > 0)
}
