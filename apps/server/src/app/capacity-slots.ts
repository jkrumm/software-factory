import {
  freeMibOf,
  growthMib,
  headroomMib,
  LEARNED_RUNS,
  learnedCores,
  learnedPeakMib,
  learnedRunMs,
  SAMPLE_MAX_AGE_MS,
  stepKindOf,
  stepNameOf,
  stepPrior,
} from '../domains/capacity/costs.ts'
import { DEFAULT_SWAPOUT_CEILING_MB, describeTrip, loadTrip, SUSTAINED_LOAD_SAMPLES } from '../domains/capacity/host.ts'
import type {
  HostReader,
  MergeWindowRow,
  PlacementReason,
  RemoteHostProbe,
  StepCostRow,
} from '../domains/capacity/ports.ts'
import {
  bareRepoOf,
  copyDirOf,
  decideRemote,
  expectedMiniWaitMs,
  finishesSooner,
  freeRemoteSlot,
  grantedCores,
  memoryCeilingMib,
  REMOTE_REFUSAL_WORDS,
} from '../domains/capacity/remote.ts'
import { type PressureBaseline, pressureThreshold } from '../kernel/remote-pressure.ts'
import { activeHold, HOLD_LOOKBACK_MS, holdOf, holdWords } from '../kernel/remote-hold.ts'
import { type AimMode, SWAP_WINDOW, swapGrowing } from '../domains/capacity/slot-aim.ts'
import {
  DEFAULT_PASS_AFTER_MS,
  DEFAULT_STEP_CORES,
  releaseSlot,
  SLOT_LEASE_MS,
  type SlotRow,
  type SlotView,
  type PeakFrom,
  slotLines,
  type StepHost,
  stepClassOf,
  touchSlots,
  type Waited,
  WAITER_TTL_MS,
} from '../domains/capacity/slots.ts'
import type { RemoteGrant } from '@software-factory/contract'
import { DEFAULT_SLOT_RUN_MS, durationMs, MINI_ONLY_NEEDS, type ProjectFile } from '@software-factory/contract/project'
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
  /**
   * The VPS that runs declared steps off the mini (`FACTORY_STEP_REMOTE_TARGET`), the projects the owner admitted to it
   * (`FACTORY_STEP_REMOTE_PROJECTS`) and its probe; null or absent: every step runs on the mini.
   */
  remote?: { target: string; projects: readonly string[]; probe: RemoteHostProbe } | null
}

/** A grant, and how to run it when it is off the mini. */
export type SlotGrant = SlotView & { remote: RemoteGrant | null }

/** The slot ids that held a VPS slot at the last call: the probe removes a step container of any other. */
const liveOnVps = new WeakMap<object, Set<string>>()

/** The newest probe reading stored as a baseline sample, per remote. */
const sampledAt = new WeakMap<object, number>()

/** The baseline the pressure lines come from, read at most this often (it is a day of samples). */
const BASELINE_REREAD_MS = 5 * 60_000
const baselines = new WeakMap<object, { at: number; value: PressureBaseline | null }>()

/**
 * Why the VPS did not take a waiting step at its last look, by slot id: the mini's grant says it (`no_room`, `not_sooner`).
 * Lost with a restart, then a step granted on the mini reads `free`; entries older than an hour are dropped.
 */
const refusedOnVps = new Map<string, { reason: PlacementReason; at: number }>()
const REFUSAL_KEPT_MS = 3_600_000

const onVps = (row: SlotRow): boolean => row.host === 'vps'

/**
 * One call of `factory slot run`: a request for a slot and the renewal of the one it has. The first call makes the
 * caller a waiter, a waiter first in line with a slot free gets it, a holder's call renews the lease. Everything runs
 * behind the capacity lock.
 *
 * Two hosts (issue 1793): the mini's line is as it was, over the rows that are not the VPS's. A caller that can run off
 * the mini (`remote`), whose project the owner admitted and whose step the project declares for the VPS, is granted a VPS
 * slot when the mini would make it wait, the VPS has room now (`decideRemote`) and finishes it sooner (`finishesSooner`).
 * A caller the VPS failed (`notOn`) goes back to the mini's line at its old place.
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
    remote?: boolean | undefined
    pin?: StepHost | undefined
    notOn?: readonly StepHost[] | undefined
    runningOn?: { host: StepHost; slot: number } | undefined
  },
): Promise<Result<SlotGrant, PortError>> {
  const runMs = await runLimitMs(deps, input)
  const projects = await projectsOf(deps)
  const [ram, load] = await Promise.all([deps.host.ramMib(), deps.host.load()])
  const ramMib = ram.ok ? ram.value : null
  const remote = deps.remote ?? null
  // the holders of the last call: none read yet after a start is not "no holders", so nothing is reaped until then
  const probed = remote ? remote.probe.latest(liveOnVps.get(remote) ?? null) : null
  return deps.uow.run(async ({ capacity }): Promise<Result<SlotGrant, PortError>> => {
    await capacity.lock()
    const now = deps.clock.now()
    const stored = await capacity.slots()
    const alive = (row: SlotRow): boolean =>
      row.slot === null
        ? row.seenAt.getTime() >= now.getTime() - WAITER_TTL_MS
        : (row.leasedUntil?.getTime() ?? 0) >= now.getTime()
    // A VPS holder the VPS failed goes back to the mini's line at its old place; one that renews keeps its slot.
    const failedOnVps = input.notOn?.includes('vps') === true
    const all = stored.map((row) =>
      row.id === input.id && onVps(row) && failedOnVps
        ? // its wait was recorded with the VPS grant: the mini's grant records only the wait from here
          {
            ...row,
            host: null,
            slot: null,
            leasedUntil: null,
            grantedAt: null,
            runMs: null,
            seenAt: now,
            waitSplit: {},
          }
        : row,
    )
    const vpsRows = all.filter((row) => onVps(row) && alive(row))
    const vpsHolders = vpsRows.filter((row) => row.slot !== null)
    // A lease that lapsed while the step ran (the server was away) is taken back on the VPS, as the mini's rule does: from
    // its stored row, or, once another caller's save dropped that row, from the slot the caller says it runs in. Never on
    // the mini, where the step does not run.
    const stillStored = all.find((row) => row.id === input.id && onVps(row) && (alive(row) || input.holding === true))
    const runningOnVps = input.holding === true && input.runningOn?.host === 'vps' ? input.runningOn.slot : null
    const mineOnVps =
      stillStored ??
      (runningOnVps === null
        ? undefined
        : {
            ...newWaiter(input, now),
            slot: runningOnVps,
            host: 'vps' as const,
            grantedAt: now,
            runMs,
          })
    if (remote)
      liveOnVps.set(
        remote,
        new Set([...vpsHolders.map((row) => row.id), ...(mineOnVps?.slot != null ? [input.id] : [])]),
      )
    if (mineOnVps?.slot != null) {
      const renewed: SlotRow = {
        ...mineOnVps,
        seenAt: now,
        leasedUntil: new Date(now.getTime() + SLOT_LEASE_MS),
      }
      await capacity.saveSlots([
        ...all.filter((row) => !onVps(row)),
        ...vpsRows.filter((r) => r.id !== input.id),
        renewed,
      ])
      return ok({ ...grantView(renewed, runMs), remote: null })
    }
    const rows = all.filter((row) => !onVps(row))
    const holders = rows.filter((row) => row.slot !== null && (row.leasedUntil?.getTime() ?? 0) >= now.getTime())
    const waiting = rows.filter((row) => row.slot === null && row.seenAt.getTime() >= now.getTime() - WAITER_TTL_MS)
    const ceiling = deps.swapoutCeilingMb ?? DEFAULT_SWAPOUT_CEILING_MB
    // The size of a step: what it is learned to peak at, else a prior from its project (`stepPrior`). A worktree's step is its
    // project's (`stepNameOf`), whose old rows under the worktree names seed the figure.
    // `runMs` is the mini's learned run (the line's order), `vpsRunMs` the VPS's; peak and cores are learned across hosts.
    type Size = {
      key: string
      mib: number
      from: PeakFrom
      cores: number
      runMs: number | null
      vpsRunMs: number | null
    }
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
      const measured = {
        cores: learnedCores(runs) ?? DEFAULT_STEP_CORES,
        runMs: learnedRunMs(runs.filter((run) => run.host === 'mini')),
        vpsRunMs: learnedRunMs(runs.filter((run) => run.host === 'vps')),
      }
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
    const heldPeakById = new Map<string, number | null>()
    for (const holder of holders) heldPeakById.set(holder.id, (await sizeOf(holder.name, holder.cwd)).mib)
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
    const owner = ownerIn(projects, input.cwd)
    const stated = remote ? declaredRemoteStep({ owner, key: mine.key, remote, input }) : null
    const eligible = stated !== null && typeof stated !== 'string'
    // red off the mini and green on it: the step stays home for a hold that doubles with each repeat within a week and
    // halves after a green run off the mini (`holdOf`)
    const held =
      eligible && input.holding !== true
        ? activeHold(holdOf(await capacity.holdEvents(mine.key, new Date(now.getTime() - HOLD_LOOKBACK_MS))), now)
        : null
    const declared =
      held === null
        ? stated
        : `it was red on the VPS and green on the mini; it stays on the mini for ${holdWords(held.holdMs)}, until ${held.until.toISOString()}`
    for (const [id, refusal] of refusedOnVps) if (now.getTime() - refusal.at > REFUSAL_KEPT_MS) refusedOnVps.delete(id)
    if (remote && probed) {
      // production's pressure at each reading, with how many step containers ran: the samples with none are the baseline
      if ((sampledAt.get(remote) ?? 0) < probed.reading.at.getTime()) {
        sampledAt.set(remote, probed.reading.at.getTime())
        await capacity.recordRemoteSample({
          at: probed.reading.at,
          memoryPressure: probed.reading.memoryPressure,
          ioPressure: probed.reading.ioPressure,
          stepsRunning: probed.steps.length,
        })
      }
    }
    let baseline = remote ? (baselines.get(remote) ?? null) : null
    if (remote && (baseline === null || now.getTime() - baseline.at >= BASELINE_REREAD_MS)) {
      baseline = { at: now.getTime(), value: await capacity.pressureBaseline(now) }
      baselines.set(remote, baseline)
    }
    // A caller pinned to the VPS (with a step that can run there) stays out of the mini's line, as a waiter of the VPS.
    const pinnedVps = input.pin === 'vps' && declared !== null && typeof declared !== 'string'
    const keep = all.filter((row) => onVps(row) && alive(row) && row.id !== input.id)
    const touched = pinnedVps
      ? null
      : touchSlots(
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
              heldPeakById,
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
              ...(aimed === null
                ? {}
                : { cores: deps.cores, stepCores: mine.cores, coresByName, heldCores, runMsByName }),
            },
          },
          now,
        )
    const record = async (waited: Waited | undefined, host: StepHost) => {
      if (waited)
        await capacity.recordSlotWait({
          at: now,
          name: input.name,
          repo: owner?.repo ?? null,
          cwd: input.cwd ?? null,
          outcome: 'granted',
          waitMs: waited.ms,
          split: waited.split,
          host,
        })
    }
    if (touched && (touched.view.granted || declared === null || typeof declared === 'string')) {
      await capacity.saveSlots([...touched.rows, ...keep])
      await record(touched.waited, 'mini')
      // a step the project declared remote, granted on the mini: said once, at the grant, with why it did not go
      if (eligible && touched.view.granted && input.holding !== true) {
        await capacity.recordPlacement({
          at: now,
          name: mine.key,
          host: 'mini',
          reason: held !== null ? 'held' : (refusedOnVps.get(input.id)?.reason ?? 'free'),
        })
        refusedOnVps.delete(input.id)
      }
      const why =
        !touched.view.granted && typeof declared === 'string' && touched.view.why !== null
          ? `${touched.view.why}; not on the VPS: ${declared}`
          : touched.view.why
      return ok({ ...touched.view, why, remote: null })
    }
    // The mini makes it wait (or it is pinned to the VPS): the VPS takes it if it has room and finishes it sooner.
    const vpsSized = await Promise.all(vpsHolders.map((row) => sizeOf(row.name, row.cwd)))
    const project = owner?.name ?? ''
    const projectSlots = new Set(
      vpsHolders.flatMap((row) =>
        ownerIn(projects, row.cwd ?? undefined)?.name === project && row.slot !== null ? [row.slot] : [],
      ),
    )
    const slot = freeRemoteSlot(projectSlots)
    const dir = copyDirOf(project, slot)
    const room = decideRemote({
      pressure: pressureThreshold(baseline?.value ?? null),
      reading: probed?.reading ?? null,
      now,
      holders: vpsSized.map((size) => ({ peakMib: size.mib, cores: size.cores })),
      step: { peakMib: mine.mib, cores: mine.cores },
      copyExists: probed?.copies.includes(dir) ?? false,
    })
    const median = medianOf([...runMsByName.values()]) ?? DEFAULT_SLOT_RUN_ESTIMATE_MS
    const remaining = await Promise.all(
      holders.map(async (row) => {
        const ran = now.getTime() - (row.grantedAt?.getTime() ?? now.getTime())
        return Math.max(0, ((await sizeOf(row.name, row.cwd)).runMs ?? median) - ran)
      }),
    )
    const sooner =
      pinnedVps ||
      finishesSooner({
        miniRunMs: mine.runMs,
        vpsRunMs: mine.vpsRunMs,
        expectedWaitMs: expectedMiniWaitMs({
          remainingMs: remaining,
          ahead: touched?.view.ahead ?? 0,
          medianRunMs: median,
        }),
      })
    const miniRows = touched?.rows ?? rows.filter((row) => row.id !== input.id && alive(row))
    if (!room.grant || !sooner || declared === null || typeof declared === 'string') {
      // the stable words, not the figures (`REMOTE_REFUSAL_WORDS`): the CLI prints a line whenever the reason changes
      const why = !room.grant
        ? `not on the VPS: ${REMOTE_REFUSAL_WORDS[room.kind]}`
        : 'the VPS would not finish it sooner than the mini'
      if (eligible)
        refusedOnVps.set(input.id, {
          reason: held !== null ? 'held' : !room.grant ? 'no_room' : 'not_sooner',
          at: now.getTime(),
        })
      if (touched) {
        const waitWhy = `${touched.view.why ?? 'waiting'}; ${why}`
        await capacity.saveSlots([...touched.rows, ...keep])
        return ok({ ...touched.view, why: waitWhy, remote: null })
      }
      // pinned to the VPS: it waits there alone, its own reason given
      const prior = all.find((row) => row.id === input.id)
      const waiter: SlotRow = {
        ...(prior ?? newWaiter(input, now)),
        seenAt: now,
        why,
        whyKind: 'slots',
        host: 'vps',
      }
      await capacity.saveSlots([...miniRows, ...keep, waiter])
      return ok({ ...grantView(waiter, runMs), why, remote: null })
    }
    // the caller's row as this call left it in the mini's line (its wait split brought up to now), else as stored
    const prior = all.find((row) => row.id === input.id)
    const base = touched?.rows.find((row) => row.id === input.id) ?? prior ?? newWaiter(input, now)
    const granted: SlotRow = {
      ...base,
      seenAt: now,
      slot,
      host: 'vps',
      leasedUntil: new Date(now.getTime() + SLOT_LEASE_MS),
      grantedAt: now,
      runMs,
      why: null,
      whyKind: null,
    }
    await capacity.saveSlots([...miniRows.filter((row) => row.id !== input.id), ...keep, granted])
    const waitedMs = Math.max(0, now.getTime() - base.requestedAt.getTime())
    await record(prior ? { ms: waitedMs, split: base.waitSplit } : undefined, 'vps')
    await capacity.recordPlacement({ at: now, name: mine.key, host: 'vps', reason: 'vps' })
    refusedOnVps.delete(input.id)
    return ok({
      ...grantView(granted, runMs),
      remote: {
        ...declared,
        repo: bareRepoOf(project),
        dir,
        memoryMib: memoryCeilingMib(mine.mib),
        cores: probed ? grantedCores(probed.reading) : 1,
      },
    })
  })
}

/** A run estimate when no step in the line has one learned: five minutes. */
const DEFAULT_SLOT_RUN_ESTIMATE_MS = 5 * 60_000

const medianOf = (values: readonly (number | null)[]): number | null => {
  const known = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
  return known.length === 0 ? null : (known[Math.floor((known.length - 1) / 2)] ?? null)
}

/** A first call's row: a waiter that asked now. */
const newWaiter = (input: { id: string; name: string; cwd?: string | undefined }, now: Date): SlotRow => ({
  id: input.id,
  name: input.name,
  requestedAt: now,
  seenAt: now,
  slot: null,
  leasedUntil: null,
  grantedAt: null,
  runMs: null,
  rssMib: null,
  peakRssMib: null,
  why: null,
  cwd: input.cwd ?? null,
  passedAt: null,
  passedBy: null,
  whyKind: null,
  waitSplit: {},
  host: null,
})

/** The view of a row the caller holds or waits in on the VPS. */
const grantView = (row: SlotRow, runMs: number): SlotView => ({
  id: row.id,
  name: row.name,
  granted: row.slot !== null,
  slot: row.slot,
  leaseMs: SLOT_LEASE_MS,
  ahead: 0,
  runMs: row.runMs ?? runMs,
  why: row.why,
  host: row.slot !== null && onVps(row) ? 'vps' : 'mini',
})

/**
 * The caller's step as the VPS may run it: the target, its image and what it carries; null when the caller cannot leave
 * the mini at all (an older CLI, pinned to the mini, the VPS failed it), else a string saying why this step stays on the
 * mini. Pinned to the VPS (`FACTORY_SLOT_HOST=vps`), a declared step goes whatever its `remote` says, never one that needs
 * what only the mini has.
 */
export function declaredRemoteStep(input: {
  owner: { name: string; project: ProjectFile } | undefined
  key: string
  remote: { target: string; projects: readonly string[] }
  input: { remote?: boolean | undefined; pin?: StepHost | undefined; notOn?: readonly StepHost[] | undefined }
}):
  | { target: string; bun: string | null; dockerfile: string | null; carry: string[]; network: boolean }
  | string
  | null {
  const { owner, key, remote } = input
  if (input.input.remote !== true || input.input.pin === 'mini' || input.input.notOn?.includes('vps')) return null
  if (!owner) return 'the step belongs to no project'
  if (!remote.projects.includes(owner.name))
    return `${owner.name} is not admitted to the VPS (FACTORY_STEP_REMOTE_PROJECTS)`
  const kind = stepKindOf(key)
  // an Apple step is the host's (its simulators and signing keychain), whatever a file says
  if (stepClassOf(key) === 'apple') return 'an apple step runs on the mini only'
  const step = key === `${owner.name} ${kind}` ? owner.project.steps[kind] : undefined
  if (!step) return `${owner.name}'s project.yaml declares no step "${kind}"`
  const held = step.needs.filter((need) => MINI_ONLY_NEEDS.includes(need))
  if (held.length > 0) return `the step "${kind}" needs ${held.join(', ')}, which only the mini has`
  if (!step.remote && input.input.pin !== 'vps') return `the step "${kind}" is not declared remote: true`
  if (step.needs.includes('browser') && step.dockerfile === undefined)
    return `the step "${kind}" needs a browser and names no dockerfile that has one`
  return {
    target: remote.target,
    bun: step.bun ?? null,
    dockerfile: step.dockerfile ?? null,
    carry: [...step.carry],
    network: step.needs.includes('network'),
  }
}

/** The signal a test that disagreed twice is filed with: a request to the repo that owns the test. */
export type DisagreementSignal = {
  from: string
  kind: 'request'
  title: string
  text: string
  repo: string
  probe: false
}

/** Files a signal; its fingerprint (repo and title) makes a repeat one Issue. Late-bound: intake is composed after planning. */
export type SignalFiler = (body: DisagreementSignal) => Promise<{ ok: boolean }>

/** What the signal for a test that disagreed again says: the test, its remote duration and the timeout its output named. */
export function disagreementSignal(input: {
  project: string
  step: string
  test: { name: string; durationMs: number; timeoutMs: number | null }
}): DisagreementSignal {
  const { project, step, test } = input
  const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`
  return {
    from: 'agent:software-factory',
    kind: 'request',
    title: `Test "${test.name}" fails on the step host and passes on the mini`,
    text: [
      `The step \`${step}\` ran red on the step host and green on the mini twice with the test "${test.name}" among its failures.`,
      `Its duration there: ${seconds(test.durationMs)}. Its timeout: ${test.timeoutMs === null ? 'not named in the output' : seconds(test.timeoutMs)}.`,
      "A test whose timeout a slower, shared host breaks is the repo's to fix (a longer timeout, or work that does not depend on speed); until then the step is held on the mini for longer after each repeat.",
    ].join('\n\n'),
    repo: project,
    probe: false,
  }
}

/**
 * Appends a finished step to the cost ledger; the repo is the project owning the caller's directory. A run on the mini
 * that found a red off the mini green and names a failing test the ledger holds a second disagreement for files one
 * signal to the project (after the transaction: a port is never called inside one).
 */
export async function recordStepCost(
  deps: PlanningDeps,
  input: Omit<StepCostRow, 'at' | 'repo' | 'cwd'> & { cwd?: string | undefined },
  file?: SignalFiler,
): Promise<Result<true, PortError>> {
  const { cwd, ...cost } = input
  const owner = await ownerOf(deps, cwd)
  const repo = owner?.repo ?? null
  const stored = await deps.uow.run(async ({ capacity }) => {
    // a worktree's step is stored under its project's name, so every lead's run teaches the same step
    const name = stepNameOf(cost.name, cwd, owner?.name)
    await capacity.recordStepCost({ ...cost, name, at: deps.clock.now(), repo, cwd: cwd ?? null })
    const again = []
    for (const test of cost.disagreed === true ? (cost.disagreement?.tests ?? []) : [])
      if ((await capacity.disagreementsOfTest(name, test.name)) === 2) again.push(test)
    return ok({ name, again })
  })
  if (!stored.ok) return stored
  if (file && owner)
    for (const test of stored.value.again) {
      const filed = await file(disagreementSignal({ project: owner.name, step: stored.value.name, test })).catch(
        () => ({ ok: false }),
      )
      // it fires once per test (the second disagreement), so a refusal is said, not retried
      if (!filed.ok)
        console.error(`steps: the signal for the test "${test.name}" of ${stored.value.name} was not filed`)
    }
  return ok(true as const)
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
