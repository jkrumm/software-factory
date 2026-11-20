import type { ResumeRules } from '../../domains/leads/apierror.ts'
import type { SignalRequest } from '@software-factory/contract'
import type { LoopFinding, Triaged } from '../../domains/intake/model.ts'
import type { CapacityStore } from '../../domains/capacity/ports.ts'
import {
  type MemoryCeilings,
  overLoad,
  overMemory,
  SUSTAINED_LOAD_SAMPLES,
  SUSTAINED_SPAN_MS,
} from '../../domains/capacity/host.ts'
import type { AimMode } from '../../domains/capacity/slot-aim.ts'
import { slotLines } from '../../domains/capacity/slots.ts'
import type { CiRuns, LoopReads, LoopStore, MigrationFiles, OverloadHost } from '../../domains/loops/ports.ts'
import {
  type AdmissionRules,
  gatesPassedFindings,
  loadOverCeilingFindings,
  OVERLOAD_KINDS,
  overloadEvidence,
  routesSlowFindings,
  slotLineFindings,
} from '../../domains/loops/overload.ts'
import { MAX_SIGNALS_PER_PASS } from '../../domains/loops/budget.ts'
import { DEFAULT_STEWARD_RULES, idleClockStart } from '../../domains/loops/stall.ts'
import {
  ciFindings,
  heartbeatFindings,
  idleFindings,
  inertRegressionFindings,
  migrationFindings,
  planSelfwatch,
  processGrowthFindings,
  processStormFindings,
  signalText,
  swapGrowthFindings,
  GROWTH_WINDOW_MS,
  hostSampleIsFresh,
  SWAP_RISE_MINUTES,
  waitFindings,
} from '../../domains/loops/selfwatch.ts'
import {
  type Finding,
  type HeartbeatFact,
  type IdleLead,
  type RegressionFact,
  type RouteLatency,
  type SelfwatchChange,
  type SelfwatchRow,
  subjectKeyOf,
} from '../../domains/loops/selfwatch-model.ts'
import { type BudgetFact, budgetFindings } from '../../domains/loops/throughput.ts'
import { leadKey } from '../../domains/leads/names.ts'
import type { LeadStore } from '../../domains/leads/ports.ts'
import { isBuiltinInert } from '../../domains/quality/evidence.ts'
import type { QualityStore } from '../../domains/quality/store.ts'
import { replay } from '../../domains/work/machine.ts'
import type { WorkStore } from '../../domains/work/ports.ts'
import type { Clock } from '../../kernel/clock.ts'
import { issueNumber } from '../../kernel/ids.ts'
import { key } from '../../kernel/keys.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { IntakeError } from '../intake.ts'
import type { UnitOfWork } from '../unit-of-work.ts'
import { countLiveWork, type LiveWorkDeps, loadIdle } from './steward.ts'

export type SelfwatchStores = {
  work: WorkStore
  leads: LeadStore
  quality: QualityStore
  loops: LoopStore
  loopReads: LoopReads
  capacity: CapacityStore
}

export interface SelfwatchDeps {
  uow: UnitOfWork<SelfwatchStores>
  clock: Clock
  /** the API-error path's resume rules: the steward's, so the two agree on when a lead in an incident is quiet */
  resume?: ResumeRules
  /** the one repo watched, as intake and the Issues know it */
  repo: string
  /** the branch whose CI is read; null is the repo's default branch */
  branch: string | null
  /** a wait is overdue this long after its exit */
  graceMs: number
  /** the steward's threshold for a quiet lead */
  idleLeadMs: number
  /** the same for a lead whose last turn ended with background work in flight */
  idleBackgroundMs: number
  ci: CiRuns
  /** the lead's live work, as the steward counts it (`countLiveWork`) */
  slots: LiveWorkDeps['slots']
  ciLive: LiveWorkDeps['ciLive']
  migrations: MigrationFiles
  /** migration numbers two applied files share (`SHARED_NUMBERS`) */
  sharedNumbers: ReadonlySet<string>
  /** the host's process count above which a storm is filed (`DEFAULT_PROCESS_CAP` until the capacity layer has its own) */
  processCap: number
  /** every project's budgets against its last day of runs; unset (a host with no step costs) judges none */
  budgets?: (now: Date) => Promise<BudgetFact[]>
  /** the memory ceilings admission holds (`gates_passed` reads a lead admitted past them) */
  memoryCeilings: MemoryCeilings
  /** `FACTORY_SLOT_AIM`: only under `on` is the aim's target the base the slot rule grants against (`slot_line`'s `base_empty`) */
  slotAim: AimMode
  /** this process's pid: the server in the evidence's priority line */
  serverPid: number
  /** the server's own routes over the last five minutes, timed in the process; absent, `routes_slow` is not judged */
  routes?: () => RouteLatency
  /** the process list and `deploys.log` for the evidence block; absent, a capacity signal carries none */
  overload?: OverloadHost
  /** `GET /health`'s heartbeat, as `healthOf` computes it */
  heartbeat(): Promise<HeartbeatFact>
  /** intake's entry for a loop (`intake.api.file` with the finding): the finding's key decides a repeat, never its words */
  file(body: SignalRequest, finding: LoopFinding): Promise<Result<Triaged, IntakeError>>
}

export interface SelfwatchPass {
  /** conditions seen this pass */
  seen: number
  filed: { key: string; title: string; why: string }[]
  /** due to be filed, left for the next tick by the cap */
  deferred: number
  cleared: number
  failed: { key: string; reason: string }[]
  /** sources not read this pass, each with why */
  notes: string[]
}

/** Open Issues a pass looks at for a quiet lead or a regression. */
const ISSUE_LIMIT = 100

/** The host and slot minutes the capacity conditions read: the longest of them needs fifteen, and a few more are a margin. */
const OVERLOAD_LOOKBACK_MS = 20 * 60_000
/** The newest host sample the evidence block quotes is looked for this far back. */
const EVIDENCE_HOST_MS = 10 * 60_000
/** The lines of `deploys.log` the evidence carries. */
const DEPLOY_LINES = 6

/**
 * The evidence block of a capacity incident: the slot lines with their reasons, the queue by reason, the host's memory,
 * compressor and swap, the busiest processes with their scheduling priority, the priority of the server, the door and Postgres
 * against a lead's, and the last deploy lines. Read once for a pass, and only when a capacity signal is about to be filed:
 * the database reads in one transaction, the process list and the log outside it.
 */
async function overloadLines(deps: SelfwatchDeps & { overload: OverloadHost }, now: Date): Promise<string[]> {
  const stored = await deps.uow.run(async ({ capacity, loopReads }) =>
    ok({
      slots: slotLines(await capacity.slots(), now),
      queue: await loopReads.queueReasons(),
      host: (await loopReads.capacityMinutes(new Date(now.getTime() - EVIDENCE_HOST_MS))).at(-1) ?? null,
      cpu: await loopReads.classCpu(new Date(now.getTime() - EVIDENCE_HOST_MS)),
    }),
  )
  const [ps, deployLines] = await Promise.all([deps.overload.processes(), deps.overload.deployLines(DEPLOY_LINES)])
  const lines = overloadEvidence({
    now,
    slotLines: stored.ok ? stored.value.slots : [],
    queue: stored.ok ? stored.value.queue : [],
    cpu: stored.ok ? stored.value.cpu : null,
    host: stored.ok ? stored.value.host : null,
    ps: ps.ok ? { output: ps.value } : { failure: ps.error.detail },
    serverPid: deps.serverPid,
    deployLines,
  })
  return stored.ok
    ? lines
    : [...lines, `The database was not read for the slot lines, the queue and the host: ${stored.error.detail}`]
}

const reasonOf = (error: IntakeError): string => ('detail' in error ? `${error.kind}: ${error.detail}` : error.kind)

type Out<T> = Promise<Result<T, PortError>>

async function idleLeads(deps: SelfwatchDeps): Out<IdleLead[]> {
  const working = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.working(ISSUE_LIMIT)))
  if (!working.ok) return working
  const found: IdleLead[] = []
  for (const id of working.value) {
    const loaded = await loadIdle(deps, id)
    if (!loaded.ok) return loaded
    const idle = loaded.value
    if (!idle || idle.facts.repo !== deps.repo) continue
    await countLiveWork({ ...deps, rules: { idleLeadMs: deps.idleLeadMs } }, idle)
    found.push({
      issue: id,
      title: idle.facts.title,
      lead: leadKey(id, idle.facts.attempt),
      // the steward's own idle clock: a verdict's grace and a revision still owed are waits it honours
      idleSince: idleClockStart(idle.idle, DEFAULT_STEWARD_RULES),
      background: idle.idle.background,
    })
  }
  return ok(found)
}

/** The Issues of the repo waiting on a regression, with the commits evidence their attempt's ship stored. */
async function regressions(deps: SelfwatchDeps): Out<RegressionFact[]> {
  return deps.uow.run(async ({ work, loopReads, quality }) => {
    const found: RegressionFact[] = []
    for (const id of await loopReads.stalled(ISSUE_LIMIT)) {
      const history = await work.history(id)
      if (!history) continue
      const issue = replay(id, history)
      const { wait } = issue
      if (issue.repo !== deps.repo || issue.state !== 'waiting' || wait?.reason !== 'regressed') continue
      const shipped = (await quality.lastShip(id, issue.attempt))?.commits
      found.push({
        issue: id,
        title: issue.title,
        detail: 'detail' in wait ? wait.detail : '',
        ship: shipped ? { commits: shipped.commits, paths: shipped.paths, deploys: shipped.deploys } : null,
      })
    }
    return ok(found)
  })
}

interface Gathered {
  findings: Finding[]
  /** kinds that were not read: their open rows are neither touched nor cleared */
  unread: Set<string>
  notes: string[]
}

/** Every source read, each its own way (a port outside any transaction, SQL inside one); a source that fails is named, never the whole pass. */
async function gather(deps: SelfwatchDeps, now: Date): Out<Gathered> {
  const gathered: Gathered = { findings: [], unread: new Set(), notes: [] }

  const ci = await deps.ci.latest(deps.repo, deps.branch)
  if (ci.ok) gathered.findings.push(...ciFindings(ci.value.runs, ci.value.branch))
  else {
    gathered.unread.add('ci_red')
    gathered.notes.push(`ci not read: ${ci.error.detail}`)
  }

  const open = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.openIssueIds(deps.repo)))
  if (!open.ok) return open
  const files = await deps.migrations.read(deps.repo, { openIssues: open.value.map(issueNumber) })
  if (files.ok) gathered.findings.push(...migrationFindings(files.value, deps.sharedNumbers))
  else {
    gathered.unread.add('migration_clash')
    gathered.notes.push(`migrations not read: ${files.error.detail}`)
  }

  const waits = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.openWaits(deps.repo)))
  if (!waits.ok) return waits
  gathered.findings.push(...waitFindings(waits.value, now, deps.graceMs))

  const idle = await idleLeads(deps)
  if (!idle.ok) return idle
  gathered.findings.push(
    ...idleFindings(idle.value, now, { idleLeadMs: deps.idleLeadMs, idleBackgroundMs: deps.idleBackgroundMs }),
  )

  const regressed = await regressions(deps)
  if (!regressed.ok) return regressed
  gathered.findings.push(...inertRegressionFindings(regressed.value, isBuiltinInert))

  gathered.findings.push(...heartbeatFindings(await deps.heartbeat(), now))

  // the host's own samples: the hour of notable processes, and the minutes the swap and process-count rules read
  const host = await deps.uow.run(async ({ loopReads }) =>
    ok({
      processes: await loopReads.processMinutes(new Date(now.getTime() - GROWTH_WINDOW_MS)),
      minutes: await loopReads.hostMinutes(new Date(now.getTime() - (SWAP_RISE_MINUTES + 5) * 60_000)),
    }),
  )
  if (!host.ok) return host
  gathered.findings.push(
    ...processGrowthFindings(host.value.processes, now),
    ...swapGrowthFindings(host.value.minutes, now),
    ...processStormFindings(host.value.minutes, deps.processCap, now),
  )
  // a host loop that stopped (a stall, a restart) says nothing about a process, the swap or the count: their open rows stay
  if (!hostSampleIsFresh(host.value.minutes, now)) {
    gathered.unread.add('process_growth').add('swap_growth').add('process_storm')
    gathered.notes.push('host samples not fresh: process growth, swap and process count not judged')
  }

  // the factory's own capacity: the host minutes with their capacity facts, the slot minutes and the server's own routes
  const capacity = await deps.uow.run(async ({ loopReads }) =>
    ok({
      minutes: await loopReads.capacityMinutes(new Date(now.getTime() - OVERLOAD_LOOKBACK_MS)),
      slots: await loopReads.slotMinutes(new Date(now.getTime() - OVERLOAD_LOOKBACK_MS)),
      admissions: await loopReads.admissions(new Date(now.getTime() - OVERLOAD_LOOKBACK_MS)),
    }),
  )
  if (!capacity.ok) return capacity
  // the comparisons admission itself makes (`domains/capacity/host.ts`), so a changed rule moves these conditions with it
  const rules: AdmissionRules = {
    overLoad,
    sustainedLoad: { samples: SUSTAINED_LOAD_SAMPLES, spanMs: SUSTAINED_SPAN_MS },
    overMemory: (reading) => overMemory(reading, deps.memoryCeilings),
  }
  gathered.findings.push(
    ...loadOverCeilingFindings(capacity.value.minutes, rules, now),
    ...gatesPassedFindings(capacity.value.minutes, capacity.value.admissions, rules, now),
    ...slotLineFindings(capacity.value.slots, now, deps.slotAim === 'on'),
  )
  if (!hostSampleIsFresh(capacity.value.minutes, now)) {
    gathered.unread.add('load_over_ceiling').add('gates_passed')
    gathered.notes.push('host samples not fresh: load over the ceiling and gates passed not judged')
  }
  if (!hostSampleIsFresh(capacity.value.slots, now)) {
    gathered.unread.add('slot_line')
    gathered.notes.push(
      'slot minutes not fresh (the slot aim is off, or the host loop stopped): the slot line not judged',
    )
  }
  if (deps.routes) gathered.findings.push(...routesSlowFindings(deps.routes(), now))
  else gathered.unread.add('routes_slow')
  if (deps.budgets) {
    try {
      gathered.findings.push(...budgetFindings(await deps.budgets(now)))
    } catch (error) {
      gathered.unread.add('budget_breach')
      gathered.notes.push(`budgets not read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return ok(gathered)
}

/**
 * One tick of the self-watch loop: fourteen deterministic conditions (CI, migrations, waits, leads, regressions, the heartbeat, the host process growth, swap and process count, a project `budgets:` breached over the last day, and the factory own capacity: load over the ceiling, the slot line, gates passed, slow routes), filed through intake as signals on
 * the watched repo. A subject is filed once; while it stays open and its evidence is the same nothing is filed, a changed
 * evidence is filed again under the same key (intake amends the open Issue), and a subject that no longer holds is
 * cleared. At most `MAX_SIGNALS_PER_PASS` a pass, the rest on the next. A row is written only after intake took the signal, so a
 * failed filing is tried again; a crash between the two replays safely, since intake's finding key turns a repeat into a note.
 */
export async function selfwatchPass(deps: SelfwatchDeps): Promise<Result<SelfwatchPass, PortError>> {
  const now = deps.clock.now()
  const read = await deps.uow.run(async ({ loops }) => ok(await loops.selfwatchRows()))
  if (!read.ok) return read
  const gathered = await gather(deps, now)
  if (!gathered.ok) return gathered

  const plan = planSelfwatch(gathered.value.findings, read.value, now, gathered.value.unread)
  const due = plan.file.slice(0, MAX_SIGNALS_PER_PASS)
  const pass: SelfwatchPass = {
    seen: gathered.value.findings.length,
    filed: [],
    deferred: plan.file.length - due.length,
    cleared: plan.clear.length,
    failed: [],
    notes: gathered.value.notes,
  }

  const rows: SelfwatchRow[] = []
  let evidence: Promise<string[]> | null = null
  for (const action of due) {
    const { overload } = deps
    const finding =
      overload && OVERLOAD_KINDS.has(action.finding.kind)
        ? { ...action.finding, evidence: await (evidence ??= overloadLines({ ...deps, overload }, now)) }
        : action.finding
    const id = key('selfwatch', finding.kind, finding.subject, action.hash)
    const filed = await deps.file(
      {
        from: `agent:${finding.repo ?? deps.repo}`,
        kind: 'request',
        title: finding.title.slice(0, 512),
        text: signalText(finding, finding.repo ?? deps.repo),
        repo: finding.repo ?? deps.repo,
        probe: false,
      },
      { loop: 'selfwatch', class: finding.kind, subject: finding.subject },
    )
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
    pass.filed.push({ key: id, title: finding.title, why: action.why })
    rows.push({
      subjectKey: subjectKeyOf(finding),
      kind: finding.kind,
      firstSeenAt: action.firstSeenAt,
      lastSeenAt: now,
      evidenceHash: action.hash,
      lastFiledAt: now,
      signalId: filed.value.signal,
      clearedAt: null,
    })
  }

  const change: SelfwatchChange = { filed: rows, touched: plan.touch, cleared: plan.clear, at: now }
  const recorded = await deps.uow.run(async ({ loops }) => {
    await loops.applySelfwatch(change)
    return ok(undefined)
  })
  if (!recorded.ok) return recorded
  return ok(pass)
}

export const selfwatchSummary = (pass: SelfwatchPass): string =>
  [
    `saw ${pass.seen} condition(s): filed ${pass.filed.length}`,
    pass.deferred > 0 ? `${pass.deferred} left for the next tick` : null,
    `cleared ${pass.cleared}`,
    pass.failed.length > 0 ? `${pass.failed.length} failed` : null,
    ...pass.notes,
  ]
    .filter(Boolean)
    .join('; ')
