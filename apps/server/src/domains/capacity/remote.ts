/**
 * Steps off the mini (issue 1793, docs/architecture.md "Steps off the mini"). A step its project declares for the VPS goes
 * there when the mini cannot grant it now, the VPS has room for it now, and the VPS finishes it sooner. There is no fixed
 * share of the VPS: a step takes what its live reading shows free, and production wins by priority (the container's lowest
 * CPU weight and its first place for the OOM killer, `apps/cli/src/remote-step.ts`), so the reading only has to keep the
 * VPS out of swap and its disk under the infra alert's line.
 */
import { headroomMib } from './costs.ts'

/** What the VPS reported at its newest probe (`ssh <target>`: /proc/meminfo, /proc/loadavg, nproc, df of the home). */
export interface RemoteReading {
  at: Date
  cores: number
  /** the 1-minute load average */
  load1: number
  ramMib: number
  /** MemAvailable */
  availableMib: number
  diskSizeBytes: number
  diskUsedBytes: number
  /**
   * Production's own pressure stall (`system.slice`'s memory and io `some avg10`, percent): the steps run in their own
   * slice, so their own reclaim does not read as production being squeezed. Null: not readable.
   */
  memoryPressure: number | null
  ioPressure: number | null
}

/** Production stalled this share of the last 10 s on memory or io: no new step goes to the VPS until it settles. */
export const PRESSURE_TRIPWIRE_PCT = 10

/** A reading older than this says nothing of the VPS now, and an unreachable VPS has none newer: no step goes there. */
export const REMOTE_READING_MAX_AGE_MS = 90_000

/**
 * The share of the disk no step may push the VPS past: the line the infra disk alert pages on (`config/infra.json`
 * `defaults.disk.pct`, 90 %). A step that would cross it would page the owner for the factory's own copies.
 */
export const DISK_CEILING_PCT = 90

/**
 * What one copy of a project takes on the VPS when it is new: the tree, its `node_modules` and its share of the bun cache.
 * Measured for basalt-ui on 2026-11-17: 0.2 GiB of tree, 1.5 GiB of `node_modules`, 1.5 GiB of cache.
 */
export const COPY_BYTES = 3.2 * 1024 ** 3

/** The VPS is about 1.7 times slower per step (basalt-ui unit, 701 s against the mini's 412 s p50, 2026-11-17). */
export const VPS_SLOWDOWN = 1.7

/** The least memory a step container gets, whatever its learned peak. */
export const MIN_CEILING_MIB = 1024

/** A step's memory ceiling on the VPS: 1.5 times its learned peak, at least 1 GiB. A runaway stops there, not in production. */
export const memoryCeilingMib = (peakMib: number): number => Math.max(MIN_CEILING_MIB, Math.ceil(peakMib * 1.5))

/** A step as the VPS's fit weighs it. */
export interface RemoteStep {
  peakMib: number
  cores: number
}

/** A step holding a VPS slot: its learned peak and cores, and what its container holds now (unknown: its peak). */
export interface RemoteHolder {
  peakMib: number
  cores: number
}

const gib = (mib: number): string => `${(mib / 1024).toFixed(1)} GiB`

/** Why the VPS takes no step now. */
export type RemoteRefusal = 'probe' | 'pressure' | 'disk' | 'memory' | 'cores'

/**
 * The refusal as a waiter's reason says it: no figures, because `factory slot run` prints a line each time the reason
 * changes, and a figure that moves every second (a probe's age, the free memory) would print one a second.
 */
export const REMOTE_REFUSAL_WORDS: Record<RemoteRefusal, string> = {
  probe: 'the VPS has not answered its probe lately',
  pressure: 'production on the VPS is under pressure, or its pressure is not readable',
  disk: 'the VPS disk is near the line its alert pages on',
  memory: 'the VPS has not enough free memory for it',
  cores: 'the VPS has no idle cores for it',
}

/**
 * Whether the VPS has room for `step` now, by its reading. Memory: the step's peak fits in what is available after the
 * running steps' peaks and the headroom (the mini's rule: 2 GiB or 8 % of RAM); the running steps are counted at their
 * whole peak because their containers' growth is not read. Cores: the step's learned cores fit in the idle ones (cores
 * less the load, which counts production and the running steps alike). Disk: the copy fits under `DISK_CEILING_PCT`.
 */
export function decideRemote(input: {
  reading: RemoteReading | null
  now: Date
  holders: readonly RemoteHolder[]
  step: RemoteStep
  /** a copy of this project is already on the VPS: no new copy's bytes */
  copyExists: boolean
}): { grant: true } | { grant: false; why: string; kind: RemoteRefusal } {
  const { reading, now, step } = input
  if (reading === null) return { grant: false, kind: 'probe', why: 'the VPS has not answered its probe yet' }
  const age = now.getTime() - reading.at.getTime()
  if (age > REMOTE_READING_MAX_AGE_MS)
    return { grant: false, kind: 'probe', why: `the VPS has not answered its probe for ${Math.round(age / 1000)} s` }
  // the tripwire fails closed: a host whose production pressure cannot be read takes no step
  if (reading.memoryPressure === null || reading.ioPressure === null)
    return { grant: false, kind: 'pressure', why: "the VPS's production pressure (system.slice PSI) is not readable" }
  const squeezed = [
    ['memory', reading.memoryPressure],
    ['io', reading.ioPressure],
  ].find(([, pct]) => typeof pct === 'number' && pct > PRESSURE_TRIPWIRE_PCT)
  if (squeezed)
    return {
      grant: false,
      kind: 'pressure',
      why: `production on the VPS is stalled on ${squeezed[0]} (${squeezed[1]} % of the last 10 s, over ${PRESSURE_TRIPWIRE_PCT} %)`,
    }
  const copy = input.copyExists ? 0 : COPY_BYTES
  const usedPct = ((reading.diskUsedBytes + copy) / reading.diskSizeBytes) * 100
  if (usedPct > DISK_CEILING_PCT)
    return {
      grant: false,
      kind: 'disk',
      why: `the VPS disk would be ${Math.round(usedPct)} % full, over the ${DISK_CEILING_PCT} % its disk alert pages on`,
    }
  const held = input.holders.reduce((sum, h) => sum + h.peakMib, 0)
  const room = reading.availableMib - headroomMib(reading.ramMib)
  if (step.peakMib + held > room)
    return {
      grant: false,
      kind: 'memory',
      why: `the VPS has ${gib(Math.max(0, room - held))} free for a step after its headroom and ${input.holders.length} running, the step needs ${gib(step.peakMib)}`,
    }
  const idle = reading.cores - reading.load1
  if (input.holders.length > 0 && step.cores > idle)
    return {
      grant: false,
      kind: 'cores',
      why: `the VPS has ${Math.max(0, Math.round(idle * 10) / 10)} idle cores, the step is learned to take ${Math.round(step.cores * 10) / 10}`,
    }
  return { grant: true }
}

/**
 * How long the caller would still wait on the mini: the slot that frees for it is the `ahead + 1`-th to end. Each holder
 * ends after its learned run less what it has run (unknown: the median); past the holders, the next round takes a median
 * run each.
 */
export function expectedMiniWaitMs(input: {
  remainingMs: readonly number[]
  ahead: number
  medianRunMs: number
}): number {
  const remaining = [...input.remainingMs].sort((a, b) => a - b)
  if (remaining.length === 0) return 0
  const round = Math.floor(input.ahead / remaining.length)
  return (remaining[input.ahead % remaining.length] ?? 0) + round * input.medianRunMs
}

/**
 * Whether the VPS ends the step sooner than the mini would: its VPS run (learned, else the mini's run times
 * `VPS_SLOWDOWN`) against the expected wait plus the mini run. A step with no run learned anywhere goes when the mini
 * has a wait to save.
 */
export function finishesSooner(input: {
  miniRunMs: number | null
  vpsRunMs: number | null
  expectedWaitMs: number
}): boolean {
  const { miniRunMs, expectedWaitMs } = input
  if (miniRunMs === null && input.vpsRunMs === null) return expectedWaitMs > 0
  const mini = miniRunMs ?? (input.vpsRunMs ?? 0) / VPS_SLOWDOWN
  const vps = input.vpsRunMs ?? mini * VPS_SLOWDOWN
  return vps < expectedWaitMs + mini
}

/** The VPS slot numbers in use, and the lowest free one: a slot number is a copy of the project on the VPS. */
export const freeRemoteSlot = (taken: ReadonlySet<number>): number => {
  let n = 1
  while (taken.has(n)) n++
  return n
}

/** The VPS worktree of a project for a slot, relative to the remote user's home. */
export const copyDirOf = (project: string, slot: number): string => `factory-steps/${project}/${slot}`

/** The project's bare repository on the VPS, which every slot's worktree shares. */
export const bareRepoOf = (project: string): string => `factory-steps/${project}.git`

/**
 * The cores a step may count on: the idle ones at the grant (cores less the load), at least 1. The step reads them as
 * `FACTORY_STEP_CORES` and may run that many processes; production still wins any core it wants back.
 */
export const grantedCores = (reading: RemoteReading): number => Math.max(1, Math.floor(reading.cores - reading.load1))
