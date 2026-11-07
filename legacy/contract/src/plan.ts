import { z } from 'zod'

/** `docs/plan.yaml` is read from the default branch like `project.yaml`; a larger file is a broken plan. */
export const MAX_PLAN_BYTES = 64 * 1024

export const PLAN_VERSION = 1

export const PlanKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'a key like `docs-sweep`: lowercase letters, digits, dashes')

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
    /** becomes the Issue's facts; free-form (`why`, `what`, `change`, `acceptance`) */
    facts: z.record(z.string(), z.unknown()).optional(),
    /** a project name; default: the project whose plan this is */
    repo: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,160}$/, 'a project name')
      .optional(),
    after: z.array(PlanKey).optional(),
    not_before: NotBefore.optional(),
    stable_days: z.number().int().min(1).max(365).optional(),
    /** adopt an Issue filed by hand: the row is done when it closes, and the server files nothing for it */
    issue: z.number().int().min(1).optional(),
  })
  .superRefine((row, ctx) => {
    if (row.issue !== undefined) {
      for (const field of ['after', 'not_before', 'stable_days', 'repo'] as const) {
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
    for (const row of plan.rows) {
      for (const on of row.after ?? []) {
        if (!keys.has(on)) ctx.addIssue({ code: 'custom', message: `row ${row.key}: after names unknown key ${on}` })
        if (on === row.key) ctx.addIssue({ code: 'custom', message: `row ${row.key} waits for itself` })
      }
    }
    const cycle = findCycle(plan.rows)
    if (cycle) ctx.addIssue({ code: 'custom', message: `after forms a cycle: ${cycle.join(' -> ')}` })
  })
export type PlanFile = z.output<typeof PlanFile>

/** The keys of one cycle in the rows' `after` edges, closed (first = last), or `undefined`. */
function findCycle(rows: readonly PlanRow[]): string[] | undefined {
  const after = new Map(rows.map((row) => [row.key, row.after ?? []]))
  const state = new Map<string, 'walking' | 'done'>()
  const walk = (key: string, path: string[]): string[] | undefined => {
    if (state.get(key) === 'done' || !after.has(key)) return undefined
    if (state.get(key) === 'walking') return [...path.slice(path.indexOf(key)), key]
    state.set(key, 'walking')
    for (const on of after.get(key) ?? []) {
      const found = walk(on, [...path, key])
      if (found) return found
    }
    state.set(key, 'done')
    return undefined
  }
  for (const row of rows) {
    const found = walk(row.key, [])
    if (found) return found
  }
  return undefined
}

export const PlanRowState = z.enum(['done', 'open', 'filable', 'waiting'])
export type PlanRowState = z.infer<typeof PlanRowState>

/** One row of a plan as the factory sees it now (derived at read, never stored). */
export const PlanRowView = z.object({
  key: z.string(),
  state: PlanRowState,
  /** the row's Issue, once there is one */
  issue: z.number().int().nullable(),
  /** why a `waiting` row waits */
  reason: z.string().nullable(),
})
export type PlanRowView = z.infer<typeof PlanRowView>

export const PlanView = z.object({ sha: z.string().nullable(), rows: z.array(PlanRowView) })
export type PlanView = z.infer<typeof PlanView>
