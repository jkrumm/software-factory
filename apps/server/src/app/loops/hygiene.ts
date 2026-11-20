import { type DepsThresholds, HYGIENE_DEFAULTS, type SignalRequest } from '@software-factory/contract'
import {
  figureNow,
  heldJudgments,
  isBusy,
  type LifecycleStep,
  planLifecycle,
} from '../../domains/loops/hygiene-lifecycle.ts'
import {
  batchSignalText,
  batchSubject,
  batchTitle,
  checkAnswer,
  judgmentBudget,
  judgmentKey,
  judgmentSection,
  nothingToRead,
  planHygiene,
  probeBudget,
  probeFiledCount,
  probeSection,
  rankProbeFindings,
  requestOf,
  skipped,
  NO_REF,
  type Section,
  type Swept,
} from '../../domains/loops/hygiene.ts'
import { applyFixes } from '../../domains/loops/hygiene-fixes.ts'
import { REREAD_PROBES } from '../../domains/loops/hygiene-model.ts'
import type {
  Checkout,
  DeclaredProbe,
  HygieneChecker,
  Landing,
  Scope,
  SkippedProbe,
  SweepOptions,
  SweepReport,
} from '../../domains/loops/hygiene-model.ts'
import type { HygieneJudgment, HygienePassRecord, LoopReads, LoopStore } from '../../domains/loops/ports.ts'
import type { LoopFinding, Triaged } from '../../domains/intake/model.ts'
import { type DoctorReader, doctorMessage } from '../../domains/capacity/doctor.ts'
import type { PlanningStore } from '../../domains/planning/ports.ts'
import type { WorkStore } from '../../domains/work/ports.ts'
import { repoTextOf, type StoredProject } from '../../domains/planning/sync.ts'
import type { Clock } from '../../kernel/clock.ts'
import type { IdSource, IssueId } from '../../kernel/ids.ts'
import { key } from '../../kernel/keys.ts'
import type { AgwPort } from '../../kernel/agw.ts'
import { WORKFLOWS } from '../../kernel/workflows.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import { recordIn } from '../issues.ts'
import type { IntakeError } from '../intake.ts'
import type { UnitOfWork } from '../unit-of-work.ts'
import { readGate, type ClassGate } from './gate.ts'
import { settleClosed } from './ledger.ts'
import { passLoop, type LoopSpec, type LoopWiring } from './runner.ts'

export interface HygieneDeps {
  uow: UnitOfWork<{ loops: LoopStore; loopReads: LoopReads; planning: PlanningStore; work: WorkStore }>
  clock: Clock
  ids: IdSource
  checker: HygieneChecker
  /** the projects' own doctors: a red one skips the project's `check` probe with its lines as the reason; absent: none is asked */
  doctor?: DoctorReader
  agw: AgwPort
  /** intake's entry for a loop (`intake.api.file` with the finding): the finding's key decides a repeat, never its words */
  file(body: SignalRequest, finding: LoopFinding): Promise<Result<Triaged, IntakeError>>
  /** a project is swept in full (every probe, the document judgment) when its newest full pass is older than this */
  everyMs: number
  /** the cheap probes run again when the newest pass of any scope is older than this; 0 is off */
  dailyMs?: number
  /** writes one lifecycle step to its Issue; absent, the machine's events (`applyStep`). A seam for tests of the decisions. */
  apply?: (step: LifecycleStep, now: Date, reopens: number) => Promise<HygienePassRecord['lifecycle'][number] | null>
  /** the scripted fixes run (main.ts turns them on); absent or false: every finding is filed as before */
  fixes?: boolean
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

/** Why the `check` probe is skipped where the project's own `signals.github.checks` files a red default branch. */
const CHECKS_OWN_RED =
  "its red default branch is filed by the intake's `signals.github.checks` (an incident, healed when green)"

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
  // the keys are part of a note's identity: the keys that turn green on a later pass are a note of their own
  const record = (eventKey: string, event: Parameters<typeof recordIn>[2]['event']) =>
    deps.uow.run(({ work }) =>
      recordIn(work, deps, {
        issueId,
        key: key('hygiene', eventKey, step.issue, reopens, ...(eventKey === 'green' ? [step.keys.join(',')] : [])),
        event,
      }),
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

/**
 * File a pass's findings of one repo as one signal, one Issue, a section per finding. A filed, amended or repeat-dropped
 * outcome stands (an Issue carries it); any other drop is a failure of every key in it. Each key gets its own ledger row
 * (its class, its figure), so each is judged, healed and reopened by itself.
 */
async function fileBatch(
  deps: HygieneDeps,
  gate: ClassGate,
  input: { repoText: string; name: string; ref: string; sections: readonly Section[] },
  added: Added,
): Promise<void> {
  const { sections } = input
  if (sections.length === 0) return
  const swept: Swept = { repo: input.name, ref: input.ref }
  const title = batchTitle(sections, swept)
  const filed = await deps.file(
    {
      from: `agent:${input.name}`,
      kind: 'request',
      title,
      text: batchSignalText(sections, swept),
      repo: input.repoText,
      probe: false,
    },
    { loop: 'hygiene', class: 'batch', subject: batchSubject(sections) },
  )
  if (!filed.ok) {
    const reason = reasonOf(filed.error).slice(0, 300)
    for (const section of sections) added.failed.push({ key: section.key, reason })
    return
  }
  const { outcome, detail } = filed.value
  const stands = outcome === 'filed' || outcome === 'amended' || (outcome === 'dropped' && detail === 'repeat')
  if (!stands) {
    const reason = `${outcome}: ${detail}`.slice(0, 300)
    for (const section of sections) added.failed.push({ key: section.key, reason })
    return
  }
  for (const section of sections) {
    added.filed.push({ key: section.key, title: section.title })
    const lost = await gate.record(filed.value.issue, section.key, input.repoText, {
      figure: section.figure,
      signal: filed.value.signal,
      at: deps.clock.now(),
    })
    if (lost) added.failed.push({ key: section.key, reason: `finding class not recorded: ${lost}`.slice(0, 300) })
  }
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
  /** how the project's changes land (`ship`): a scripted fix pushes where the repo ships by push and merges a pull request where it ships by pull request */
  landing?: Landing
}

/**
 * The judgment over one checkout: asks `factory-hygiene` for the candidates the report names (none, or no budget left, is
 * `skipped`, final), checks the answer again and returns the findings that stand as sections for the pass's one Issue
 * (`sections`). Runs inside the checkout and never inside a transaction.
 */
async function judge(
  deps: HygieneDeps,
  gate: ClassGate,
  target: Target,
  checkout: Checkout,
  report: SweepReport,
  input: { probeFiled: number; attempt: number; held: ReadonlySet<string> },
  added: Added,
  sections: Section[],
): Promise<HygieneJudgment> {
  const request = requestOf({
    repo: target.repoText,
    cwd: checkout.path,
    ref: checkout.ref,
    report,
    max: judgmentBudget(input.probeFiled),
  })
  if (!request) return skipped(nothingToRead(report))

  const asked = await deps.agw.run(
    'hygiene',
    request,
    WORKFLOWS.hygiene.key(target.repoText, target.passId, input.attempt),
  )
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
    // A document whose finding is an open Issue (or closed lately) is that Issue's life: not filed again.
    if (input.held.has(judgmentKey(finding))) continue
    // The model was asked already; a finding of a held class is named, not filed.
    if (!gate.allows(judgmentKey(finding))) {
      added.overBudget.push({ key: judgmentKey(finding), title: finding.title })
      continue
    }
    sections.push(judgmentSection(finding, swept))
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
 * Just before anything is filed: a sweep and its fixes can take minutes, and the default branch moves meanwhile (a lead that
 * picked up an Issue found its finding already gone: 2026-11-17 `agentsmd:imports`). When origin's default branch is no longer
 * the commit swept, the red findings of the cheap file-reading probes (`REREAD_PROBES`: `agentsmd` among them) are read again at
 * the new head and only what it still raises is filed; what it no longer raises reads green for the lifecycle. A checkout that
 * cannot be made keeps the first reading.
 */
async function readAgain(
  deps: HygieneDeps,
  target: Target,
  options: SweepOptions,
  checkout: Checkout,
  report: SweepReport,
): Promise<SweepReport> {
  const probes = REREAD_PROBES.filter((probe) => report.findings.some((finding) => finding.probe === probe))
  if (!probes.length) return report
  const head = await deps.checker.withCheckout(target.repoText, null, async (now) =>
    now.ref === checkout.ref ? null : deps.checker.sweep(now, { ...options, only: probes }),
  )
  if (!head.ok || !head.value) return report
  // the merge rule of a scripted fix's second run: a probe that did not end with a verdict keeps its first reading
  const merged = applyFixes({ report, rerun: head.value, fixes: [] })
  const keysOf = (from: SweepReport, probe: string): string =>
    from.findings
      .filter((finding) => finding.probe === probe)
      .map((finding) => finding.key)
      .sort()
      .join('\n')
  const sha = head.value.ref.slice(0, 7)
  // a re-read finding has no plan: the note a scripted fix put on the first reading's finding of that key goes with it
  const plans = new Map(report.findings.filter((finding) => finding.plan).map((finding) => [finding.key, finding.plan]))
  return {
    ...merged,
    findings: merged.findings.map((finding) =>
      !finding.plan && plans.get(finding.key) ? { ...finding, plan: plans.get(finding.key) } : finding,
    ),
    runs: merged.runs.map((run) =>
      probes.includes(run.probe) && keysOf(report, run.probe) !== keysOf(merged, run.probe)
        ? { ...run, detail: `${run.detail}; read again at ${sha} before filing` }
        : run,
    ),
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
  const fixes: HygienePassRecord['fixes'] = []
  const swept = await deps.checker.withCheckout(target.repoText, null, async (checkout) => {
    let { scope } = planned
    if (scope === 'daily' && planned.lastFull && planned.lastFull.ref !== NO_REF) {
      const commits = await deps.checker.commitsSince(checkout, planned.lastFull.ref)
      if (isBusy({ commits, lastFullAt: planned.lastFull.at, now })) scope = 'full'
    }
    const sweepOptions: SweepOptions = {
      skipCheck: target.skipCheck,
      probes: target.probes,
      skip: target.skip,
      scope,
      deps: target.deps,
      idleAfterDays: target.idleAfterDays,
    }
    let report = await deps.checker.sweep(checkout, sweepOptions)
    // A finding with a script is fixed before anything is filed; the probe, run again, says what is still red.
    if (deps.fixes && deps.checker.fix) {
      const fixed = await deps.checker.fix(checkout, report, {
        sweep: sweepOptions,
        landing: target.landing ?? 'push',
        project: target.name,
      })
      report = fixed.report
      fixes.push(...fixed.fixes.map((entry) => ({ ...entry, at: now })))
    }
    report = await readAgain(deps, target, sweepOptions, checkout, report)
    const plan = planLifecycle({
      red: report.findings,
      runs: report.runs,
      issues: known.value,
      now,
      swept: `${target.name} @ ${checkout.ref.slice(0, 7)}`,
    })
    // A fix that could not start now (no test slot in time) holds its finding back one pass: the next pass asks again. Its key
    // stays red for the lifecycle (green would heal its Issue), but a closed Issue is not reopened for a lead meanwhile.
    const deferred = new Set(fixes.filter((entry) => entry.outcome === 'deferred').map((entry) => entry.key))
    const isDeferred = (step: LifecycleStep): boolean => step.keys.some((stepKey) => deferred.has(stepKey))
    // what the Issues of earlier findings of this repo did: a key a run judged and did not raise is at 0. An Issue the lifecycle
    // reopens below is not judged: it is open again, and its verdict is the one of the close that ends it
    // (one whose fix is deferred is reopened or healed on a later pass: no verdict yet either)
    const reopened = new Set(plan.steps.filter((step) => step.action === 'reopened').flatMap((step) => step.keys))
    const settled = await settleClosed(deps, {
      loop: 'hygiene',
      repo: target.repoText,
      now,
      read: (row) => (reopened.has(row.key) ? undefined : figureNow(report, row.key)),
    })
    // a ledger that could not be read costs the "last time" line and the verdicts of this pass, never the filing
    if (!settled.ok)
      added.failed.push({ key: 'ledger', reason: `${settled.error.kind}: ${settled.error.detail}`.slice(0, 300) })
    const lastTime = (key: string, figure: number): string | null =>
      settled.ok ? settled.value.lastTime(key, figure) : null
    for (const step of plan.steps.filter((entry) => !isDeferred(entry))) {
      const reopens = known.value.find((entry) => entry.key === step.key)?.reopens ?? 0
      const applied = await (deps.apply ?? ((s, n, r) => applyStep(deps, s, n, r)))(step, now, reopens)
      // one Issue, one step: the record keeps a row per key, as the project page reads it
      if (applied) lifecycle.push(...step.keys.map((stepKey) => ({ ...applied, key: stepKey })))
    }
    // A held class is named before the budget counts: it does not use up a slot.
    const ranked = rankProbeFindings(
      report.findings.filter((finding) => !plan.suppress.has(finding.key) && !deferred.has(finding.key)),
    )
    const allowed = ranked.filter((finding) => gate.allows(finding.key))
    const { file } = probeBudget(allowed)
    const sections = file.map((finding) => probeSection(finding, lastTime(finding.key, finding.count)))
    for (const finding of ranked) {
      if (!file.includes(finding)) added.overBudget.push({ key: finding.key, title: finding.title })
    }
    // the sweep promotes a steady pass to a full one when the repo has a fresh commit: what ran is what it recorded
    const judgment =
      (report.scope ?? scope) === 'full'
        ? await judge(
            deps,
            gate,
            target,
            checkout,
            report,
            { probeFiled: file.length, attempt: 1, held: plan.suppress },
            added,
            sections,
          )
        : skipped(`a ${report.scope ?? scope} pass: the document judgment runs in the full pass`)
    // every finding of the pass, probe and judgment, is one signal and one Issue
    await fileBatch(deps, gate, { ...target, ref: report.ref, sections }, added)
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
        fixes,
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
        fixes: [],
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
  const known = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.findingIssues(target.repoText)))
  if (!known.ok) return known
  const held = heldJudgments(known.value, deps.clock.now())
  const added = nothingAdded()
  const attempt = row.judgment.attempts + 1
  const sections: Section[] = []
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
      judge(deps, gate, target, checkout, row.report, { probeFiled, attempt, held }, added, sections),
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
    // the retry's findings are one Issue of their own
    await fileBatch(deps, gate, { ...target, ref: row.report.ref, sections }, added)
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
 * is judged again at the stored commit. Both file through intake, at most `MAX_SIGNALS_PER_PASS` findings a project and pass (one signal, a section each),
 * the rest named in the record. A checkout that fails on a full pass is recorded as a sweep with no runs, retried after `retryMs`.
 * A crash between filing and recording replays safely: intake's finding key turns a repeat into a note or a drop.
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
  // A red default branch is filed by one detector: the intake's `signals.github.checks` where the project has it, this probe where it has not.
  const skipCheck = !hygiene.check
    ? hygiene.reason
    : project.project.signals.github?.checks
      ? CHECKS_OWN_RED
      : await redDoctor(deps, project)
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
      landing: project.project.ship.some((rule) => rule.via === 'pr') ? 'pr' : 'push',
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
  const fixed = ['fixed', 'failed', 'skipped', 'deferred']
    .map((outcome) => [outcome, record.fixes.filter((entry) => entry.outcome === outcome).length] as const)
    .filter(([, count]) => count > 0)
    .map(([outcome, count]) => `fix ${outcome} ${count}`)
  return [
    `${what} ${record.repo} @${record.ref.slice(0, 7)}: filed ${pass.filedNow} finding(s) as one signal, ${pass.overNow} over budget; judgment ${record.judgment.outcome}`,
    ...lifecycle,
    ...fixed,
  ].join('; ')
}

/** Deterministic sweep of one project a tick (probes in a throwaway checkout), `factory-hygiene` over the documents it picks. */
export const hygieneLoop = (wiring: LoopWiring, deps: HygieneDeps): LoopSpec =>
  passLoop(wiring, {
    name: 'hygiene',
    pass: () => hygienePass(deps),
    problems: (pass) => (pass.due ? pass.record.failed.map((f) => `${f.key}: ${f.reason}`) : null),
    summary: hygieneSummary,
  })
