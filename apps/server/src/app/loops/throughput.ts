import type { SignalRequest } from '@software-factory/contract'
import type { Triaged } from '../../domains/intake/model.ts'
import { MAX_SIGNALS_PER_PASS } from '../../domains/loops/budget.ts'
import type { LoopStore } from '../../domains/loops/ports.ts'
import type { PlanningStore } from '../../domains/planning/ports.ts'
import { budgetsOf } from '@software-factory/contract/project'
import { repoTextOf } from '../../domains/planning/sync.ts'
import {
  type Candidate,
  alreadyAtTarget,
  AFTER_DAYS,
  figureOf,
  type FindingRow,
  heldSubjects,
  holdsProject,
  improvementText,
  improvementTitle,
  type IssueFate,
  type ProjectBudgets,
  type ProjectShape,
  type TenantPolicy,
  RANK_DAYS,
  rankCandidates,
  readLedger,
  reopenedFrom,
  subjectKey,
  type WindowFacts,
} from '../../domains/loops/throughput.ts'
import type { Clock } from '../../kernel/clock.ts'
import { key } from '../../kernel/keys.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { IntakeError } from '../intake.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

/** A project the loop works for: its name, the repo text intake files on, and its peak budget (null: the default). */
export interface ThroughputProject {
  project: string
  repo: string
  peakMib: number | null
  /** its `leads` and lane caps; absent: a claim or lane wait does not name them */
  shape?: ProjectShape
}

export interface ThroughputDeps {
  uow: UnitOfWork<{ loops: LoopStore }>
  clock: Clock
  /** the counting epoch: a finding filed before it is not measured, and a ranking window shorter than a day after it files nothing */
  epoch?: Date | null
  /** the tenant class's budget and the repo its findings are filed on (`FACTORY_TENANT_BUDGET_MIB`, `FACTORY_TENANT_PROJECT`) */
  tenants: TenantPolicy
  projects(): Promise<ThroughputProject[]>
  /** the host over a window (`readWindowFacts`); `baseline` adds the 14-day median per Issue */
  facts(
    window: { from: Date; to: Date },
    options: {
      baseline: boolean
      peakBudgetMib: ReadonlyMap<string, number>
      shapes: ReadonlyMap<string, ProjectShape>
    },
  ): Promise<WindowFacts>
  /** how the Issues ended and when they shipped (`readIssueFates`) */
  fates(ids: readonly string[]): Promise<ReadonlyMap<string, IssueFate>>
  /** intake's entry for an agent (`intake.api.file`): its fingerprint rules decide a repeat */
  file(body: SignalRequest): Promise<Result<Triaged, IntakeError>>
}

export interface ThroughputPass {
  /** rows the ledger moved this pass, by status */
  ledger: { id: string; project: string; kpi: string; status: string; before: number; after: number | null }[]
  /** improvements filed this pass */
  filed: { project: string; kpi: string; subject: string; issue: string | null; costMinutes: number }[]
  /** projects with a finding left for the next pass (an improvement already open, or nothing over its threshold) */
  held: string[]
  failed: { key: string; reason: string }[]
  notes: string[]
}

/** Every stored project with its budgets (`budgets:` in project.yaml) and the repo text intake files its signals on. */
export async function projectBudgets(uow: UnitOfWork<{ planning: PlanningStore }>): Promise<ProjectBudgets[]> {
  const stored = await uow.run(async ({ planning }) => ok(await planning.projects()))
  if (!stored.ok) throw new Error(`projects not read: ${stored.error.kind}`)
  return stored.value.map((p) => ({
    project: p.name,
    repo: repoTextOf(p),
    ...budgetsOf(p.project),
    shape: {
      leads: p.project.leads,
      lanes: new Map(Object.entries(p.project.lanes).map(([name, lane]) => [name, lane.leads])),
    },
  }))
}

/** A ranking window the epoch cut shorter than this many days files nothing: a day's cost is not a week's. */
export const MIN_RANK_DAYS = 1

const DAY_MS = 86_400_000
const reasonOf = (error: IntakeError): string => ('detail' in error ? `${error.kind}: ${error.detail}` : error.kind)

/**
 * One daily pass of the throughput loop: the ledger first (a finding whose Issue shipped is marked, one shipped three days ago
 * is measured over those days and moved, flat or worse), then the ranking of the last seven days' costs without a model,
 * and one improvement signal per project that has none open, for its largest cost no open or recent finding already holds.
 * A finding whose after did not move is ranked again and filed with the earlier attempt named. The host is read outside any
 * transaction; a row is written only after intake took the signal.
 */
export async function throughputPass(deps: ThroughputDeps): Promise<Result<ThroughputPass, PortError>> {
  const now = deps.clock.now()
  const pass: ThroughputPass = { ledger: [], filed: [], held: [], failed: [], notes: [] }
  const read = async () => deps.uow.run(async ({ loops }) => ok(await loops.throughputFindings()))
  const stored = await read()
  if (!stored.ok) return stored
  let rows = stored.value

  const projects = await deps.projects()
  const peakBudgetMib = new Map(projects.filter((p) => p.peakMib !== null).map((p) => [p.project, p.peakMib as number]))
  const shapes = new Map(projects.flatMap((p) => (p.shape ? [[p.project, p.shape] as const] : [])))

  // 1. the ledger
  const openIssues = rows.filter((r) => r.status === 'open' && r.issueId !== null).map((r) => r.issueId as string)
  let fates: ReadonlyMap<string, IssueFate> = new Map()
  try {
    fates = await deps.fates(openIssues)
  } catch (error) {
    pass.notes.push(`issue fates not read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const epoch = deps.epoch ?? null
  const changes = await readLedger(
    rows,
    fates,
    now,
    async (row, window) => {
      try {
        return figureOf(await deps.facts(window, { baseline: false, peakBudgetMib, shapes }), row)
      } catch (error) {
        pass.notes.push(`after of ${row.id} not read: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    },
    epoch,
  )
  if (changes.length > 0) {
    const applied = await deps.uow.run(async ({ loops }) => {
      await loops.applyThroughputLedger(changes)
      return ok(undefined)
    })
    if (!applied.ok) return applied
    const again = await read()
    if (!again.ok) return again
    rows = again.value
    for (const change of changes) {
      const row = rows.find((r) => r.id === change.id)
      if (row) {
        pass.ledger.push({
          id: row.id,
          project: row.project,
          kpi: row.kpi,
          status: row.status,
          before: row.before,
          after: row.after,
        })
      }
    }
  }

  // 2. the ranking
  let facts: WindowFacts
  let recent: WindowFacts
  try {
    facts = await deps.facts(
      { from: new Date(now.getTime() - RANK_DAYS * DAY_MS), to: now },
      { baseline: true, peakBudgetMib, shapes },
    )
    recent = await deps.facts(
      { from: new Date(now.getTime() - AFTER_DAYS * DAY_MS), to: now },
      { baseline: false, peakBudgetMib, shapes },
    )
  } catch (error) {
    pass.notes.push(`costs not read: ${error instanceof Error ? error.message : String(error)}`)
    return ok(pass)
  }
  if (facts.days < MIN_RANK_DAYS) {
    pass.notes.push(
      `ranking waits: counting since ${epoch?.toISOString() ?? 'the epoch'}, under ${MIN_RANK_DAYS} day so far`,
    )
    return ok(pass)
  }
  const held = heldSubjects(rows, now)
  const byProject = new Map(projects.map((p) => [p.project, p]))
  // a project with an improvement open is asked for no second one
  pass.held = projects.map((p) => p.project).filter((project) => holdsProject(rows, project))
  const top = new Map<string, Candidate>()
  const ranked = rankCandidates(facts, deps.tenants)
  if (!byProject.has(deps.tenants.project) && ranked.some((c) => c.project === deps.tenants.project)) {
    pass.notes.push(`standing memory not filed: ${deps.tenants.project} is not a followed project`)
  }
  for (const candidate of ranked) {
    if (!byProject.has(candidate.project) || top.has(candidate.project) || pass.held.includes(candidate.project))
      continue
    if (held.has(subjectKey(candidate))) continue
    // a cost the newest days already left behind (fixed, or a burst that ended) is not asked for again
    if (alreadyAtTarget(recent, candidate)) continue
    top.set(candidate.project, candidate)
  }
  const date = now.toISOString().slice(0, 10)
  for (const [project, candidate] of [...top].toSorted(([, a], [, b]) => b.costMinutes - a.costMinutes)) {
    if (pass.filed.length >= MAX_SIGNALS_PER_PASS) break
    const target = byProject.get(project)
    if (!target) continue
    const reopens = reopenedFrom(rows, candidate)
    const id = key('throughput', project, candidate.kpi, candidate.subject, date)
    const filed = await deps.file({
      from: `agent:${project}`,
      kind: 'request',
      title: improvementTitle(candidate).slice(0, 512),
      text: improvementText(candidate, { date, reopens }),
      repo: target.repo,
      probe: false,
    })
    if (!filed.ok) {
      pass.failed.push({ key: id, reason: reasonOf(filed.error).slice(0, 300) })
      continue
    }
    const { outcome, detail } = filed.value
    const stands = outcome === 'filed' || outcome === 'amended' || (outcome === 'dropped' && detail === 'repeat')
    if (!stands) {
      pass.failed.push({ key: id, reason: `${outcome}: ${detail}`.slice(0, 300) })
      continue
    }
    const row: FindingRow = {
      id,
      project,
      kpi: candidate.kpi,
      subject: candidate.subject,
      before: candidate.value,
      target: candidate.target,
      direction: 'down',
      unit: candidate.unit,
      costMinutes: candidate.costMinutes,
      query: candidate.query,
      signalId: filed.value.signal,
      issueId: filed.value.issue,
      filedAt: now,
      shippedAt: null,
      after: null,
      afterAt: null,
      status: 'open',
      reopens: reopens?.id ?? null,
    }
    const recorded = await deps.uow.run(async ({ loops }) => {
      await loops.recordThroughputFinding(row)
      return ok(undefined)
    })
    if (!recorded.ok) return recorded
    rows = [...rows, row]
    pass.filed.push({
      project,
      kpi: candidate.kpi,
      subject: candidate.subject,
      issue: filed.value.issue,
      costMinutes: candidate.costMinutes,
    })
  }
  return ok(pass)
}

export const throughputSummary = (pass: ThroughputPass): string =>
  [
    `ledger moved ${pass.ledger.length}${pass.ledger.length > 0 ? ` (${pass.ledger.map((l) => `${l.project} ${l.kpi} ${l.status}`).join(', ')})` : ''}`,
    `filed ${pass.filed.length}${pass.filed.length > 0 ? ` (${pass.filed.map((f) => `${f.project} ${f.kpi}`).join(', ')})` : ''}`,
    pass.held.length > 0 ? `${pass.held.length} project(s) with an improvement already open` : null,
    pass.failed.length > 0 ? `${pass.failed.length} failed` : null,
    ...pass.notes,
  ]
    .filter(Boolean)
    .join('; ')
