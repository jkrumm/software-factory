import { parse, YAMLParseError } from 'yaml'
import * as z from 'zod'
import { CheckpointName, LaneName } from './lane.ts'
import { PLAN_LIMITS } from './planning.ts'
import { PlanSeat } from './seat.ts'

/**
 * The plan file's schema and its hardened YAML read, shared by the server and the offline `factory plan check`.
 * A subpath export (`@software-factory/contract/plan`), not part of the index: the hook never loads `yaml`.
 */

/** What a row's Issue is; the same words as the Issue's kinds (`app/` checks the two lists agree). */
export const PLAN_KINDS = ['feature', 'bug', 'chore', 'docs', 'incident'] as const
export type PlanKind = (typeof PLAN_KINDS)[number]

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
    /** the tier and effort its lead starts on: `{tier, effort}` or `{role}`; default the table's lead role */
    seat: PlanSeat.optional(),
    /** the resource class its Issue runs in; the target project's `lanes:` caps how many of a lane run at once */
    lane: LaneName.optional(),
    /** the queue priority its Issue is filed with, as `factory issue prio` sets it: higher runs first among the queued; default 0 */
    prio: z.number().int().min(-1000).max(1000).optional(),
    /** `spec`: the row's lead owes a one-page Spec before it builds, and the ship is refused without one */
    checkpoint: CheckpointName.optional(),
    /** a project name; default: the project whose plan this is */
    repo: z.string().regex(PROJECT_NAME, 'a project name').optional(),
    /** rows that must be done first, in this file or in another project's plan */
    after: z.array(RowRef).optional(),
    not_before: NotBefore.optional(),
    /** whole days the row also waits after the latest close of its `after` rows; needs `after` */
    after_days: z.number().int().min(1).max(365).optional(),
    /** retired (NL6, memory is the limit on parallel leads): read so an old file parses, never evaluated */
    stable_days: z.number().int().min(1).max(365).optional(),
    /** adopt an Issue filed by hand: the row is done when it closes, and nothing is filed for it */
    issue: z.number().int().min(1).optional(),
  })
  // These issues carry the row's path (`rows.<i>`): a nested refinement inherits its element's position.
  .superRefine((row, ctx) => {
    if (row.issue !== undefined) {
      for (const field of [
        'after',
        'not_before',
        'after_days',
        'stable_days',
        'repo',
        'kind',
        'seat',
        'lane',
        'prio',
        'checkpoint',
      ] as const) {
        if (row[field] !== undefined)
          ctx.addIssue({ code: 'custom', message: `row ${row.key}: an adopted row (issue) has no ${field}` })
      }
      return
    }
    if (row.title === undefined)
      ctx.addIssue({ code: 'custom', message: `row ${row.key}: title is required unless issue is set` })
    if (row.facts === undefined)
      ctx.addIssue({ code: 'custom', message: `row ${row.key}: facts is required unless issue is set` })
    const afterCount = row.after?.length ?? 0
    if (row.after_days !== undefined && afterCount === 0)
      ctx.addIssue({
        code: 'custom',
        message: `row ${row.key}: after_days counts from its after rows, so it needs after`,
      })
    if (afterCount > PLAN_LIMITS.maxAfter)
      ctx.addIssue({
        code: 'custom',
        message: `row ${row.key}: ${afterCount} after keys, at most ${PLAN_LIMITS.maxAfter} (issue new refuses more); remove edges already implied through other rows (a transitive reduction)`,
      })
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
    plan.rows.forEach((row, i) => {
      if (keys.has(row.key))
        ctx.addIssue({ code: 'custom', message: `duplicate key ${row.key}`, path: ['rows', i, 'key'] })
      keys.add(row.key)
    })
    const own = new Map<string, string[]>()
    plan.rows.forEach((row, i) => {
      own.set(row.key, [])
      ;(row.after ?? []).forEach((on, j) => {
        const path = ['rows', i, 'after', j]
        if (on === row.key) ctx.addIssue({ code: 'custom', message: `row ${row.key} waits for itself`, path })
        if (on.includes(':')) return
        if (!keys.has(on))
          ctx.addIssue({ code: 'custom', message: `row ${row.key}: after names unknown key ${on}`, path })
        own.get(row.key)?.push(on)
      })
    })
    const cycle = findCycle(own)
    if (!cycle) return
    const first = plan.rows.findIndex((row) => row.key === cycle[0])
    ctx.addIssue({
      code: 'custom',
      message: `after forms a cycle: ${cycle.join(' -> ')}`,
      path: ['rows', Math.max(first, 0), 'after'],
    })
  })
export type PlanFile = z.output<typeof PlanFile>

export type PlanParse = { ok: true; plan: PlanFile; warnings: string[] } | { ok: false; message: string }

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

/** A zod error as one line: every issue with its path, clipped. */
export const issuesMessage = (error: z.ZodError): string =>
  clip(
    error.issues.map((issue) => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; '),
    600,
  )

/**
 * A parsed YAML document as a plan. Never throws. `lanes` are the lanes the plan's project declares: a row naming
 * another lane is a warning (the lane is then unlimited within `leads`), never a broken plan; `null` means the
 * project's lanes are unknown (no `project.yaml` at hand), so that warning is skipped. A row aimed at another
 * project (`repo`) is not checked here: this parse does not know that project's lanes.
 */
export function parsePlan(raw: unknown, lanes: readonly string[] | null = []): PlanParse {
  const parsed = PlanFile.safeParse(raw)
  if (!parsed.success) return { ok: false, message: issuesMessage(parsed.error) }
  const retired = parsed.data.rows
    .filter((row) => row.stable_days !== undefined)
    .map((row) => `row ${row.key}: stable_days is retired and ignored (memory is the limit, not a stable week)`)
  const unknown =
    lanes === null
      ? []
      : parsed.data.rows
          .filter((row) => row.lane !== undefined && row.repo === undefined && !lanes.includes(row.lane))
          .map(
            (row) =>
              `row ${row.key}: lane ${row.lane} is not declared in project.yaml lanes (${lanes.length > 0 ? lanes.join(', ') : 'none declared'}): it is unlimited within leads`,
          )
  return { ok: true, plan: parsed.data, warnings: [...retired, ...unknown] }
}

/** The options of the hardened YAML read: YAML 1.2 core, no merge keys, duplicate keys refused, few aliases. */
export const YAML_OPTIONS = {
  version: '1.2',
  schema: 'core',
  merge: false,
  uniqueKeys: true,
  maxAliasCount: PLAN_LIMITS.maxAliases,
} as const

export const firstLine = (message: string): string => {
  const line =
    message
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? message
  return line.length > 300 ? `${line.slice(0, 300)}…` : line
}

/**
 * The hardened YAML read of the project and plan files: YAML 1.2 core, one document, no merge keys, duplicate keys
 * refused, at most 100 aliases. Whatever is wrong comes back as one message with a position where the parser has one.
 */
export function parseYamlText(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    const value: unknown = parse(text, { ...YAML_OPTIONS, logLevel: 'error' })
    return { ok: true, value }
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const at = error.linePos?.[0]
      return {
        ok: false,
        message: `${error.code}${at ? ` at line ${at.line}, column ${at.col}` : ''}: ${firstLine(error.message)}`,
      }
    }
    return { ok: false, message: `YAML: ${firstLine(error instanceof Error ? error.message : String(error))}` }
  }
}
