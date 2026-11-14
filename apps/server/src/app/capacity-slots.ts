import {
  freeMibOf,
  growthMib,
  headroomMib,
  LEARNED_RUNS,
  learnedPeakMib,
  SAMPLE_MAX_AGE_MS,
  stepNameOf,
  stepPrior,
} from '../domains/capacity/costs.ts'
import { DEFAULT_SWAPOUT_CEILING_MB } from '../domains/capacity/host.ts'
import type { HostReader, MergeWindowRow, StepCostRow } from '../domains/capacity/ports.ts'
import { type AimMode, LOAD_PER_CORE, SWAP_WINDOW, swapGrowing } from '../domains/capacity/slot-aim.ts'
import {
  DEFAULT_PASS_AFTER_MS,
  releaseSlot,
  type SlotRow,
  type SlotView,
  type PeakFrom,
  slotLines,
  touchSlots,
  WAITER_TTL_MS,
} from '../domains/capacity/slots.ts'
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

async function projectsOf(deps: PlanningDeps) {
  const found = await deps.uow.run(async ({ planning }) => ok(await planning.projects()))
  return found.ok ? found.value : []
}

/** The project whose repo is `cwd` or contains it (the longest repo wins, so a worktree matches). */
function ownerIn<P extends { repo: string }>(projects: readonly P[], cwd: string | undefined): P | undefined {
  if (cwd === undefined) return undefined
  return projects
    .filter((p) => cwd === p.repo || cwd.startsWith(`${p.repo}/`))
    .sort((a, b) => b.repo.length - a.repo.length)[0]
}

/** Only the runs of the last two weeks size a step that has none of its own. */
const PRIOR_WINDOW_MS = 14 * 86_400_000

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
  /**
   * `FACTORY_SLOT_AIM`: with `on`, the aim (1 to `slotsMax`) is the cap, the base stays `slots` (lowered to the aim when
   * that is less), and a slot beyond the base keeps its learned-peak fit with the load gate at twice the cores
   */
  slotAim: AimMode
  cores: number
  /** `FACTORY_SLOT_PASS_MIN` in ms: how long a waiter may be passed by smaller steps before nothing passes it */
  slotPassMs?: number
  /** the swapout rate above which a finished run's peak is not learned from */
  swapoutCeilingMb?: number
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
    holding?: boolean | undefined
  },
): Promise<Result<SlotView, PortError>> {
  const runMs = await runLimitMs(deps, input)
  const projects = await projectsOf(deps)
  const [ram, load] = await Promise.all([deps.host.ramMib(), deps.host.load()])
  const ramMib = ram.ok ? ram.value : null
  return deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    const now = deps.clock.now()
    const rows = await capacity.slots()
    const holders = rows.filter((row) => row.slot !== null && (row.leasedUntil?.getTime() ?? 0) >= now.getTime())
    const waiting = rows.filter((row) => row.slot === null && row.seenAt.getTime() >= now.getTime() - WAITER_TTL_MS)
    const ceiling = deps.swapoutCeilingMb ?? DEFAULT_SWAPOUT_CEILING_MB
    // The size of a step: what it is learned to peak at, else a prior from its project (`stepPrior`). A worktree's step is its
    // project's (`stepNameOf`), whose old rows under the worktree names seed the figure.
    const sized = new Map<string, { key: string; mib: number; from: PeakFrom }>()
    const projectSteps = new Map<string, Map<string, number | null>>()
    const sizeOf = async (name: string, cwd: string | null | undefined) => {
      const owner = ownerIn(projects, cwd ?? undefined)
      const key = stepNameOf(name, cwd, owner?.name)
      const cacheKey = `${owner?.repo ?? ''}\n${key}`
      const cached = sized.get(cacheKey)
      if (cached) return cached
      const legacy =
        owner && key.startsWith(`${owner.name} `)
          ? { repo: owner.repo, words: key.slice(owner.name.length) }
          : undefined
      const learnedMib = learnedPeakMib(await capacity.recentPeaks(key, LEARNED_RUNS, ceiling, legacy))
      let result: { key: string; mib: number; from: PeakFrom }
      if (learnedMib !== null) result = { key, mib: learnedMib, from: 'learned' }
      else {
        let steps = owner ? projectSteps.get(owner.repo) : undefined
        if (owner && !steps) {
          const since = new Date(now.getTime() - PRIOR_WINDOW_MS)
          const peaks = await capacity.projectPeaks(owner.repo, owner.name, since, LEARNED_RUNS, ceiling)
          steps = new Map([...peaks].map(([step, list]) => [step, learnedPeakMib(list)]))
          projectSteps.set(owner.repo, steps)
        }
        const prior = stepPrior(key, steps ?? new Map())
        result = { key, mib: prior.mib, from: prior.from }
      }
      sized.set(cacheKey, result)
      return result
    }
    const mine = await sizeOf(input.name, input.cwd)
    const learned = new Map<string, number | null>()
    for (const holder of holders)
      learned.set((await sizeOf(holder.name, holder.cwd)).key, (await sizeOf(holder.name, holder.cwd)).mib)
    const peaksByName = new Map<string, number | null>()
    const peakFromByName = new Map<string, PeakFrom>()
    for (const waiter of waiting) {
      const size = await sizeOf(waiter.name, waiter.cwd)
      peaksByName.set(waiter.name, size.mib)
      peakFromByName.set(waiter.name, size.from)
    }
    const growth = growthMib(
      await Promise.all(holders.map(async (h) => ({ name: (await sizeOf(h.name, h.cwd)).key, rssMib: h.rssMib }))),
      learned,
    )
    const hostSamples = await capacity.recentHostSamples(SWAP_WINDOW)
    const newestSample = hostSamples[0]
    const freeMib = freeMibOf(newestSample ?? null, ramMib, now)
    const swapRising =
      newestSample !== undefined &&
      now.getTime() - newestSample.at.getTime() <= SAMPLE_MAX_AGE_MS &&
      swapGrowing(hostSamples)
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
        slots: aimed === null ? deps.slots : Math.min(deps.slots, aimed),
        runMs,
        cwd: input.cwd,
        rssMib: input.rssMib,
        peakRssMib: input.peakRssMib,
        holding: input.holding,
        passAfterMs: deps.slotPassMs ?? DEFAULT_PASS_AFTER_MS,
        fit: {
          peakMib: mine.mib,
          peakFrom: mine.from,
          peaksByName,
          peakFromByName,
          freeMib,
          growthMib: growth,
          max: aimed ?? deps.slotsMax,
          loadOk: loadNow !== null && loadNow <= (aimed === null ? deps.slotExtraLoad : LOAD_PER_CORE * deps.cores),
          headroomMib: headroomMib(ramMib),
          swapGrowing: swapRising,
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
  input: Omit<StepCostRow, 'at' | 'repo' | 'cwd'> & { cwd?: string | undefined },
): Promise<Result<true, PortError>> {
  const { cwd, ...cost } = input
  const owner = await ownerOf(deps, cwd)
  const repo = owner?.repo ?? null
  return deps.uow.run(async ({ capacity }) => {
    // a worktree's step is stored under its project's name, so every lead's run teaches the same step
    const name = stepNameOf(cost.name, cwd, owner?.name)
    await capacity.recordStepCost({ ...cost, name, at: deps.clock.now(), repo, cwd: cwd ?? null })
    return ok(true as const)
  })
}

/** Appends a finished `factory merge-lock` call (its wait and its hold) to the merge-window ledger. */
export async function recordMergeWindow(
  deps: PlanningDeps,
  input: Omit<MergeWindowRow, 'cwd'> & { cwd?: string | undefined },
): Promise<Result<true, PortError>> {
  const { cwd, ...window } = input
  return deps.uow.run(async ({ capacity }) => {
    await capacity.recordMergeWindow({ ...window, cwd: cwd ?? null })
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
