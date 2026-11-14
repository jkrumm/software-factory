import type { TickAnswer } from '@software-factory/contract'
import type { EffectPorts } from '../domains/work/ports.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import { startLead } from './leads-start.ts'
import { noteLead } from './leads-note.ts'
import { finalizeLead } from './leads-finalize.ts'
import { followLeads } from './leads-follow.ts'
import { type ApiErrorMemory, handleApiErrors } from './leads-api-errors.ts'
import { type LeadDeps } from './leads.ts'
import { runOutbox } from './outbox.ts'

/** The effect ports the leads bring; the composition adds the other packages' (`start_watch` is quality's). */
export function leadPorts(deps: LeadDeps): Pick<EffectPorts, 'start_lead' | 'note_lead' | 'finalize'> {
  return {
    start_lead: (effect) => startLead(deps, effect),
    note_lead: (effect) => noteLead(deps, effect),
    finalize: (effect) => finalizeLead(deps, effect),
  }
}

export interface LeadTickDeps {
  leads: LeadDeps
  ports: EffectPorts
  /** stores what the hooks spooled since the last pass; returns how many lines were new */
  replaySpool: () => Promise<number>
  /** what the API-error path keeps between passes */
  apiErrorMemory: ApiErrorMemory
  /** the server's drain: once aborted, the pass starts no further step */
  signal?: AbortSignal
}

/**
 * One pass of the lead tick: the spool's lines are stored, the leads whose terminal is gone are found (and the tabs of those that run named), the sessions whose turn ended on an API error are found and answered, then the outbox
 * runs (claim, call, record). Every step finds its own work done, so a pass twice in a row does nothing twice. A step
 * that fails does not hold the others back.
 */
export async function leadTick(deps: LeadTickDeps): Promise<Result<TickAnswer, PortError>> {
  const replayed = await deps.replaySpool().catch((error: unknown) => {
    console.error(`spool replay failed: ${error instanceof Error ? error.message : String(error)}`)
    return 0
  })
  // A drain ends the pass before its next step, never inside one: every step finds its own work done, so the next boot
  // takes up what was skipped, and an effect is claimed (leased for minutes) only when it is about to run.
  const draining = () => deps.signal?.aborted === true
  const lost = draining() ? 0 : await followLeads(deps.leads, deps.signal)
  // Before the outbox: a note waiting on a session that ended on an API error is typed in this very pass, not the next.
  const apiErrors = draining()
    ? { detected: 0, resumed: 0, marked: 0, cleared: 0, edges: 0 }
    : await handleApiErrors(deps.leads, deps.apiErrorMemory).catch((error: unknown) => {
        console.error(`api error path failed: ${error instanceof Error ? error.message : String(error)}`)
        return { detected: 0, resumed: 0, marked: 0, cleared: 0, edges: 0 }
      })
  if (draining()) return ok({ outbox: { ran: 0, failed: 0 }, replayed, lost, apiErrors })
  const outbox = await runOutbox({
    uow: deps.leads.uow,
    clock: deps.leads.clock,
    ports: deps.ports,
    ...(deps.signal ? { signal: deps.signal } : {}),
  })
  if (!outbox.ok) return outbox
  return ok({ outbox: outbox.value, replayed, lost, apiErrors })
}
