import { notBeforeMs, PlanFile, type PlanRow, type PlanRowView } from '@software-factory/contract'
import type { SQL } from 'bun'

/**
 * What the owner does to an Issue, as `issue_events` kinds: a note, a new lead level, a reopen, a stop (`prio` is steering, not a
 * rescue; a resume forks a session and files no Issue event). This mirrors migration 033's `owner_touches` plus `stop`. A `note` or an
 * `answer` the factory itself wrote carries one of `NOT_THE_OWNER` as `payload.who`.
 */
export const OWNER_TOUCH_KINDS = ['note', 'retier', 'reopen', 'stop'] as const
export const NOT_THE_OWNER = ['default', 'closed', 'steward'] as const

const DAY_MS = 86_400_000

export interface RowStatus extends PlanRowView {
  /** the row as written */
  row: PlanRow
  /** the project the row's Issue is filed in: its name and path, when the name is known */
  target: { name: string; repo: string } | null
}

export interface ProjectPlan {
  project: string
  repo: string
  sha: string | null
  /** the stored `plan_error`: the content now on the default branch does not parse */
  error: string | null
  rows: RowStatus[]
}

/** `2026-11-06 09:00 UTC` */
const stamp = (at: Date): string => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`

interface StableReading {
  touch: { issue: number; at: Date } | null
  closed: number
}

async function readStable(sql: SQL, since: Date, now: Date): Promise<StableReading> {
  const [touch]: { issue_id: number; at: Date }[] = await sql`
    SELECT issue_id, at FROM factory.issue_events
    WHERE at > ${since} AND at <= ${now}
      AND (kind IN (SELECT jsonb_array_elements_text(${JSON.stringify(OWNER_TOUCH_KINDS)}::text::jsonb)) AND coalesce(payload->>'who', '') <> 'steward'
           OR kind = 'answer' AND coalesce(payload->>'who', '') NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(NOT_THE_OWNER)}::text::jsonb)))
    ORDER BY at DESC, id DESC LIMIT 1`
  const [closed]: { n: number }[] = await sql`
    SELECT count(*)::int AS n FROM factory.issues WHERE state = 'closed' AND closed_at > ${since} AND closed_at <= ${now}`
  return { touch: touch ? { issue: touch.issue_id, at: touch.at } : null, closed: closed?.n ?? 0 }
}

/** Why `stable_days: n` is unmet now, or `null` when it is met: no owner touch on any Issue and at least one close within `n` days. */
function stableReason(days: number, reading: StableReading): string | null {
  const head = `stable for ${days} days`
  if (reading.touch) {
    const first = new Date(reading.touch.at.getTime() + days * DAY_MS)
    return `${head}: owner touch on Issue ${reading.touch.issue} ${stamp(reading.touch.at)}, first true ${stamp(first)}`
  }
  return reading.closed === 0 ? `${head}: no Issue closed in that time` : null
}

/**
 * Every stored plan with each row's state, derived from the Issues and the clock: `done` (its Issue is closed, whatever the outcome),
 * `open` (it has an Issue that is not closed), `filable` (no Issue yet, every `after` row done, every condition met) or `waiting`
 * with the reason. The row's Issue is the adopted `issue`, else the one with source `plan` and key `<project>:<row key>`. Reads only:
 * the pass files the filable rows, the health lines and `project show` read the rest.
 */
export async function planStatus(sql: SQL, now: Date): Promise<ProjectPlan[]> {
  const projects: { name: string; repo: string; plan: unknown; plan_sha: string | null; plan_error: string | null }[] =
    await sql`
    SELECT name, repo, plan, plan_sha, plan_error FROM factory.projects ORDER BY name`
  const byName = new Map(projects.map((p) => [p.name, p]))
  const withPlan = projects.flatMap((p) => {
    const parsed = p.plan === null ? undefined : PlanFile.safeParse(p.plan)
    return parsed?.success || p.plan_error ? [{ ...p, file: parsed?.success ? parsed.data : undefined }] : []
  })
  if (withPlan.length === 0) return []

  const adopted = withPlan.flatMap(
    (p) => p.file?.rows.flatMap((row) => (row.issue === undefined ? [] : [row.issue])) ?? [],
  )
  const issues: { id: number; state: string; source: string; source_key: string }[] = await sql`
    SELECT id, state, source, source_key FROM factory.issues
    WHERE source = 'plan' OR id IN (SELECT jsonb_array_elements_text(${JSON.stringify(adopted)}::text::jsonb)::int)`
  const planned = new Map<string, { id: number; state: string }>()
  const byId = new Map<number, { id: number; state: string }>()
  for (const issue of issues) {
    byId.set(issue.id, issue)
    if (issue.source === 'plan') planned.set(issue.source_key, issue)
  }

  const stable = new Map<number, StableReading>()
  const out: ProjectPlan[] = []
  for (const project of withPlan) {
    const rows: RowStatus[] = []
    const done = new Set<string>()
    const issueOf = (row: PlanRow) =>
      row.issue === undefined ? planned.get(`${project.name}:${row.key}`) : byId.get(row.issue)
    for (const row of project.file?.rows ?? []) if (issueOf(row)?.state === 'closed') done.add(row.key)

    for (const row of project.file?.rows ?? []) {
      const issue = issueOf(row)
      const target = byName.get(row.repo ?? project.name)
      const view = (state: RowStatus['state'], reason: string | null = null): RowStatus => ({
        key: row.key,
        state,
        issue: issue?.id ?? row.issue ?? null,
        reason,
        row,
        target: target ? { name: target.name, repo: target.repo } : null,
      })
      if (done.has(row.key)) rows.push(view('done'))
      else if (issue) rows.push(view('open'))
      else if (row.issue !== undefined) rows.push(view('waiting', `Issue ${row.issue} does not exist`))
      else {
        const blocker = (row.after ?? []).find((on) => !done.has(on))
        let reason: string | null = blocker === undefined ? null : `after ${blocker}`
        if (reason === null && row.not_before !== undefined && now.getTime() < notBeforeMs(row.not_before)) {
          reason = `not before ${row.not_before}`
        }
        if (reason === null && row.stable_days !== undefined) {
          const days = row.stable_days
          if (!stable.has(days)) stable.set(days, await readStable(sql, new Date(now.getTime() - days * DAY_MS), now))
          reason = stableReason(days, stable.get(days) as StableReading)
        }
        if (reason === null && !target) reason = `unknown repo ${row.repo}`
        rows.push(reason === null ? view('filable') : view('waiting', reason))
      }
    }
    out.push({ project: project.name, repo: project.repo, sha: project.plan_sha, error: project.plan_error, rows })
  }
  return out
}

/** The health lines a plan makes (derived at read, nothing stored): an unparsable `docs/plan.yaml`, and a plan that waits with nothing to do. */
export async function planLines(sql: SQL, now: Date): Promise<string[]> {
  const lines: string[] = []
  for (const plan of await planStatus(sql, now)) {
    if (plan.error) lines.push(`plan.yaml of ${plan.project} does not parse: ${plan.error}`)
    const left = plan.rows.filter((row) => row.state !== 'done')
    if (left.length === 0 || left.some((row) => row.state === 'open' || row.state === 'filable')) continue
    // Rows that only wait for another row are not the cause; name those that wait for something else.
    const roots = left.filter((row) => !row.reason?.startsWith('after '))
    const named = roots.length > 0 ? roots : left
    const shown = named.slice(0, 3).map((row) => `${row.key} (${row.reason})`)
    const more = named.length > 3 ? ` and ${named.length - 3} more` : ''
    lines.push(`plan of ${plan.project}: waits for ${shown.join(', ')}${more}`)
  }
  return lines
}
