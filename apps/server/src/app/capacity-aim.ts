import { SAMPLE_MAX_AGE_MS } from '../domains/capacity/costs.ts'
import { loadTrip, SUSTAINED_LOAD_SAMPLES, sustainedSwapoutMb } from '../domains/capacity/host.ts'
import { type AimState, aimStep, leadAimStep, swapGrowing } from '../domains/capacity/slot-aim.ts'
import { slotCounts } from '../domains/capacity/slots.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import type { PlanningDeps } from './planning-deps.ts'

/** The minute rows are kept as long as the host samples they sit beside. */
const SLOT_SHADOW_KEEP_MS = 14 * 86_400_000

export interface SlotAimDeps extends PlanningDeps {
  /** `FACTORY_SLOTS`: the live rule's base slots, and where the aim starts */
  slots: number
  /** `FACTORY_SLOTS_MAX`: the ceiling of the aim */
  slotsMax: number
  /** the load ceiling of the lead admission: the slot aim's tripwire is set at it */
  loadCeiling: number
  /** the swapouts of 300 s above which the aim halves (`memoryCeilings.swapoutMbPer300s`) */
  swapoutCeilingMb?: number
  /** the queued Issues that only the lead aim holds back; null: unread. Absent or unread, the lead aim adds nothing */
  leadWaiters?: () => Promise<number | null>
}

/**
 * One minute of the slot aim, run by the host loop after it stored the sample: the aim moves by `aimStep` on the newest
 * host samples, and the minute's decision is stored beside the base slots (`slot_shadow`, which the self-watch's
 * `slot_line` and the capacity loop read). The count governs the grants of `app/capacity-slots.ts`; a step already running is
 * never touched.
 */
export async function slotAimPass(deps: SlotAimDeps): Promise<Result<string, PortError>> {
  // read outside the transaction: it is a look at the queue, which opens its own
  const leadWaiting = (await deps.leadWaiters?.().catch(() => null)) ?? null
  return deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    const now = deps.clock.now()
    const samples = await capacity.recentHostSamples(Math.max(5, SUSTAINED_LOAD_SAMPLES))
    const newest = samples[0]
    const fresh = newest !== undefined && now.getTime() - newest.at.getTime() <= SAMPLE_MAX_AGE_MS
    const before: AimState = (await capacity.slotAim()) ?? { target: deps.slots, quietSince: null }
    const { holders, waiters } = slotCounts(await capacity.slots(), now)
    const growing = fresh && swapGrowing(samples)
    const swapouts =
      fresh && deps.swapoutCeilingMb !== undefined && sustainedSwapoutMb(samples, now) > deps.swapoutCeilingMb
    const trip = loadTrip(samples, deps.loadCeiling, now, fresh ? newest.load : null)
    const step = aimStep(
      before,
      {
        at: now,
        pressureLevel: fresh ? newest.pressureLevel : null,
        swapGrowing: growing,
        load: fresh ? newest.load : null,
        loadTrip: trip,
        loadCeiling: deps.loadCeiling,
        waiters,
        swapouts,
      },
      deps.slotsMax,
    )
    await capacity.saveSlotAim(step.state, now)
    // The lead aim moves on the same signals: one verdict of the host, two counts it governs.
    const running = (await capacity.claims()).length
    const lead = leadAimStep(await capacity.leadAim(), {
      at: now,
      pressureLevel: fresh ? newest.pressureLevel : null,
      swapGrowing: growing,
      swapouts,
      load: fresh ? newest.load : null,
      loadTrip: trip,
      loadCeiling: deps.loadCeiling,
      running,
      waiting: leadWaiting ?? 0,
    })
    await capacity.saveLeadAim(lead.state)
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
      leadAim: lead.state.target,
      leadsRunning: running,
    })
    await capacity.pruneSlotShadow(new Date(now.getTime() - SLOT_SHADOW_KEEP_MS))
    return ok(
      `slot aim ${before.target} to ${step.state.target}: ${step.reason}; lead aim ${lead.state.target} for ${running} running: ${lead.reason}`,
    )
  })
}
