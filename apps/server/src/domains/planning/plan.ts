import { PLAN_LIMITS } from '@software-factory/contract'
import { findCycle, notBeforeMs, type PlanFile, type PlanRow } from '@software-factory/contract/plan'
import { type IssueId, issueId } from '../../kernel/ids.ts'

export {
  findCycle,
  notBeforeMs,
  PLAN_KINDS,
  PLAN_VERSION,
  PlanFile,
  PlanKey,
  type PlanKind,
  type PlanParse,
  PlanRow,
  parsePlan,
  RowRef,
} from '@software-factory/contract/plan'

/** `docs/plan.yaml` is read from the default branch like `project.yaml`; a larger file is a broken plan. */
export const MAX_PLAN_BYTES = PLAN_LIMITS.maxBytes

export const ROW_STATES = ['done', 'open', 'filable', 'waiting'] as const
export type RowState = (typeof ROW_STATES)[number]

/** One row as the factory sees it now (derived at read, never stored). */
export interface RowStatus {
  project: string
  key: string
  state: RowState
  /** the row's Issue, once there is one */
  issue: IssueId | null
  /** why a `waiting` row waits */
  reason: string | null
  /** the project the row's Issue is filed in; null when the row names a project nobody knows */
  target: string | null
}

/** A project's plan as stored. */
export interface PlanOf {
  project: string
  plan: PlanFile
}

/** What the statuses are derived from, passed in so the rule stays pure. */
export interface PlanFacts {
  plans: readonly PlanOf[]
  /** the projects the factory knows by name */
  projects: ReadonlySet<string>
  /** the Issue each filed row became: `project:key` → Issue */
  filed: ReadonlyMap<string, IssueId>
  /** the state of every Issue a row names */
  states: ReadonlyMap<IssueId, 'closed' | 'open'>
  /** when each closed Issue a row names closed */
  closedAt: ReadonlyMap<IssueId, Date>
  now: Date
}

const DAY_MS = 86_400_000

/** the end of an `after_days` window that began at `closedMs` */
export const afterDaysEnd = (closedMs: number, days: number): number => closedMs + days * DAY_MS

const refOf = (project: string, key: string): string => `${project}:${key}`

/** `key` or `project:key`, resolved against the plan it is written in. */
const resolveRef = (project: string, ref: string): string => (ref.includes(':') ? ref : refOf(project, ref))

/**
 * Every row of every plan with its state: `done` (its Issue is closed, whatever the outcome: a stopped row releases
 * what waits for it, RS14), `open` (it has an Issue that is not closed), `filable` (no Issue yet, every `after` row
 * done, its time come) or `waiting` with the reason. A row's Issue is the adopted `issue`, else the one filed for it.
 * A cycle across plans (a row waiting, through other projects' rows, for itself) keeps every row in it waiting.
 */
export function rowStatuses(facts: PlanFacts): RowStatus[] {
  const rows = new Map<string, { project: string; row: PlanRow }>()
  for (const { project, plan } of facts.plans)
    for (const row of plan.rows) rows.set(refOf(project, row.key), { project, row })

  const issueOf = (ref: string): IssueId | null => {
    const entry = rows.get(ref)
    if (!entry) return null
    return entry.row.issue === undefined ? (facts.filed.get(ref) ?? null) : issueId(entry.row.issue)
  }
  const doneRows = new Set<string>()
  for (const ref of rows.keys()) {
    const id = issueOf(ref)
    if (id && facts.states.get(id) === 'closed') doneRows.add(ref)
  }

  const edges = new Map<string, string[]>()
  for (const [ref, { project, row }] of rows)
    edges.set(
      ref,
      (row.after ?? []).map((on) => resolveRef(project, on)),
    )
  const cycle = findCycle(edges)
  const inCycle = new Set(cycle)

  /** the latest close among a row's `after` rows; 0 where none is known (an unknown close time never holds a row) */
  const latestClose = (row: PlanRow, project: string): number =>
    Math.max(
      0,
      ...(row.after ?? []).map((on) => {
        const id = issueOf(resolveRef(project, on))
        return id ? (facts.closedAt.get(id)?.getTime() ?? 0) : 0
      }),
    )

  const out: RowStatus[] = []
  for (const [ref, { project, row }] of rows) {
    const id = issueOf(ref)
    const target = row.repo ?? project
    const known = facts.projects.has(target)
    const status = (state: RowState, reason: string | null = null): RowStatus => ({
      project,
      key: row.key,
      state,
      issue: id,
      reason,
      target: known ? target : null,
    })
    if (doneRows.has(ref)) {
      out.push(status('done'))
      continue
    }
    if (id) {
      out.push(facts.states.has(id) ? status('open') : status('waiting', `Issue ${id} does not exist`))
      continue
    }
    if (inCycle.has(ref)) {
      out.push(status('waiting', `cycle: ${(cycle ?? []).join(' -> ')}`))
      continue
    }
    const unmet = (row.after ?? []).map((on) => resolveRef(project, on)).filter((on) => !doneRows.has(on))
    let reason: string | null = null
    if (unmet.length > 0) {
      reason = `after ${unmet.map((on) => (rows.has(on) ? on : `${on} (no such row)`)).join(', ')}`
    } else if (
      row.after_days !== undefined &&
      afterDaysEnd(latestClose(row, project), row.after_days) > facts.now.getTime()
    ) {
      const closed = latestClose(row, project)
      reason = `after_days ${row.after_days}: closed ${new Date(closed).toISOString()}, until ${new Date(afterDaysEnd(closed, row.after_days)).toISOString()}`
    } else if (row.not_before !== undefined && facts.now.getTime() < notBeforeMs(row.not_before)) {
      reason = `not before ${row.not_before}`
    } else if (!known) {
      reason = `unknown project ${target}`
    }
    out.push(reason === null ? status('filable') : status('waiting', reason))
  }
  return out
}

/** The rows a pass files, in plan order. */
export const filable = (statuses: readonly RowStatus[]): RowStatus[] => statuses.filter((s) => s.state === 'filable')

/** `why: …` lines, the Issue's facts rendered as the note its lead reads first. */
export function factsNote(row: PlanRow): string {
  const lines = Object.entries(row.facts ?? {}).map(([name, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return `${name}: ${text}`
  })
  return [`Plan row ${row.key}.`, ...lines].join('\n')
}
