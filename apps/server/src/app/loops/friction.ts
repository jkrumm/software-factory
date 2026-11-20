import type { FrictionModel, SignalRequest } from '@software-factory/contract'
import {
  RETRO_EVERY_MS,
  RETRO_TITLE,
  RETRO_WINDOW_DAYS,
  type RetroOutcomes,
  retroText,
} from '../../domains/improve/retro.ts'
import {
  clockTrigger,
  FRICTION_WINDOW_DAYS,
  hasIssueRefs,
  kpiFigure,
  type KpiReading,
  kpisOffTarget,
  named,
  PATTERN_REPEAT_MS,
  type Pattern,
  type PassTrigger,
  patternsOver,
  signalText,
  signalTitle,
  volumeDue,
  withinBudget,
} from '../../domains/improve/friction.ts'
import type { FrictionPassRecord } from '../../domains/improve/ports.ts'
import type { LoopReads, LoopStore } from './stores.ts'
import type { LoopFinding, Triaged } from '../../domains/intake/model.ts'
import type { Clock } from '../../kernel/clock.ts'
import type { IdSource } from '../../kernel/ids.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import type { IntakeError } from '../intake.ts'
import type { UnitOfWork } from '../unit-of-work.ts'
import { findingKeyOf } from '../../domains/intake/rules.ts'
import { classOf } from '../../domains/improve/classes.ts'
import { readGate, type ClassGate } from './gate.ts'
import { settleClosed, type Ledger } from './ledger.ts'
import { passLoop, type LoopSpec, type LoopWiring } from './runner.ts'

/** The repo that carries the factory's own findings, and who files them. */
const FRICTION_REPO = 'software-factory'
const FRICTION_SOURCE = `agent:${FRICTION_REPO}`
const RETRO_FINDING: LoopFinding = { loop: 'friction', class: 'retro', subject: 'retro' }

/** Where intake records the retro signal's Issue (its source and finding key): what `FrictionDeps.retroFiledAt` reads. */
export const RETRO_SUBJECT = { source: FRICTION_SOURCE, subject: findingKeyOf(RETRO_FINDING, FRICTION_REPO) }

export interface FrictionDeps {
  uow: UnitOfWork<{ loops: LoopStore; loopReads: LoopReads }>
  clock: Clock
  ids: IdSource
  /** the counts of the last `FRICTION_WINDOW_DAYS` days ending at `now` (`read/friction.ts`, bound in `main.ts`) */
  friction(now: Date): Promise<FrictionModel>
  /** the seven KPIs over the pass's window (the one `friction` read), with their parts */
  kpis(window: { from: Date; to: Date }): Promise<KpiReading[]>
  /** the most recent Issue refs behind the counts of these keys, for the same window */
  evidence(now: Date, keys: string[]): Promise<Record<string, string[]>>
  /** Issues closed from `since` to `now`: what the volume trigger counts */
  closedSince(since: Date, now: Date): Promise<number>
  /** when the retro signal was last filed as a new Issue (`read/retro-outcomes.ts`), null when never */
  retroFiledAt(): Promise<Date | null>
  /** what the retro signals of the last `days` days led to (`read/retro-outcomes.ts`) */
  retroOutcomes(now: Date, days: number): Promise<RetroOutcomes>
  /** intake's entry for a loop (`intake.api.file` with the finding): the finding's key decides a repeat, never its words */
  file(body: SignalRequest, finding: LoopFinding): Promise<Result<Triaged, IntakeError>>
}

/** `retro`: what filing the retro signal came to, in words (it is not a friction pattern and has no row in the record). */
export type FrictionPass =
  | { due: false; lastAt: Date }
  | { due: true; trigger: PassTrigger; record: FrictionPassRecord; retro: string }

const reasonOf = (error: IntakeError): string => ('detail' in error ? `${error.kind}: ${error.detail}` : error.kind)

/**
 * One tick of the friction loop (no model): when no pass was recorded in the last day, or 200 Issues closed since the last
 * one (whichever comes first), count the last week's waste, file one
 * signal for each pattern over its threshold (at most `MAX_SIGNALS_PER_PASS`, the rest are named in the record) and
 * record the pass. A pattern is filed again only once a week has passed since its last Issue closed: intake's finding key
 * turns a repeat into a note on the open Issue, or drops it inside that week, which also makes a crash between filing
 * and recording replay safely.
 */
export async function frictionPass(deps: FrictionDeps): Promise<Result<FrictionPass, PortError>> {
  const now = deps.clock.now()
  const last = await deps.uow.run(async ({ loops }) => ok(await loops.lastFrictionPassAt()))
  if (!last.ok) return last
  let trigger = clockTrigger(last.value, now)
  if (trigger === null && last.value) {
    try {
      if (volumeDue(await deps.closedSince(last.value, now))) trigger = 'volume'
    } catch (error) {
      return err(portError('unreadable', `the closed Issues could not be counted: ${String(error).slice(0, 300)}`))
    }
  }
  if (trigger === null) return ok({ due: false, lastAt: last.value ?? now })

  const gated = await readGate(deps, { loop: 'friction', now })
  if (!gated.ok) return gated
  const gate = gated.value

  let model: FrictionModel
  let evidence: Record<string, string[]>
  let over: ReturnType<typeof withinBudget>
  let kpis: KpiReading[] = []
  let kpiFailure: string | null = null
  const held: Pattern[] = []
  try {
    model = await deps.friction(now)
    try {
      kpis = await deps.kpis({ from: new Date(model.window.from), to: new Date(model.window.to) })
    } catch (error) {
      // the KPIs are one input of the pass: a failed read is named in the record, the counts are still judged
      kpiFailure = `the KPIs could not be read: ${String(error).slice(0, 250)}`
    }
    // A KPI off its target leads: it is the figure the owner set a line for. A held class is named before the budget
    // counts: it does not use up a slot.
    const found = [...kpisOffTarget(kpis, { whole: model.since === null }), ...patternsOver(model.counts, model.closed)]
    const allowed = found.filter((pattern) => {
      if (gate.allows(pattern.key)) return true
      held.push(pattern)
      return false
    })
    over = withinBudget(allowed)
    const wanted = over.file.filter(hasIssueRefs).map((pattern) => pattern.key)
    evidence = wanted.length > 0 ? await deps.evidence(now, wanted) : {}
  } catch (error) {
    return err(portError('unreadable', `the friction counts could not be read: ${String(error).slice(0, 300)}`))
  }

  const facts = {
    from: model.window.from,
    to: model.window.to,
    days: model.days,
    since: model.since,
    issues: model.issues,
    closed: model.closed,
  }
  // what the Issues of earlier findings did: a pattern no longer counted is at 0, a KPI with no figure now is unmeasured,
  // and a KPI finding waits for the next pass when the KPIs could not be read (undefined)
  const counted = new Map(model.counts.map((count) => [count.key, count.count]))
  for (const kpi of kpis)
    if (kpi.measured && kpi.value !== null) counted.set(`kpi:${kpi.key}`, kpiFigure(kpi.target, kpi.value))
  const readNow = (key: string): number | null | undefined => {
    const figure = counted.get(key)
    if (figure !== undefined) return figure
    if (!key.startsWith('kpi:')) return 0
    return kpiFailure === null ? null : undefined
  }
  const settled = await settleClosed(deps, { loop: 'friction', now, read: (row) => readNow(row.key) })
  if (!settled.ok) return settled
  const ledger = settled.value
  const record: FrictionPassRecord = {
    id: deps.ids.next('friction'),
    at: now,
    windowFrom: new Date(model.window.from),
    windowTo: new Date(model.window.to),
    issues: model.issues,
    filed: [],
    overBudget: [...over.overBudget, ...held].map(({ key, count }) => ({ key, count })),
    failed: kpiFailure === null ? [] : [{ key: 'kpi', reason: kpiFailure }],
  }
  for (const pattern of over.file)
    await fileOne(deps, { gate, ledger, now }, pattern, facts, evidence[pattern.key] ?? [], record)
  const retro = await fileRetro(deps, model.window.to, now)

  const recorded = await deps.uow.run(async ({ loops }) => {
    await loops.recordFrictionPass(record)
    return ok(undefined)
  })
  if (!recorded.ok) return recorded
  return ok({ due: true, trigger, record, retro })
}

/**
 * The retro: one signal on this repo whose lead reviews the week (`domains/improve/retro.ts`). Filed after the patterns,
 * so a pattern is never held back by it; a failure is named in the pass line and never stops the pass. A replay is intake's
 * finding key: an amend of the open retro Issue, or a drop while one closed lately.
 */
async function fileRetro(deps: FrictionDeps, to: string, now: Date): Promise<string> {
  let lastFiled: Date | null
  try {
    lastFiled = await deps.retroFiledAt()
  } catch (error) {
    return `not filed: the last retro could not be read: ${String(error).slice(0, 200)}`
  }
  if (lastFiled && now.getTime() - lastFiled.getTime() < RETRO_EVERY_MS)
    return `not due (filed ${lastFiled.toISOString()})`
  let previous: RetroOutcomes | null = null
  try {
    previous = await deps.retroOutcomes(now, RETRO_WINDOW_DAYS)
  } catch {
    // the line about the earlier retros is a convenience: a failed read never keeps the retro from being filed
  }
  const filed = await deps.file(
    {
      from: FRICTION_SOURCE,
      kind: 'request',
      title: RETRO_TITLE,
      text: retroText({ to, days: RETRO_WINDOW_DAYS, previous }),
      repo: FRICTION_REPO,
      probe: false,
    },
    RETRO_FINDING,
  )
  if (!filed.ok) return `not filed: ${reasonOf(filed.error).slice(0, 200)}`
  return `${filed.value.outcome} (${filed.value.detail})`
}

async function fileOne(
  deps: FrictionDeps,
  { gate, ledger, now }: { gate: ClassGate; ledger: Ledger; now: Date },
  pattern: Pattern,
  facts: Parameters<typeof signalText>[1],
  refs: string[],
  record: FrictionPassRecord,
): Promise<void> {
  const title = signalTitle(pattern)
  const filed = await deps.file(
    {
      from: FRICTION_SOURCE,
      kind: 'request',
      title,
      text: signalText(pattern, facts, refs, ledger.lastTime(pattern.key, pattern.count)),
      repo: FRICTION_REPO,
      probe: false,
    },
    {
      loop: 'friction',
      class: classOf('friction', pattern.key),
      subject: pattern.key,
      repeatWindowMs: PATTERN_REPEAT_MS,
    },
  )
  if (!filed.ok) {
    record.failed.push({ key: pattern.key, reason: reasonOf(filed.error).slice(0, 300) })
    return
  }
  // A repeat of an Issue closed lately is intake recognising a known pattern; any other drop or hold means no Issue carries it.
  const { outcome, detail } = filed.value
  const stands = outcome === 'filed' || outcome === 'amended' || (outcome === 'dropped' && detail === 'repeat')
  if (stands) {
    record.filed.push({ key: pattern.key, count: pattern.count, title })
    const lost = await gate.record(filed.value.issue, pattern.key, FRICTION_REPO, {
      figure: pattern.count,
      signal: filed.value.signal,
      at: now,
    })
    if (lost) record.failed.push({ key: pattern.key, reason: `finding class not recorded: ${lost}`.slice(0, 300) })
  } else record.failed.push({ key: pattern.key, reason: `${outcome}: ${detail}`.slice(0, 300) })
}

export const frictionSummary = (pass: FrictionPass): string => {
  if (!pass.due) return `not due (last pass ${pass.lastAt.toISOString()})`
  const { record } = pass
  const parts = [`${pass.trigger} pass: filed ${record.filed.length} signal(s) for ${FRICTION_WINDOW_DAYS} days`]
  parts.push(`retro ${pass.retro}`)
  if (record.overBudget.length > 0) parts.push(`over budget, not filed: ${named(record.overBudget)}`)
  if (record.failed.length > 0) {
    parts.push(`failed: ${record.failed.map((f) => `${f.key} (${f.reason})`).join('; ')}`)
  }
  return parts.join('; ')
}

/**
 * Deterministic: the week's counts, one signal per pattern over its threshold. Due once a day or after 200 closed Issues,
 * read from the table; asked every 15 minutes. A pattern whose Issue closed within the week is not filed again, the retro is
 * filed once a week.
 */
export const frictionLoop = (wiring: LoopWiring, deps: FrictionDeps): LoopSpec =>
  passLoop(wiring, {
    name: 'friction',
    pass: () => frictionPass(deps),
    problems: (pass) => (pass.due ? pass.record.failed.map((f) => `${f.key}: ${f.reason}`) : null),
    summary: frictionSummary,
  })
