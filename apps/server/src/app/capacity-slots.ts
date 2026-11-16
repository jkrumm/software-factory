import {
  freeMibOf,
  growthMib,
  headroomMib,
  LEARNED_RUNS,
  learnedCores,
  learnedPeakMib,
  learnedRunMs,
  SAMPLE_MAX_AGE_MS,
  stepNameOf,
  stepPrior,
} from '../domains/capacity/costs.ts'
import { DEFAULT_SWAPOUT_CEILING_MB, describeTrip, loadTrip, SUSTAINED_LOAD_SAMPLES } from '../domains/capacity/host.ts'
import type { HostReader, MergeWindowRow, StepCostRow } from '../domains/capacity/ports.ts'
import { type AimMode, SWAP_WINDOW, swapGrowing } from '../domains/capacity/slot-aim.ts'
import {
  DEFAULT_PASS_AFTER_MS,
  DEFAULT_STEP_CORES,
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
   * that is less), and a slot beyond the base keeps its learned-peak fit, fits the learned cores of the running steps and
   * its own into the host's cores, and is held back by the load tripwire (`loadTrip`), not by one peak; the line is
   * ordered by the learned runs (`lineOrder`)
   */
  slotAim: AimMode
  /** the cores the steps beyond the base share under the aim */
  cores: number
  /** the lead admission's load ceiling: under the aim, the tripwire for a slot beyond the base is set at it */
  loadCeiling: number
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
    type Size = { key: string; mib: number; from: PeakFrom; cores: number; runMs: number | null }
    const sized = new Map<string, Size>()
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
      const runs = await capacity.recentRuns(key, LEARNED_RUNS, ceiling, legacy)
      const learnedMib = learnedPeakMib(runs.map((run) => run.peakRssMib))
      const measured = { cores: learnedCores(runs) ?? DEFAULT_STEP_CORES, runMs: learnedRunMs(runs) }
      let result: Size
      if (learnedMib !== null) result = { key, mib: learnedMib, from: 'learned', ...measured }
      else {
        let steps = owner ? projectSteps.get(owner.repo) : undefined
        if (owner && !steps) {
          const since = new Date(now.getTime() - PRIOR_WINDOW_MS)
          const peaks = await capacity.projectPeaks(owner.repo, owner.name, since, LEARNED_RUNS, ceiling)
          steps = new Map([...peaks].map(([step, list]) => [step, learnedPeakMib(list)]))
          projectSteps.set(owner.repo, steps)
        }
        const prior = stepPrior(key, steps ?? new Map())
        result = { key, mib: prior.mib, from: prior.from, ...measured }
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
    const coresByName = new Map<string, number>()
    const runMsByName = new Map<string, number | null>()
    for (const waiter of [...waiting, { name: input.name, cwd: input.cwd ?? null }]) {
      const size = await sizeOf(waiter.name, waiter.cwd)
      peaksByName.set(waiter.name, size.mib)
      peakFromByName.set(waiter.name, size.from)
      coresByName.set(waiter.name, size.cores)
      runMsByName.set(waiter.name, size.runMs)
    }
    let heldCores = 0
    for (const holder of holders) heldCores += (await sizeOf(holder.name, holder.cwd)).cores
    const growth = growthMib(
      await Promise.all(holders.map(async (h) => ({ name: (await sizeOf(h.name, h.cwd)).key, rssMib: h.rssMib }))),
      learned,
    )
    const hostSamples = await capacity.recentHostSamples(Math.max(SWAP_WINDOW, SUSTAINED_LOAD_SAMPLES))
    const newestSample = hostSamples[0]
    const freeMib = freeMibOf(newestSample ?? null, ramMib, now)
    const swapRising =
      newestSample !== undefined &&
      now.getTime() - newestSample.at.getTime() <= SAMPLE_MAX_AGE_MS &&
      swapGrowing(hostSamples)
    const loadNow = load.ok ? load.value : null
    // Under the aim a slot beyond the base is held back by the tripwire (minutes on end over the load ceiling), never by
    // one peak; an unknown trip (too few samples) reads the instant against the ceiling.
    const trip = loadTrip(hostSamples, deps.loadCeiling, now, loadNow)
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
          loadOk:
            aimed === null
              ? loadNow !== null && loadNow <= deps.slotExtraLoad
              : trip === null
                ? loadNow !== null && loadNow <= deps.loadCeiling
                : !trip.tripped,
          ...(aimed !== null && trip?.tripped ? { loadWhy: describeTrip(trip.loads, deps.loadCeiling) } : {}),
          headroomMib: headroomMib(ramMib),
          swapGrowing: swapRising,
          load: loadNow === null ? null : Math.round(loadNow * 10) / 10,
          extraLoad: aimed === null ? deps.slotExtraLoad : deps.loadCeiling,
          extraLoadFrom:
            aimed === null
              ? 'FACTORY_SLOT_EXTRA_LOAD'
              : 'the load ceiling, too few minute samples for the tripwire; FACTORY_SLOT_EXTRA_LOAD is not read',
          ...(aimed === null ? {} : { cores: deps.cores, stepCores: mine.cores, coresByName, heldCores, runMsByName }),
        },
      },
      now,
    )
    await capacity.saveSlots(touched.rows)
    if (touched.waited)
      await capacity.recordSlotWait({
        at: now,
        name: input.name,
        repo: ownerIn(projects, input.cwd)?.repo ?? null,
        cwd: input.cwd ?? null,
        outcome: 'granted',
        waitMs: touched.waited.ms,
        split: touched.waited.split,
      })
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
  const projects = await projectsOf(deps)
  return deps.uow.run(async ({ capacity }) => {
    await capacity.lock()
    const rows = await capacity.slots()
    const released = releaseSlot(rows, id)
    if (released.had) await capacity.saveSlots(released.rows)
    // a waiter that leaves the line without a slot still waited: its split is the answer to what the line cost it
    const left = rows.find((row) => row.id === id)
    if (left?.slot === null && Object.keys(left.waitSplit).length > 0)
      await capacity.recordSlotWait({
        at: deps.clock.now(),
        name: left.name,
        repo: ownerIn(projects, left.cwd ?? undefined)?.repo ?? null,
        cwd: left.cwd,
        outcome: 'gave_up',
        waitMs: Object.values(left.waitSplit).reduce((sum, v) => sum + v, 0),
        split: left.waitSplit,
      })
    return ok(released.had)
  })
}

export async function slotRows(deps: PlanningDeps): Promise<Result<{ rows: SlotRow[]; lines: string[] }, PortError>> {
  return deps.uow.run(async ({ capacity }) => {
    const rows = await capacity.slots()
    return ok({ rows, lines: slotLines(rows, deps.clock.now()) })
  })
}
