import type { SignalRequest } from '@software-factory/contract'
import type { Triaged } from '../../domains/intake/model.ts'
import type { CiRuns, LoopReads, LoopStore, MigrationFiles } from '../../domains/loops/ports.ts'
import { DEFAULT_STEWARD_RULES } from '../../domains/loops/stall.ts'
import {
  ciFindings,
  heartbeatFindings,
  idleFindings,
  inertRegressionFindings,
  MAX_SELFWATCH_FILINGS,
  migrationFindings,
  planSelfwatch,
  signalText,
  waitFindings,
} from '../../domains/loops/selfwatch.ts'
import {
  type Finding,
  type HeartbeatFact,
  type IdleLead,
  type RegressionFact,
  type SelfwatchChange,
  type SelfwatchRow,
  subjectKeyOf,
} from '../../domains/loops/selfwatch-model.ts'
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
}

export interface SelfwatchDeps {
  uow: UnitOfWork<SelfwatchStores>
  clock: Clock
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
  /** `GET /health`'s heartbeat, as `healthOf` computes it */
  heartbeat(): Promise<HeartbeatFact>
  /** intake's entry for an agent (`intake.api.file`): its fingerprint rules decide a repeat */
  file(body: SignalRequest): Promise<Result<Triaged, IntakeError>>
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
      // a verdict just delivered is a wait the steward honours: the quiet is counted from the end of that grace
      idleSince: new Date(
        Math.max(
          idle.idle.idleSince.getTime(),
          idle.idle.verdictAt ? idle.idle.verdictAt.getTime() + DEFAULT_STEWARD_RULES.verdictGraceMs : 0,
        ),
      ),
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
  return ok(gathered)
}

/**
 * One tick of the self-watch loop: six deterministic conditions of the factory itself, filed through intake as signals on
 * the watched repo. A subject is filed once; while it stays open and its evidence is the same nothing is filed, a changed
 * evidence is filed again under the same title (intake amends the open Issue), and a subject that no longer holds is
 * cleared. At most `MAX_SELFWATCH_FILINGS` a pass, the rest on the next. A row is written only after intake took the signal, so a
 * failed filing is tried again; a crash between the two replays safely, since intake's fingerprint turns a repeat into a note.
 */
export async function selfwatchPass(deps: SelfwatchDeps): Promise<Result<SelfwatchPass, PortError>> {
  const now = deps.clock.now()
  const read = await deps.uow.run(async ({ loops }) => ok(await loops.selfwatchRows()))
  if (!read.ok) return read
  const gathered = await gather(deps, now)
  if (!gathered.ok) return gathered

  const plan = planSelfwatch(gathered.value.findings, read.value, now, gathered.value.unread)
  const due = plan.file.slice(0, MAX_SELFWATCH_FILINGS)
  const pass: SelfwatchPass = {
    seen: gathered.value.findings.length,
    filed: [],
    deferred: plan.file.length - due.length,
    cleared: plan.clear.length,
    failed: [],
    notes: gathered.value.notes,
  }

  const rows: SelfwatchRow[] = []
  for (const action of due) {
    const { finding } = action
    const id = key('selfwatch', finding.kind, finding.subject, action.hash)
    const filed = await deps.file({
      from: `agent:${deps.repo}`,
      kind: 'request',
      title: finding.title.slice(0, 512),
      text: signalText(finding, deps.repo),
      repo: deps.repo,
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
