import { createHmac, randomBytes } from 'node:crypto'
import type { SQL } from 'bun'
import * as z from 'zod'
import { FLOW_KINDS } from '@software-factory/contract'
import type { ChainEdge, ChainModel, ChainNode } from '@software-factory/contract'
import { plain } from './words.ts'
import { isWorkRepo, loadOpenProjects, REDACTED_REPO, REDACTED_TITLE } from './work.ts'

const IssueRow = z.object({
  id: z.string(),
  repo: z.string(),
  state: z.string(),
  title: z.string(),
  wait_reason: z.string().nullable(),
  kind: z.string().nullable(),
  since: z.date().nullable(),
})

const kindOf = (kind: string | null | undefined): ChainNode['issueKind'] =>
  FLOW_KINDS.find((known) => known === kind) ?? 'chore'

/** The instant of a `not_before` value, in UTC where it names no offset. Same rule as `notBeforeMs` in the planning domain; read/ may import only types from a domain (scripts/boundaries.ts), so the rule is repeated here. */
function notBeforeMs(value: string): number {
  const hasOffset = /(Z|[+-]\d{2}:\d{2})$/.test(value)
  return Date.parse(value.includes('T') && !hasOffset ? `${value}Z` : value)
}

const EdgeRow = z.object({ issue_id: z.string(), after_issue: z.string(), satisfied_at: z.date().nullable() })
const WaitRow = z.object({ id: z.string(), after: z.array(z.string()) })
const FiledRow = z.object({ project: z.string(), row_key: z.string(), issue_id: z.string() })

/** The parts of a stored plan the chain shows; a plan that does not parse shows no rows. */
const Plan = z.object({
  rows: z.array(
    z.object({
      key: z.string(),
      title: z.string().optional(),
      kind: z.string().optional(),
      repo: z.string().optional(),
      after: z.array(z.string()).optional(),
      not_before: z.string().optional(),
      issue: z.number().int().optional(),
    }),
  ),
})
const PlanProject = z.object({ name: z.string(), plan: z.unknown() })

const rowId = (project: string, key: string): string => `row:${project}:${key}`

/** Keys the opaque id of a hidden row: a reader who guesses a project and a key cannot confirm it. Stable while the server runs. */
const OPAQUE_KEY = randomBytes(32)

/**
 * The chain across projects: the open Issues and the plan rows not yet filed as nodes (a closed blocker appears when an
 * edge names it), the `after` edges with whether the blocker has closed, and per queued node the nodes blocking it now.
 * Read-only SQL.
 */
export async function readChain(
  sql: SQL,
  now: Date,
  options: { /** the read token: a work repo's words go */ redact?: boolean } = {},
): Promise<ChainModel> {
  const openProjects = options.redact ? await loadOpenProjects(sql) : []
  const hidden = (repo: string): boolean => options.redact === true && isWorkRepo(repo, openProjects)
  const repoOf = (repo: string): string => (hidden(repo) ? REDACTED_REPO : repo)
  const titleOf = (repo: string, title: string): string => (hidden(repo) ? REDACTED_TITLE : plain(title, 120))
  const parse = <T extends z.ZodType>(schema: T, rows: unknown[]): z.output<T>[] => rows.map((raw) => schema.parse(raw))
  const openRows: unknown[] = await sql`
    SELECT i.id, i.repo, i.state, i.wait_reason, f.payload->>'title' AS title,
      COALESCE((SELECT k.payload->>'kind' FROM factory.issue_events k WHERE k.issue_id = i.id AND k.kind = 'settled' AND k.result = 'applied' ORDER BY k.version DESC LIMIT 1), f.payload->>'kind') AS kind, COALESCE(s.at, f.at) AS since
    FROM factory.issues i
    JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
    LEFT JOIN LATERAL (
      SELECT x.at FROM factory.issue_events x
      WHERE x.issue_id = i.id AND x.result = 'applied' AND x.to_state IS DISTINCT FROM x.from_state
      ORDER BY x.version DESC LIMIT 1
    ) s ON true
    WHERE i.state <> 'closed' ORDER BY i.id`
  const storedRows: unknown[] = await sql`
    SELECT e.issue_id, e.after_issue, e.satisfied_at
    FROM factory.planning_edges e JOIN factory.issues i ON i.id = e.issue_id AND i.state <> 'closed'`
  const waitRows: unknown[] = await sql`
    SELECT i.id, e.wait->'after' AS after
    FROM factory.issues i
    JOIN LATERAL (
      SELECT x.wait FROM factory.issue_events x
      WHERE x.issue_id = i.id AND x.result = 'applied' ORDER BY x.version DESC LIMIT 1
    ) e ON true
    WHERE i.state = 'waiting' AND i.wait_reason = 'dependency'`
  const filedRows: unknown[] = await sql`SELECT project, row_key, issue_id FROM factory.planning_filed_rows`
  const projectRows: unknown[] = await sql`
    SELECT name, plan FROM factory.planning_projects WHERE plan IS NOT NULL ORDER BY name`
  const open = parse(IssueRow, openRows)
  const stored = parse(EdgeRow, storedRows)
  const waits = parse(WaitRow, waitRows)
  const filed = parse(FiledRow, filedRows)
  const projects = parse(PlanProject, projectRows)

  const issues = new Map(open.map((row) => [row.id, row]))
  const filedIssue = new Map(filed.map((row) => [`${row.project}:${row.row_key}`, row.issue_id]))

  // The edges between Issues: the stored ones and the leads' dependency waits.
  const blockers: { issue: string; after: string; satisfied: boolean }[] = [
    ...stored.map((row) => ({ issue: row.issue_id, after: row.after_issue, satisfied: row.satisfied_at !== null })),
    ...waits.flatMap((wait) => wait.after.map((after) => ({ issue: wait.id, after, satisfied: false }))),
  ]

  // The rows not yet filed, with the node or Issue each `after` names.
  const plans = projects.flatMap((project) => {
    const parsed = Plan.safeParse(project.plan)
    return parsed.success ? parsed.data.rows.map((row) => ({ project: project.name, row })) : []
  })
  const unfiled = plans.filter(
    ({ project, row }) => row.issue === undefined && !filedIssue.has(`${project}:${row.key}`),
  )
  const known = new Set(plans.map(({ project, row }) => `${project}:${row.key}`))
  const resolve = (project: string, ref: string): string | null => {
    const full = ref.includes(':') ? ref : `${project}:${ref}`
    if (!known.has(full)) return null
    const [owner, ...rest] = full.split(':')
    const key = rest.join(':')
    const plan = plans.find((p) => p.project === owner && p.row.key === key)
    if (plan?.row.issue !== undefined) return `issue_${plan.row.issue}`
    return filedIssue.get(full) ?? rowId(owner ?? project, key)
  }
  const rowEdges = unfiled.flatMap(({ project, row }) =>
    (row.after ?? []).flatMap((ref) => {
      const to = resolve(project, ref)
      return to ? [{ from: rowId(project, row.key), to }] : []
    }),
  )

  // A closed blocker is shown when an edge names it.
  const missing = [
    ...new Set(
      [...blockers.map((b) => b.after), ...rowEdges.map((e) => e.to)].filter(
        (id) => id.startsWith('issue_') && !issues.has(id),
      ),
    ),
  ]
  const closedRows: unknown[] =
    missing.length === 0
      ? []
      : await sql`
          SELECT i.id, i.repo, i.state, i.wait_reason, COALESCE(f.payload->>'title', i.id) AS title,
            COALESCE((SELECT k.payload->>'kind' FROM factory.issue_events k WHERE k.issue_id = i.id AND k.kind = 'settled' AND k.result = 'applied' ORDER BY k.version DESC LIMIT 1), f.payload->>'kind') AS kind, COALESCE(s.at, f.at) AS since
          FROM factory.issues i
          LEFT JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
          LEFT JOIN LATERAL (
      SELECT x.at FROM factory.issue_events x
      WHERE x.issue_id = i.id AND x.result = 'applied' AND x.to_state IS DISTINCT FROM x.from_state
      ORDER BY x.version DESC LIMIT 1
    ) s ON true
          WHERE i.id IN ${sql(missing)}`
  const closed = parse(IssueRow, closedRows)
  for (const row of closed) issues.set(row.id, row)

  const isClosed = (id: string): boolean => issues.get(id)?.state === 'closed'
  const edges: ChainEdge[] = [
    ...blockers
      .filter((b) => issues.has(b.after))
      .map((b) => ({ from: b.issue, to: b.after, closed: b.satisfied || isClosed(b.after) })),
    ...rowEdges.map((e) => ({ ...e, closed: isClosed(e.to) })),
  ]
  const unique = [...new Map(edges.map((edge) => [`${edge.from}>${edge.to}`, edge])).values()]

  const usedClosed = new Set(unique.flatMap((edge) => [edge.from, edge.to]))
  const issueNodes = [...issues.values()]
    .filter((row) => row.state !== 'closed' || usedClosed.has(row.id))
    .map((row): ChainNode => ({
      id: row.id,
      kind: 'issue',
      repo: repoOf(row.repo),
      title: titleOf(row.repo, row.title),
      state: row.state,
      issueKind: kindOf(row.kind),
      since: row.since?.toISOString() ?? null,
      waitReason: row.wait_reason,
      notBefore: null,
    }))
  const rowNodes = unfiled.map(({ project, row }): ChainNode => {
    const waiting =
      unique.some((edge) => edge.from === rowId(project, row.key) && !edge.closed) ||
      (row.not_before !== undefined && notBeforeMs(row.not_before) > now.getTime())
    return {
      id: rowId(project, row.key),
      kind: 'row',
      repo: repoOf(row.repo ?? project),
      title: titleOf(row.repo ?? project, row.title ?? row.key),
      state: waiting ? 'waiting' : 'filable',
      issueKind: kindOf(row.kind ?? 'feature'),
      since: null,
      waitReason: null,
      notBefore: row.not_before === undefined ? null : new Date(notBeforeMs(row.not_before)).toISOString(),
    }
  })

  const blocking: Record<string, string[]> = {}
  for (const node of issueNodes) {
    if (node.state !== 'queued') continue
    blocking[node.id] = unique.filter((edge) => edge.from === node.id && !edge.closed).map((edge) => edge.to)
  }
  if (!options.redact) return { at: now.toISOString(), nodes: [...issueNodes, ...rowNodes], edges: unique, blocking }

  // A row's id carries its project's name and its key: for a work repo it becomes an opaque one, everywhere it appears.
  const hiddenRows = new Set(
    unfiled
      .filter(({ project, row }) => hidden(project) || hidden(row.repo ?? project))
      .map(({ project, row }) => rowId(project, row.key)),
  )
  const idOut = (id: string): string =>
    hiddenRows.has(id) ? `row:${createHmac('sha256', OPAQUE_KEY).update(id).digest('hex').slice(0, 12)}` : id
  return {
    at: now.toISOString(),
    nodes: [...issueNodes, ...rowNodes].map((node) => ({
      ...node,
      id: idOut(node.id),
      ...(hiddenRows.has(node.id) ? { repo: REDACTED_REPO, title: REDACTED_TITLE } : {}),
    })),
    edges: unique.map((edge) => ({ ...edge, from: idOut(edge.from), to: idOut(edge.to) })),
    blocking: Object.fromEntries(
      Object.entries(blocking).map(([id, blockers]) => [idOut(id), blockers.map((blocker) => idOut(blocker))]),
    ),
  }
}
