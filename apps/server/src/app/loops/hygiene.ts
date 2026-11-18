import { type DepsThresholds, HYGIENE_DEFAULTS, type SignalRequest } from '@software-factory/contract'
import { isBusy, type LifecycleStep, planLifecycle } from '../../domains/loops/hygiene-lifecycle.ts'
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
import type {
  Checkout,
  DeclaredProbe,
  HygieneChecker,
  Scope,
  SkippedProbe,
  SweepReport,
} from '../../domains/loops/hygiene-model.ts'
import type {
  HygieneJudgment,
  HygienePassRecord,
  HygieneWorkflow,
  LoopReads,
  LoopStore,
} from '../../domains/loops/ports.ts'
import type { Triaged } from '../../domains/intake/model.ts'
import { type DoctorReader, doctorMessage } from '../../domains/capacity/doctor.ts'
import type { PlanningStore } from '../../domains/planning/ports.ts'
import type { WorkStore } from '../../domains/work/ports.ts'
import { repoTextOf, type StoredProject } from '../../domains/planning/sync.ts'
import type { Clock } from '../../kernel/clock.ts'
import type { IdSource, IssueId } from '../../kernel/ids.ts'
import { key } from '../../kernel/keys.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import { recordIn } from '../issues.ts'
import type { IntakeError } from '../intake.ts'
import type { UnitOfWork } from '../unit-of-work.ts'
import { readGate, type ClassGate } from './gate.ts'

export interface HygieneDeps {
  uow: UnitOfWork<{ loops: LoopStore; loopReads: LoopReads; planning: PlanningStore; work: WorkStore }>
  clock: Clock
  ids: IdSource
  checker: HygieneChecker
  /** the projects' own doctors: a red one skips the project's `check` probe with its lines as the reason; absent: none is asked */
  doctor?: DoctorReader
  workflow: HygieneWorkflow
  /** intake's entry for an agent (`intake.api.file`): its fingerprint rules decide a repeat */
  file(body: SignalRequest): Promise<Result<Triaged, IntakeError>>
  /** a project is swept in full (every probe, the document judgment) when its newest full pass is older than this */
  everyMs: number
  /** the cheap probes run again when the newest pass of any scope is older than this; 0 is off */
  dailyMs?: number
  /** writes one lifecycle step to its Issue; absent, the machine's events (`applyStep`). A seam for tests of the decisions. */
  apply?: (step: LifecycleStep, now: Date, reopens: number) => Promise<HygienePassRecord['lifecycle'][number] | null>
  /** a failed judgment is asked again this long on */
  retryMs: number
  /** only these projects (names or repo texts); null is every project with a `project.yaml` */
  repos: readonly string[] | null
}

export type HygienePass =
  | { due: false }
  | {
      due: true
      mode: 'full' | 'steady' | 'daily' | 'retry'
      record: HygienePassRecord
      filedNow: number
      overNow: number
    }

const reasonOf = (error: IntakeError): string => ('detail' in error ? `${error.kind}: ${error.detail}` : error.kind)

/** What one tick adds to a record. */
interface Added {
  filed: HygienePassRecord['filed']
  overBudget: HygienePassRecord['overBudget']
  failed: HygienePassRecord['failed']
}

const nothingAdded = (): Added => ({ filed: [], overBudget: [], failed: [] })

/**
 * Applies one step of the lifecycle to its Issue and says what came of it (null: nothing to record). Every call is keyed by
 * what it does to which Issue, so a replayed pass changes nothing twice; the machine's own refusal (a lead started in the
 * meantime) turns a heal into a note, and anything else it refuses is named, never retried.
 */
async function applyStep(
  deps: HygieneDeps,
  step: LifecycleStep,
  now: Date,
  reopens: number,
): Promise<HygienePassRecord['lifecycle'][number] | null> {
  const issueId = step.issue as IssueId
  const done = (action: LifecycleStep['action'], why: string) => ({
    key: step.key,
    issue: step.issue,
    action,
    why,
    at: now,
  })
  const record = (eventKey: string, event: Parameters<typeof recordIn>[2]['event']) =>
    deps.uow.run(({ work }) =>
      recordIn(work, deps, { issueId, key: key('hygiene', eventKey, step.issue, reopens), event }),
    )
  if (step.action === 'kept') return done('kept', step.why)
  if (step.action === 'reopened') {
    const reopened = await deps.uow.run(({ work }) =>
      recordIn(work, deps, {
        issueId,
        key: key('hygiene', 'reopened', step.issue, reopens + 1),
        event: { kind: 'reopened', payload: { reason: step.why.slice(0, 2000) }, actor: 'factory' },
      }),
    )
    if (!reopened.ok) return done('kept', `could not reopen: ${JSON.stringify(reopened.error).slice(0, 200)}`)
    // a replay answers with the stored event, whatever the machine decided then: only an applied one reopened it
    return reopened.value.event.result !== 'applied'
      ? done('kept', `the machine did not reopen it: ${reopened.value.event.detail ?? reopened.value.event.result}`)
      : done('reopened', step.why.split('\n')[0] ?? step.why)
  }
  const note = async () => {
    const noted = await record('green', {
      kind: 'noted',
      payload: { text: `Hygiene: ${step.why}`.slice(0, 2000) },
      actor: 'factory',
    })
    if (!noted.ok) return done('kept', `could not note: ${JSON.stringify(noted.error).slice(0, 200)}`)
    // the lead of this cycle was told on an earlier pass: nothing new reached it, so nothing is recorded
    return noted.value.result === 'replayed' ? null : done('noted', step.why)
  }
  if (step.action === 'noted') return note()
  const healed = await record('healed', {
    kind: 'closed',
    payload: { attempt: null, outcome: 'healed', reason: `Hygiene: ${step.why}`.slice(0, 2000) },
    actor: 'factory',
  })
  if (!healed.ok) return done('kept', `could not heal: ${JSON.stringify(healed.error).slice(0, 200)}`)
  // a lead started between the read and the write: tell it instead
  return healed.value.event.result === 'applied' ? done('healed', step.why) : note()
}

/** File one signal. A filed, amended or repeat-dropped outcome stands (an Issue carries it); any other drop is a failure. */
async function fileOne(
  deps: HygieneDeps,
  gate: ClassGate,
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
  if (stands) {
    added.filed.push({ key: input.id, title: input.title })
    const lost = await gate.record(filed.value.issue, input.id, input.repoText)
    if (lost) added.failed.push({ key: input.id, reason: `finding class not recorded: ${lost}`.slice(0, 300) })
  } else added.failed.push({ key: input.id, reason: `${outcome}: ${detail}`.slice(0, 300) })
}

interface Target {
  /** the repo text intake and the checker know the project by */
  repoText: string
  name: string
  passId: string
  /** the project's reason for not running `make check` here (`hygiene.check: false`); absent runs it */
  skipCheck?: string
  /** the probes the project declares (`hygiene.probes`) */
  probes?: readonly DeclaredProbe[]
  /** the built-in probes the project opts out of (`hygiene.skip`) */
  skip?: readonly SkippedProbe[]
  /** the bar the `deps` refresh must clear: the catalogue's defaults, with the project's own keys over them */
  deps?: DepsThresholds
  /** the project's own `hygiene.idleAfterDays`; absent is the catalogue's */
  idleAfterDays?: number
}

/**
 * The judgment over one checkout: asks `factory-hygiene` for the candidates the report names (none, or no budget left, is
 * `skipped`, final), checks the answer again and files the findings that stand. Runs inside the checkout and never inside
 * a transaction.
 */
async function judge(
  deps: HygieneDeps,
  gate: ClassGate,
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
    // The model was asked already; a finding of a held class is named, not filed.
    if (!gate.allows(judgmentKey(finding))) {
      added.overBudget.push({ key: judgmentKey(finding), title: finding.title })
      continue
    }
    await fileOne(
      deps,
      gate,
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

/**
 * One sweep of one project: `planned` is how much of the catalogue the clock asks for, and a daily pass becomes a full one when
 * the repo is busy (`isBusy`). The findings already filed are looked at first (`planLifecycle`): a probe that ran green closes
 * or tells the Issue of a finding it no longer raises, a still-red finding of an Issue closed done reopens that Issue instead of
 * filing a second. The rest is filed through intake as before, then the document judgment (full passes only).
 */
async function sweepPass(
  deps: HygieneDeps,
  target: Target,
  now: Date,
  planned: { scope: Scope; lastFull: HygienePassRecord | null },
): Promise<Result<HygienePass, PortError>> {
  // One repo per tick: the class's verdict spans every repo, so a class held by other repos' Issues holds here too.
  const gated = await readGate(deps, { loop: 'hygiene', now })
  if (!gated.ok) return gated
  const gate = gated.value
  const known = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.findingIssues(target.repoText)))
  if (!known.ok) return known
  const added = nothingAdded()
  const lifecycle: HygienePassRecord['lifecycle'] = []
  const swept = await deps.checker.withCheckout(target.repoText, null, async (checkout) => {
    let { scope } = planned
    if (scope === 'daily' && planned.lastFull && planned.lastFull.ref !== NO_REF) {
      const commits = await deps.checker.commitsSince(checkout, planned.lastFull.ref)
      if (isBusy({ commits, lastFullAt: planned.lastFull.at, now })) scope = 'full'
    }
    const report = await deps.checker.sweep(checkout, {
      skipCheck: target.skipCheck,
      probes: target.probes,
      skip: target.skip,
      scope,
      deps: target.deps,
      idleAfterDays: target.idleAfterDays,
    })
    const plan = planLifecycle({
      red: report.findings,
      runs: report.runs,
      issues: known.value,
      now,
      swept: `${target.name} @ ${checkout.ref.slice(0, 7)}`,
    })
    for (const step of plan.steps) {
      const reopens = known.value.find((entry) => entry.key === step.key)?.reopens ?? 0
      const applied = await (deps.apply ?? ((s, n, r) => applyStep(deps, s, n, r)))(step, now, reopens)
      if (applied) lifecycle.push(applied)
    }
    // A held class is named before the budget counts: it does not use up a slot.
    const ranked = rankProbeFindings(report.findings.filter((finding) => !plan.suppress.has(finding.key)))
    const allowed = ranked.filter((finding) => gate.allows(finding.key))
    const { file } = probeBudget(allowed)
    for (const finding of file) {
      await fileOne(
        deps,
        gate,
        {
          ...target,
          id: finding.key,
          title: finding.title,
          text: probeSignalText(finding, { repo: target.name, ref: report.ref }),
        },
        added,
      )
    }
    for (const finding of ranked) {
      if (!file.includes(finding)) added.overBudget.push({ key: finding.key, title: finding.title })
    }
    // the sweep promotes a steady pass to a full one when the repo has a fresh commit: what ran is what it recorded
    const judgment =
      (report.scope ?? scope) === 'full'
        ? await judge(deps, gate, target, checkout, report, { probeFiled: added.filed.length, attempt: 1 }, added)
        : skipped(`a ${report.scope ?? scope} pass: the document judgment runs in the full pass`)
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
        lifecycle,
      }
    : {
        id: target.passId,
        repo: target.repoText,
        at: now,
        ref: NO_REF,
        report: { ref: NO_REF, scope: planned.scope, runs: [], findings: [], stale: [], slop: [] },
        judgment: skipped('no checkout'),
        filed: [],
        overBudget: [],
        failed: [{ key: 'checkout', reason: `${swept.error.kind}: ${swept.error.detail}`.slice(0, 300) }],
        lifecycle: [],
      }
  const recorded = await deps.uow.run(async ({ loops }) => {
    await loops.recordHygienePass(record)
    return ok(undefined)
  })
  if (!recorded.ok) return recorded
  const mode = swept.ok ? (swept.value.report.scope ?? planned.scope) : planned.scope
  return ok({ due: true, mode, record, filedNow: added.filed.length, overNow: added.overBudget.length })
}

async function retryPass(
  deps: HygieneDeps,
  target: Target,
  row: HygienePassRecord,
): Promise<Result<HygienePass, PortError>> {
  const gated = await readGate(deps, { loop: 'hygiene', now: deps.clock.now() })
  if (!gated.ok) return gated
  const gate = gated.value
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
      judge(deps, gate, target, checkout, row.report, { probeFiled, attempt }, added),
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

/** Why the project's doctor says this host cannot run it, so its `check` probe is skipped instead of switched off; undefined: green, no doctor, or no reading. */
async function redDoctor(deps: HygieneDeps, project: StoredProject): Promise<string | undefined> {
  const command = project.project.doctor
  if (!deps.doctor || !command) return undefined
  const reading = await deps.doctor.read({ project: project.name, repo: project.repo, command })
  return reading && !reading.ok ? doctorMessage(project.name, reading) : undefined
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
  const projects = read.value.projects.filter((p) => p.source === 'file' && !p.project.work)
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
    dailyMs: deps.dailyMs,
    retryMs: deps.retryMs,
    allow: allowed,
    idleAfterDays: (repo) => byText.get(repo)?.project.hygiene.idleAfterDays,
  })
  if (work.kind === 'none') return ok({ due: false })
  const project = byText.get(work.repo)
  if (!project) return err(portError('unreadable', `the project ${work.repo} is gone`))
  if (work.kind === 'retry') {
    return retryPass(deps, { repoText: work.repo, name: project.name, passId: work.row.id }, work.row)
  }
  const { hygiene } = project.project
  const skipCheck = hygiene.check ? await redDoctor(deps, project) : hygiene.reason
  return sweepPass(
    deps,
    {
      repoText: work.repo,
      name: project.name,
      passId: deps.ids.next('hygiene'),
      skipCheck,
      probes: hygiene.probes,
      skip: hygiene.skip,
      deps: {
        runtimeStaleDays: hygiene.deps?.runtimeStaleDays ?? HYGIENE_DEFAULTS.deps.runtimeStaleDays,
        behindRows: hygiene.deps?.behindRows ?? HYGIENE_DEFAULTS.deps.behindRows,
      },
      idleAfterDays: hygiene.idleAfterDays,
    },
    now,
    {
      scope: work.kind === 'daily' || work.kind === 'steady' ? work.kind : 'full',
      lastFull: work.kind === 'daily' ? work.lastFull : null,
    },
  )
}

export const hygieneSummary = (pass: HygienePass): string => {
  if (!pass.due) return 'not due'
  const { record } = pass
  const what =
    pass.mode === 'retry'
      ? 'judged again'
      : pass.mode === 'daily'
        ? 'swept daily'
        : pass.mode === 'steady'
          ? 'swept steady'
          : 'swept'
  const lifecycle = ['healed', 'noted', 'reopened', 'kept']
    .map((action) => [action, record.lifecycle.filter((entry) => entry.action === action).length] as const)
    .filter(([, count]) => count > 0)
    .map(([action, count]) => `${action} ${count}`)
  return [
    `${what} ${record.repo} @${record.ref.slice(0, 7)}: filed ${pass.filedNow} signal(s), ${pass.overNow} over budget; judgment ${record.judgment.outcome}`,
    ...lifecycle,
  ].join('; ')
}
