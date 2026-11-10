import { PLAN_LIMITS } from '@software-factory/contract'
import * as z from 'zod'
import { type IssueId, issueId } from '../../kernel/ids.ts'
import { issuesMessage } from './project.ts'

/** What a row's Issue is; the same words as the Issue's kinds (`app/` checks the two lists agree). */
export const PLAN_KINDS = ['feature', 'bug', 'chore', 'docs', 'incident'] as const
export type PlanKind = (typeof PLAN_KINDS)[number]

/** `docs/plan.yaml` is read from the default branch like `project.yaml`; a larger file is a broken plan. */
export const MAX_PLAN_BYTES = PLAN_LIMITS.maxBytes

export const PLAN_VERSION = 1

export const PlanKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'a key like `docs-sweep`: lowercase letters, digits, dashes')

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,160}$/

/** A row of this file (`docs-sweep`) or of another project's plan (`dotfiles:docs-sweep`). */
export const RowRef = z
  .string()
  .regex(/^(?:[A-Za-z0-9][A-Za-z0-9._~-]{0,160}:)?[a-z0-9][a-z0-9-]*$/, 'a row key, or `<project>:<row key>`')

/** `2026-11-13` or `2026-11-13T09:00:00Z`; a date is midnight UTC. A datetime without an offset is UTC too. */
const NotBefore = z
  .string()
  .refine(
    (value) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value),
    'an ISO date or datetime',
  )
  .refine((value) => !Number.isNaN(notBeforeMs(value)), 'a real date')

/** The instant of a `not_before` value, in UTC where it names no offset. */
export function notBeforeMs(value: string): number {
  const hasOffset = /(Z|[+-]\d{2}:\d{2})$/.test(value)
  return Date.parse(value.includes('T') && !hasOffset ? `${value}Z` : value)
}

export const PlanRow = z
  .strictObject({
    key: PlanKey,
    title: z.string().trim().min(1).max(200).optional(),
    /** what the filed Issue's lead reads: free-form; the conventional keys are `FACTS_KEYS` (packages/contract/src/filing.ts) */
    facts: z.record(z.string(), z.unknown()).optional(),
    /** what the Issue is; default `feature` */
    kind: z.enum(PLAN_KINDS).optional(),
    /** a project name; default: the project whose plan this is */
    repo: z.string().regex(PROJECT_NAME, 'a project name').optional(),
    /** rows that must be done first, in this file or in another project's plan */
    after: z.array(RowRef).optional(),
    not_before: NotBefore.optional(),
    /** retired (NL6, memory is the limit on parallel leads): read so an old file parses, never evaluated */
    stable_days: z.number().int().min(1).max(365).optional(),
    /** adopt an Issue filed by hand: the row is done when it closes, and nothing is filed for it */
    issue: z.number().int().min(1).optional(),
  })
  .superRefine((row, ctx) => {
    if (row.issue !== undefined) {
      for (const field of ['after', 'not_before', 'stable_days', 'repo', 'kind'] as const) {
        if (row[field] !== undefined)
          ctx.addIssue({ code: 'custom', message: `row ${row.key}: an adopted row (issue) has no ${field}` })
      }
      return
    }
    if (row.title === undefined)
      ctx.addIssue({ code: 'custom', message: `row ${row.key}: title is required unless issue is set` })
    if (row.facts === undefined)
      ctx.addIssue({ code: 'custom', message: `row ${row.key}: facts is required unless issue is set` })
  })
export type PlanRow = z.output<typeof PlanRow>

/** The keys of one cycle in a file's own `after` edges, closed (first = last), or `undefined`. */
export function findCycle(edges: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const state = new Map<string, 'walking' | 'done'>()
  const walk = (node: string, path: string[]): string[] | undefined => {
    if (state.get(node) === 'done' || !edges.has(node)) return undefined
    if (state.get(node) === 'walking') return [...path.slice(path.indexOf(node)), node]
    state.set(node, 'walking')
    for (const next of edges.get(node) ?? []) {
      const found = walk(next, [...path, node])
      if (found) return found
    }
    state.set(node, 'done')
    return undefined
  }
  for (const node of edges.keys()) {
    const found = walk(node, [])
    if (found) return found
  }
  return undefined
}

export const PlanFile = z
  .strictObject({
    version: z.literal(PLAN_VERSION),
    rows: z.array(PlanRow).min(1),
  })
  .superRefine((plan, ctx) => {
    const keys = new Set<string>()
    for (const row of plan.rows) {
      if (keys.has(row.key)) ctx.addIssue({ code: 'custom', message: `duplicate key ${row.key}` })
      keys.add(row.key)
    }
    const own = new Map<string, string[]>()
    for (const row of plan.rows) {
      own.set(row.key, [])
      for (const on of row.after ?? []) {
        if (on === row.key) ctx.addIssue({ code: 'custom', message: `row ${row.key} waits for itself` })
        if (!on.includes(':')) {
          if (!keys.has(on)) ctx.addIssue({ code: 'custom', message: `row ${row.key}: after names unknown key ${on}` })
          own.get(row.key)?.push(on)
        }
      }
    }
    const cycle = findCycle(own)
    if (cycle) ctx.addIssue({ code: 'custom', message: `after forms a cycle: ${cycle.join(' -> ')}` })
  })
export type PlanFile = z.output<typeof PlanFile>

export type PlanParse = { ok: true; plan: PlanFile; warnings: string[] } | { ok: false; message: string }

/** A parsed YAML document as a plan. Never throws. */
export function parsePlan(raw: unknown): PlanParse {
  const parsed = PlanFile.safeParse(raw)
  if (!parsed.success) return { ok: false, message: issuesMessage(parsed.error) }
  const warnings = parsed.data.rows
    .filter((row) => row.stable_days !== undefined)
    .map((row) => `row ${row.key}: stable_days is retired and ignored (memory is the limit, not a stable week)`)
  return { ok: true, plan: parsed.data, warnings }
}

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
  now: Date
}

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
    const blocker = (row.after ?? []).map((on) => resolveRef(project, on)).find((on) => !doneRows.has(on))
    let reason: string | null = null
    if (blocker !== undefined) {
      reason = rows.has(blocker) ? `after ${blocker}` : `after ${blocker}: no such row`
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
