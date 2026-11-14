import { SAMPLE_MAX_AGE_MS } from '../domains/capacity/costs.ts'
import { type AimMode, type AimState, aimStep, swapGrowing } from '../domains/capacity/slot-aim.ts'
import { slotCounts } from '../domains/capacity/slots.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import type { PlanningDeps } from './planning-deps.ts'

/** Shadow rows are kept as long as the host samples they sit beside. */
export const SLOT_SHADOW_KEEP_MS = 14 * 86_400_000

export interface SlotAimDeps extends PlanningDeps {
  mode: AimMode
  /** `FACTORY_SLOTS`: the live rule's base slots, and where the aim starts */
  slots: number
  /** `FACTORY_SLOTS_MAX`: the ceiling of the aim */
  slotsMax: number
  cores: number
}

/**
 * One minute of the slot aim, run by the host loop after it stored the sample: the aim moves by `aimStep` on the newest
 * host samples, and the minute's decision is stored beside the live rule's slots (the shadow table the switch-on is
 * judged by). Under `off` nothing moves and nothing is stored. The count only governs grants under `on`
 * (`app/capacity-slots.ts`); a step already running is never touched.
 */
export async function slotAimPass(deps: SlotAimDeps): Promise<Result<string, PortError>> {
  if (deps.mode === 'off') return ok('slot aim is off')
  return deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    const now = deps.clock.now()
    const samples = await capacity.recentHostSamples(5)
    const newest = samples[0]
    const fresh = newest !== undefined && now.getTime() - newest.at.getTime() <= SAMPLE_MAX_AGE_MS
    const before: AimState = (await capacity.slotAim()) ?? { target: deps.slots, quietSince: null }
    const { holders, waiters } = slotCounts(await capacity.slots(), now)
    const growing = fresh && swapGrowing(samples)
    const step = aimStep(
      before,
      {
        at: now,
        pressureLevel: fresh ? newest.pressureLevel : null,
        swapGrowing: growing,
        load: fresh ? newest.load : null,
        cores: deps.cores,
        waiters,
      },
      deps.slotsMax,
    )
    await capacity.saveSlotAim(step.state, now)
    await capacity.recordSlotShadow({
      at: now,
      liveSlots: deps.slots,
      liveMax: deps.slotsMax,
      aimSlots: step.state.target,
      holders,
      waiters,
      pressureLevel: fresh ? newest.pressureLevel : null,
      swapUsedPct: fresh ? newest.swapUsedPct : null,
      swapoutMbPer300s: fresh ? newest.swapoutMbPer300s : null,
      swapGrowing: growing,
      load: fresh ? newest.load : null,
      reason: step.reason,
    })
    await capacity.pruneSlotShadow(new Date(now.getTime() - SLOT_SHADOW_KEEP_MS))
    return ok(`slot aim ${before.target} to ${step.state.target} (${deps.mode}): ${step.reason}`)
  })
}
