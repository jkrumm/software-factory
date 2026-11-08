import type { SignalRequest } from '@software-factory/contract'
import {
  checkAnswer,
  judgmentBudget,
  judgmentKey,
  judgmentSignalText,
  judgmentTitle,
  nothingToRead,
  planHygiene,
  probeBudget,
  probeFiledCount,
  probeSignalText,
  rankProbeFindings,
  requestOf,
  skipped,
  NO_REF,
  type Swept,
} from '../../domains/loops/hygiene.ts'
import type { Checkout, HygieneChecker, SweepReport } from '../../domains/loops/hygiene-model.ts'
import type { HygieneJudgment, HygienePassRecord, HygieneWorkflow, LoopStore } from '../../domains/loops/ports.ts'
import type { Triaged } from '../../domains/intake/model.ts'
import type { PlanningStore } from '../../domains/planning/ports.ts'
import { repoTextOf } from '../../domains/planning/sync.ts'
import type { Clock } from '../../kernel/clock.ts'
import type { IdSource } from '../../kernel/ids.ts'
import { key } from '../../kernel/keys.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import type { IntakeError } from '../intake.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

export interface HygieneDeps {
  uow: UnitOfWork<{ loops: LoopStore; planning: PlanningStore }>
  clock: Clock
  ids: IdSource
  checker: HygieneChecker
  workflow: HygieneWorkflow
  /** intake's entry for an agent (`intake.api.file`): its fingerprint rules decide a repeat */
  file(body: SignalRequest): Promise<Result<Triaged, IntakeError>>
  /** a project is swept when its newest pass is older than this */
  everyMs: number
  /** a failed judgment is asked again this long on */
  retryMs: number
  /** only these projects (names or repo texts); null is every project with a `project.yaml` */
  repos: readonly string[] | null
}

export type HygienePass =
  | { due: false }
  | { due: true; mode: 'full' | 'retry'; record: HygienePassRecord; filedNow: number; overNow: number }

const reasonOf = (error: IntakeError): string => ('detail' in error ? `${error.kind}: ${error.detail}` : error.kind)

/** What one tick adds to a record. */
interface Added {
  filed: HygienePassRecord['filed']
  overBudget: HygienePassRecord['overBudget']
  failed: HygienePassRecord['failed']
}

const nothingAdded = (): Added => ({ filed: [], overBudget: [], failed: [] })

/** File one signal. A filed, amended or repeat-dropped outcome stands (an Issue carries it); any other drop is a failure. */
async function fileOne(
  deps: HygieneDeps,
  input: { repoText: string; name: string; id: string; title: string; text: string },
  added: Added,
): Promise<void> {
  const filed = await deps.file({
    from: `agent:${input.name}`,
    kind: 'request',
    title: input.title,
    text: input.text,
    repo: input.repoText,
    probe: false,
  })
  if (!filed.ok) {
    added.failed.push({ key: input.id, reason: reasonOf(filed.error).slice(0, 300) })
    return
  }
  const { outcome, detail } = filed.value
  const stands = outcome === 'filed' || outcome === 'amended' || (outcome === 'dropped' && detail === 'repeat')
  if (stands) added.filed.push({ key: input.id, title: input.title })
  else added.failed.push({ key: input.id, reason: `${outcome}: ${detail}`.slice(0, 300) })
}

interface Target {
  /** the repo text intake and the checker know the project by */
  repoText: string
  name: string
  passId: string
  /** the project's reason for not running `make check` here (`hygiene.check: false`); absent runs it */
  skipCheck?: string
}

/**
 * The judgment over one checkout: asks `factory-hygiene` for the candidates the report names (none, or no budget left, is
 * `skipped`, final), checks the answer again and files the findings that stand. Runs inside the checkout and never inside
 * a transaction.
 */
async function judge(
  deps: HygieneDeps,
  target: Target,
  checkout: Checkout,
  report: SweepReport,
  input: { probeFiled: number; attempt: number },
  added: Added,
): Promise<HygieneJudgment> {
  const request = requestOf({
    repo: target.repoText,
    cwd: checkout.path,
    ref: checkout.ref,
    report,
    max: judgmentBudget(input.probeFiled),
  })
  if (!request) return skipped(nothingToRead(report))

  const asked = await deps.workflow.ask(request, key('hygiene', target.repoText, target.passId, input.attempt))
  const judgedAt = deps.clock.now()
  if (!asked.ok) {
    return {
      outcome: 'failed',
      attempts: input.attempt,
      judgedAt,
      reason: `${asked.error.kind}: ${asked.error.detail}`.slice(0, 300),
      findings: [],
    }
  }
  const checked = checkAnswer(asked.value, request)
  const swept: Swept = { repo: target.name, ref: checkout.ref }
  for (const finding of checked.findings) {
    await fileOne(
      deps,
      {
        ...target,
        id: judgmentKey(finding),
        title: judgmentTitle(finding),
        text: judgmentSignalText(finding, swept),
      },
      added,
    )
  }
  for (const finding of checked.overBudget) added.overBudget.push({ key: judgmentKey(finding), title: finding.title })
  for (const dropped of checked.rejected) {
    added.failed.push({ key: 'judgment', reason: `dropped "${dropped.title}": ${dropped.why}`.slice(0, 300) })
  }
  return {
    outcome: 'answered',
    attempts: input.attempt,
    judgedAt,
    reason: asked.value.reason,
    findings: checked.findings,
  }
}

async function fullPass(deps: HygieneDeps, target: Target, now: Date): Promise<Result<HygienePass, PortError>> {
  const added = nothingAdded()
  const swept = await deps.checker.withCheckout(target.repoText, null, async (checkout) => {
    const report = await deps.checker.sweep(checkout, { skipCheck: target.skipCheck })
    const { file, overBudget } = probeBudget(rankProbeFindings(report.findings))
    for (const finding of file) {
      await fileOne(
        deps,
        {
          ...target,
          id: finding.key,
          title: finding.title,
          text: probeSignalText(finding, { repo: target.name, ref: report.ref }),
        },
        added,
      )
    }
    for (const finding of overBudget) added.overBudget.push({ key: finding.key, title: finding.title })
    const judgment = await judge(deps, target, checkout, report, { probeFiled: added.filed.length, attempt: 1 }, added)
    return { report, judgment }
  })
  // A checkout that cannot be made is recorded as a sweep that ran nothing: the project is asked again after `retryMs`, and
  // the projects behind it are not starved by one that fails on every tick.
  const record: HygienePassRecord = swept.ok
    ? {
        id: target.passId,
        repo: target.repoText,
        at: now,
        ref: swept.value.report.ref,
        report: swept.value.report,
        judgment: swept.value.judgment,
        ...added,
      }
    : {
        id: target.passId,
        repo: target.repoText,
        at: now,
        ref: NO_REF,
        report: { ref: NO_REF, runs: [], findings: [], stale: [], slop: [] },
        judgment: skipped('no checkout'),
        filed: [],
        overBudget: [],
        failed: [{ key: 'checkout', reason: `${swept.error.kind}: ${swept.error.detail}`.slice(0, 300) }],
      }
  const recorded = await deps.uow.run(async ({ loops }) => {
    await loops.recordHygienePass(record)
    return ok(undefined)
  })
  if (!recorded.ok) return recorded
  return ok({ due: true, mode: 'full', record, filedNow: added.filed.length, overNow: added.overBudget.length })
}

async function retryPass(
  deps: HygieneDeps,
  target: Target,
  row: HygienePassRecord,
): Promise<Result<HygienePass, PortError>> {
  const added = nothingAdded()
  const attempt = row.judgment.attempts + 1
  const probeFiled = probeFiledCount(row)
  const noRequest = !requestOf({
    repo: target.repoText,
    cwd: '-',
    ref: row.ref,
    report: row.report,
    max: judgmentBudget(probeFiled),
  })

  let judgment: HygieneJudgment
  if (noRequest) {
    judgment = skipped(nothingToRead(row.report))
  } else {
    const retried = await deps.checker.withCheckout(target.repoText, row.report.ref, (checkout) =>
      judge(deps, target, checkout, row.report, { probeFiled, attempt }, added),
    )
    // A checkout that cannot be made counts as an attempt, or the same project would be retried every tick.
    judgment = retried.ok
      ? retried.value
      : {
          outcome: 'failed',
          attempts: attempt,
          judgedAt: deps.clock.now(),
          reason: `${retried.error.kind}: ${retried.error.detail}`.slice(0, 300),
          findings: [],
        }
  }
  const record: HygienePassRecord = {
    ...row,
    judgment,
    filed: [...row.filed, ...added.filed],
    overBudget: [...row.overBudget, ...added.overBudget],
    failed: [...row.failed, ...added.failed],
  }
  const recorded = await deps.uow.run(async ({ loops }) => {
    await loops.updateHygieneJudgment(row.id, record)
    return ok(undefined)
  })
  if (!recorded.ok) return recorded
  return ok({ due: true, mode: 'retry', record, filedNow: added.filed.length, overNow: added.overBudget.length })
}

/**
 * One tick of the hygiene loop: at most one project. A project with no pass in the last `everyMs` is swept (probes in a
 * throwaway checkout, then `factory-hygiene` over the documents the sweep picked); otherwise a project whose judgment failed
 * is judged again at the stored commit. Both file through intake, at most `MAX_SIGNALS_PER_PASS` signals a project and pass,
 * the rest named in the record. A checkout that fails on a full pass is recorded as a sweep with no runs, retried after `retryMs`.
 * A crash between filing and recording replays safely: intake's fingerprint turns a repeat into a note or a drop.
 */
export async function hygienePass(deps: HygieneDeps): Promise<Result<HygienePass, PortError>> {
  const now = deps.clock.now()
  const read = await deps.uow.run(async ({ loops, planning }) =>
    ok({ rows: await loops.hygienePasses(), projects: await planning.projects() }),
  )
  if (!read.ok) return read
  const projects = read.value.projects.filter((p) => p.source === 'file')
  const byText = new Map(projects.map((p) => [repoTextOf(p), p]))
  const allowed =
    deps.repos === null
      ? null
      : projects.filter((p) => deps.repos?.includes(p.name) || deps.repos?.includes(repoTextOf(p))).map(repoTextOf)
  const work = planHygiene({
    projects: [...byText.keys()],
    rows: read.value.rows,
    now,
    everyMs: deps.everyMs,
    retryMs: deps.retryMs,
    allow: allowed,
  })
  if (work.kind === 'none') return ok({ due: false })
  const project = byText.get(work.repo)
  if (!project) return err(portError('unreadable', `the project ${work.repo} is gone`))
  if (work.kind === 'retry') {
    return retryPass(deps, { repoText: work.repo, name: project.name, passId: work.row.id }, work.row)
  }
  const { hygiene } = project.project
  const skipCheck = hygiene.check ? undefined : hygiene.reason
  return fullPass(deps, { repoText: work.repo, name: project.name, passId: deps.ids.next('hygiene'), skipCheck }, now)
}

export const hygieneSummary = (pass: HygienePass): string => {
  if (!pass.due) return 'not due'
  const { record } = pass
  const what = pass.mode === 'full' ? 'swept' : 'judged again'
  return `${what} ${record.repo} @${record.ref.slice(0, 7)}: filed ${pass.filedNow} signal(s), ${pass.overNow} over budget; judgment ${record.judgment.outcome}`
}
