import { freeMibOf, growthMib, headroomMib, LEARNED_RUNS, learnedPeakMib } from '../domains/capacity/costs.ts'
import type { HostReader, StepCostRow } from '../domains/capacity/ports.ts'
import { type AimMode, LOAD_PER_CORE } from '../domains/capacity/slot-aim.ts'
import { releaseSlot, type SlotRow, type SlotView, slotLines, touchSlots } from '../domains/capacity/slots.ts'
import { DEFAULT_SLOT_RUN_MS, durationMs } from '../domains/planning/project.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import type { PlanningDeps } from './planning-deps.ts'

/** The project whose repo is the caller's directory (the longest repo wins, so a worktree matches). */
async function ownerOf(deps: PlanningDeps, cwd: string | undefined) {
  if (cwd === undefined) return undefined
  const found = await deps.uow.run(async ({ planning }) =>
    ok(
      (await planning.projects())
        .filter((p) => cwd === p.repo || cwd.startsWith(`${p.repo}/`))
        .sort((a, b) => b.repo.length - a.repo.length)[0],
    ),
  )
  return found.ok ? found.value : undefined
}

/** The run limit of a grant: the caller's own, else the `slots.run` of the project that owns the caller's directory, else the default. */
async function runLimitMs(
  deps: PlanningDeps,
  input: { cwd?: string | undefined; limitMs?: number | undefined },
): Promise<number> {
  if (input.limitMs !== undefined) return input.limitMs
  const run = (await ownerOf(deps, input.cwd))?.project.slots.run
  return (run ? durationMs(run) : undefined) ?? DEFAULT_SLOT_RUN_MS
}

export interface SlotDeps extends PlanningDeps {
  /** `FACTORY_SLOTS`: how many commands run their tests at once on this host */
  slots: number
  /** `FACTORY_SLOTS_MAX`: the most at once when memory and load allow */
  slotsMax: number
  /** `FACTORY_SLOT_EXTRA_LOAD`: the load up to which a step beyond the base slots is granted */
  slotExtraLoad: number
  host: HostReader
  /** `FACTORY_SLOT_AIM`: with `on`, the slot count is the aim's (1 to `slotsMax`) and the load gate twice the cores */
  slotAim: AimMode
  cores: number
}

/**
 * One call of `factory slot run`: a request for a slot and the renewal of the one it has. The first call makes the
 * caller a waiter, a waiter first in line with a slot free gets it, a holder's call renews the lease. Everything runs
 * behind the capacity lock.
 */
export async function touchSlot(
  deps: SlotDeps,
  input: {
    id: string
    name: string
    cwd?: string | undefined
    limitMs?: number | undefined
    rssMib?: number | undefined
    peakRssMib?: number | undefined
  },
): Promise<Result<SlotView, PortError>> {
  const runMs = await runLimitMs(deps, input)
  const [ram, load] = await Promise.all([deps.host.ramMib(), deps.host.load()])
  const ramMib = ram.ok ? ram.value : null
  return deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    const now = deps.clock.now()
    const rows = await capacity.slots()
    const holders = rows.filter((row) => row.slot !== null && (row.leasedUntil?.getTime() ?? 0) >= now.getTime())
    const learned = new Map<string, number | null>()
    for (const name of new Set([input.name, ...holders.map((row) => row.name)])) {
      learned.set(name, learnedPeakMib(await capacity.recentPeaks(name, LEARNED_RUNS)))
    }
    const freeMib = freeMibOf(await capacity.latestHostSample(), ramMib, now)
    const loadNow = load.ok ? load.value : null
    const aimed =
      deps.slotAim === 'on'
        ? Math.min(deps.slotsMax, Math.max(1, (await capacity.slotAim())?.target ?? deps.slots))
        : null
    const touched = touchSlots(
      rows,
      {
        id: input.id,
        name: input.name,
        slots: aimed ?? deps.slots,
        runMs,
        cwd: input.cwd,
        rssMib: input.rssMib,
        peakRssMib: input.peakRssMib,
        fit: {
          peakMib: learned.get(input.name) ?? null,
          freeMib,
          growthMib: growthMib(holders, learned),
          max: aimed ?? deps.slotsMax,
          loadOk: loadNow !== null && loadNow <= (aimed === null ? deps.slotExtraLoad : LOAD_PER_CORE * deps.cores),
          headroomMib: headroomMib(ramMib),
          load: loadNow === null ? null : Math.round(loadNow * 10) / 10,
          extraLoad: aimed === null ? deps.slotExtraLoad : LOAD_PER_CORE * deps.cores,
        },
      },
      now,
    )
    await capacity.saveSlots(touched.rows)
    return ok(touched.view)
  })
}

/** Appends a finished step to the cost ledger; the repo is the project owning the caller's directory. */
export async function recordStepCost(
  deps: PlanningDeps,
  input: Omit<StepCostRow, 'at' | 'repo'> & { cwd?: string | undefined },
): Promise<Result<true, PortError>> {
  const { cwd, ...cost } = input
  const repo = (await ownerOf(deps, cwd))?.repo ?? null
  return deps.uow.run(async ({ capacity }) => {
    await capacity.recordStepCost({ ...cost, at: deps.clock.now(), repo })
    return ok(true as const)
  })
}

/** Gives the slot back (or leaves the line). True if the caller had a row. */
export async function giveSlotBack(deps: PlanningDeps, id: string): Promise<Result<boolean, PortError>> {
  return deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    const released = releaseSlot(await capacity.slots(), id)
    if (released.had) await capacity.saveSlots(released.rows)
    return ok(released.had)
  })
}

export async function slotRows(deps: PlanningDeps): Promise<Result<{ rows: SlotRow[]; lines: string[] }, PortError>> {
  return deps.uow.run(async ({ capacity }) => {
    const rows = await capacity.slots()
    return ok({ rows, lines: slotLines(rows, deps.clock.now()) })
  })
}
