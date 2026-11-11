import type { FrictionModel, SignalRequest } from '@software-factory/contract'
import { RETRO_TITLE, RETRO_WINDOW_DAYS, retroText } from '../../domains/loops/retro.ts'
import {
  FRICTION_PASS_EVERY_MS,
  FRICTION_WINDOW_DAYS,
  hasIssueRefs,
  named,
  type Pattern,
  patternsOver,
  signalText,
  signalTitle,
  withinBudget,
} from '../../domains/loops/friction.ts'
import type { FrictionPassRecord, LoopReads, LoopStore } from '../../domains/loops/ports.ts'
import type { Triaged } from '../../domains/intake/model.ts'
import type { Clock } from '../../kernel/clock.ts'
import type { IdSource } from '../../kernel/ids.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import type { IntakeError } from '../intake.ts'
import type { UnitOfWork } from '../unit-of-work.ts'
import { readGate, type ClassGate } from './gate.ts'

/** The repo that carries the factory's own findings, and who files them. */
export const FRICTION_REPO = 'software-factory'
export const FRICTION_SOURCE = `agent:${FRICTION_REPO}`

export interface FrictionDeps {
  uow: UnitOfWork<{ loops: LoopStore; loopReads: LoopReads }>
  clock: Clock
  ids: IdSource
  /** the counts of the last `FRICTION_WINDOW_DAYS` days ending at `now` (`read/friction.ts`, bound in `main.ts`) */
  friction(now: Date): Promise<FrictionModel>
  /** the most recent Issue refs behind the counts of these keys, for the same window */
  evidence(now: Date, keys: string[]): Promise<Record<string, string[]>>
  /** intake's entry for an agent (`intake.api.file`): its fingerprint rules decide a repeat */
  file(body: SignalRequest): Promise<Result<Triaged, IntakeError>>
}

/** `retro`: what filing the weekly retro signal came to, in words (it is not a friction pattern and has no row in the record). */
export type FrictionPass = { due: false; lastAt: Date } | { due: true; record: FrictionPassRecord; retro: string }

const reasonOf = (error: IntakeError): string => ('detail' in error ? `${error.kind}: ${error.detail}` : error.kind)

/**
 * One tick of the friction loop (no model): when no pass was recorded in the last week, count the week's waste, file one
 * signal for each pattern over its threshold (at most `MAX_SIGNALS_PER_PASS`, the rest are named in the record) and
 * record the pass. A crash between filing and recording replays safely: intake's fingerprint turns a repeat into a note
 * on the open Issue, or drops it when that Issue closed lately.
 */
export async function frictionPass(deps: FrictionDeps): Promise<Result<FrictionPass, PortError>> {
  const now = deps.clock.now()
  const last = await deps.uow.run(async ({ loops }) => ok(await loops.lastFrictionPassAt()))
  if (!last.ok) return last
  if (last.value && last.value.getTime() > now.getTime() - FRICTION_PASS_EVERY_MS) {
    return ok({ due: false, lastAt: last.value })
  }

  const gated = await readGate(deps, { loop: 'friction', now })
  if (!gated.ok) return gated
  const gate = gated.value

  let model: FrictionModel
  let evidence: Record<string, string[]>
  let over: ReturnType<typeof withinBudget>
  const held: Pattern[] = []
  try {
    model = await deps.friction(now)
    // A held class is named before the budget counts: it does not use up a slot.
    const allowed = patternsOver(model.counts, model.closed).filter((pattern) => {
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
  const record: FrictionPassRecord = {
    id: deps.ids.next('friction'),
    at: now,
    windowFrom: new Date(model.window.from),
    windowTo: new Date(model.window.to),
    issues: model.issues,
    filed: [],
    overBudget: [...over.overBudget, ...held].map(({ key, count }) => ({ key, count })),
    failed: [],
  }
  for (const pattern of over.file) await fileOne(deps, gate, pattern, facts, evidence[pattern.key] ?? [], record)
  const retro = await fileRetro(deps, model.window.to)

  const recorded = await deps.uow.run(async ({ loops }) => {
    await loops.recordFrictionPass(record)
    return ok(undefined)
  })
  if (!recorded.ok) return recorded
  return ok({ due: true, record, retro })
}

/**
 * The weekly retro: one signal on this repo whose lead reviews the week (`domains/loops/retro.ts`). Filed after the patterns,
 * so a pattern is never held back by it; a failure is named in the pass line and never stops the pass. A replay is intake's
 * fingerprint: an amend of the open retro Issue, or a drop while one closed lately.
 */
async function fileRetro(deps: FrictionDeps, to: string): Promise<string> {
  const filed = await deps.file({
    from: FRICTION_SOURCE,
    kind: 'request',
    title: RETRO_TITLE,
    text: retroText({ to, days: RETRO_WINDOW_DAYS }),
    repo: FRICTION_REPO,
    probe: false,
  })
  if (!filed.ok) return `not filed: ${reasonOf(filed.error).slice(0, 200)}`
  return `${filed.value.outcome} (${filed.value.detail})`
}

async function fileOne(
  deps: FrictionDeps,
  gate: ClassGate,
  pattern: Pattern,
  facts: Parameters<typeof signalText>[1],
  refs: string[],
  record: FrictionPassRecord,
): Promise<void> {
  const title = signalTitle(pattern)
  const filed = await deps.file({
    from: FRICTION_SOURCE,
    kind: 'request',
    title,
    text: signalText(pattern, facts, refs),
    repo: FRICTION_REPO,
    probe: false,
  })
  if (!filed.ok) {
    record.failed.push({ key: pattern.key, reason: reasonOf(filed.error).slice(0, 300) })
    return
  }
  // A repeat of an Issue closed lately is intake recognising a known pattern; any other drop or hold means no Issue carries it.
  const { outcome, detail } = filed.value
  const stands = outcome === 'filed' || outcome === 'amended' || (outcome === 'dropped' && detail === 'repeat')
  if (stands) {
    record.filed.push({ key: pattern.key, count: pattern.count, title })
    const lost = await gate.record(filed.value.issue, pattern.key, FRICTION_REPO)
    if (lost) record.failed.push({ key: pattern.key, reason: `finding class not recorded: ${lost}`.slice(0, 300) })
  } else record.failed.push({ key: pattern.key, reason: `${outcome}: ${detail}`.slice(0, 300) })
}

export const frictionSummary = (pass: FrictionPass): string => {
  if (!pass.due) return `not due (last pass ${pass.lastAt.toISOString()})`
  const { record } = pass
  const parts = [`filed ${record.filed.length} signal(s) for ${FRICTION_WINDOW_DAYS} days`]
  parts.push(`retro ${pass.retro}`)
  if (record.overBudget.length > 0) parts.push(`over budget, not filed: ${named(record.overBudget)}`)
  if (record.failed.length > 0) {
    parts.push(`failed: ${record.failed.map((f) => `${f.key} (${f.reason})`).join('; ')}`)
  }
  return parts.join('; ')
}
