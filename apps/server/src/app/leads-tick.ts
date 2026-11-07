import type { TickAnswer } from '@software-factory/contract'
import type { EffectPorts } from '../domains/work/ports.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import { startLead } from './leads-start.ts'
import { noteLead } from './leads-note.ts'
import { finalizeLead } from './leads-finalize.ts'
import { followLeads } from './leads-follow.ts'
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
}

/**
 * One pass of the lead tick: the spool's lines are stored, the leads whose terminal is gone are found, then the outbox
 * runs (claim, call, record). Every step finds its own work done, so a pass twice in a row does nothing twice. A step
 * that fails does not hold the others back.
 */
export async function leadTick(deps: LeadTickDeps): Promise<Result<TickAnswer, PortError>> {
  const replayed = await deps.replaySpool().catch((error: unknown) => {
    console.error(`spool replay failed: ${error instanceof Error ? error.message : String(error)}`)
    return 0
  })
  const lost = await followLeads(deps.leads)
  const outbox = await runOutbox({ uow: deps.leads.uow, clock: deps.leads.clock, ports: deps.ports })
  if (!outbox.ok) return outbox
  return ok({ outbox: outbox.value, replayed, lost })
}
