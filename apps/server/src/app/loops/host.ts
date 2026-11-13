import {
  assignClasses,
  classRows,
  cpuSince,
  emptySnapshotMemory,
  notableProcs,
  remember,
  type SnapshotMemory,
} from '../../domains/capacity/classes.ts'
import { attribute } from '../../domains/capacity/leadcost.ts'
import type { HostSnapshotReader, ProcessReader } from '../../domains/capacity/ports.ts'
import type {
  CapacityFacts,
  ClassSampleRow,
  HostSampler,
  HostSignals,
  LoopStore,
  ProcessSampleRow,
} from '../../domains/loops/ports.ts'
import type { Clock } from '../../kernel/clock.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

export interface HostPassDeps {
  uow: UnitOfWork<{ loops: LoopStore }>
  clock: Clock
  sampler: HostSampler
  /** the process table with directories; null when it could not be read */
  processes: ProcessReader
  /** the class snapshot: every process of `top` with what ps, lsof and launchctl say, and the host signals */
  snapshot: HostSnapshotReader
  /** what the collector carries from one pass to the next (CPU times, recent footprints); the pass replaces it */
  memory: { current: SnapshotMemory }
  /** the server's own pid and the directories of its release: the factory class */
  self: { pid: number; dirs: readonly string[] }
  /** what the capacity layer holds now; an error is nulls in the sample */
  facts: () => Promise<Result<CapacityFacts, PortError>>
}

/** The collector's memory at start: no CPU times and no footprints yet, so the first snapshot has no CPU figures. */
export const freshHostMemory = (): { current: SnapshotMemory } => ({ current: emptySnapshotMemory() })

/** Host samples, class rows and notable processes are kept two weeks: the Console's 24 hours and the loop's 14-day medians. */
export const HOST_KEEP_MS = 14 * 86_400_000

/** The hourly class rollups are kept 400 days: a year against the year before. */
export const CLASS_HOURS_KEEP_MS = 400 * 86_400_000

/** What each lead cost is learned from a month of minutes. */
export const LEAD_SAMPLES_KEEP_MS = 30 * 86_400_000

/** An attempt that ended this long ago still has its processes sampled, so a finishing lead's last minute is kept. */
const ENDED_GRACE_MS = 10 * 60_000

const NO_FACTS: CapacityFacts = { leads: null, queued: null, seats: null, loadCeiling: null }
const NO_SIGNALS: HostSignals = {
  pressureLevel: null,
  compressorMib: null,
  processes: null,
  cpuIdlePct: null,
  vmFreeGib: null,
  collectorCpuMs: null,
}

export interface HostPass {
  pruned: number
  /** the lead rows stored; null: the process table could not be read, no lead rows were recorded */
  leadRows: number | null
  /** the class rows stored; null: `top` could not be read, no snapshot was recorded */
  classRows: number | null
}

/**
 * One pass of the host loop: the attempts' worktrees are read, then the host, the process table, the class snapshot and
 * the capacity facts (process calls and reads, outside any transaction). The snapshot's processes are given their class
 * (`domains/capacity/classes.ts`) and summed per class, repo, tenant, Issue and step, with the notable processes beside.
 * Then one transaction stores the sample, the lead rows and the snapshot, rolls complete hours up, and drops what is older
 * than 14 days (host samples, class and process rows), 30 days (lead samples) or 400 days (hourly rollups).
 */
export async function hostPass(deps: HostPassDeps): Promise<Result<HostPass, PortError>> {
  const at = deps.clock.now()
  const known = await deps.uow.run(async ({ loops }) =>
    ok(await loops.attemptWorktrees(new Date(at.getTime() - ENDED_GRACE_MS))),
  )
  if (!known.ok) return known
  const [reading, table, snapshot, facts] = await Promise.all([
    deps.sampler.sample(),
    deps.processes.read(),
    deps.snapshot.read().catch(() => null),
    deps.facts(),
  ])
  const leads =
    table === null
      ? null
      : attribute(table, known.value).map((cost) => ({
          worktree: cost.path,
          repo: cost.repo,
          issue: cost.issue,
          attempt: cost.attempt,
          rssMib: cost.rssMib,
          footprintMib: cost.footprintMib,
          procs: cost.procs,
        }))

  let classes: ClassSampleRow[] | null = null
  let notable: ProcessSampleRow[] = []
  if (snapshot !== null) {
    const memory = deps.memory.current
    const procs = assignClasses({
      procs: snapshot.procs,
      worktrees: known.value,
      selfPid: deps.self.pid,
      factoryDirs: deps.self.dirs,
      cpuSince: cpuSince(snapshot.procs, memory),
    })
    classes = classRows(procs)
    notable = notableProcs(procs, memory, at.getTime()).map((proc) => ({
      pid: proc.pid,
      ppid: proc.ppid,
      name: proc.name,
      class: proc.class,
      repo: proc.repo,
      tenant: proc.tenant,
      issue: proc.issue,
      footprintMib: Math.round(proc.footprintKib / 1024),
      cpuMs: proc.cpuMs,
      why: proc.why,
      grownMib: proc.grownMib,
    }))
    deps.memory.current = remember(snapshot.procs, memory, at.getTime())
  }
  const signals: HostSignals =
    snapshot === null
      ? NO_SIGNALS
      : {
          pressureLevel: snapshot.pressureLevel,
          compressorMib: snapshot.compressorMib,
          processes: snapshot.processes,
          cpuIdlePct: snapshot.cpuIdlePct,
          vmFreeGib: snapshot.vmFreeGib,
          collectorCpuMs: snapshot.collectorCpuMs,
        }

  return deps.uow.run(async ({ loops }) => {
    await loops.recordHostSample(at, { ...reading, ...(facts.ok ? facts.value : NO_FACTS), ...signals }, leads ?? [])
    if (classes !== null) await loops.recordClassSnapshot(at, classes, notable)
    await loops.rollUpClassHours(at)
    await loops.pruneLeadSamples(new Date(at.getTime() - LEAD_SAMPLES_KEEP_MS))
    const keep = new Date(at.getTime() - HOST_KEEP_MS)
    const pruned =
      (await loops.pruneHostSamples(keep)) +
      (await loops.pruneClassSamples(keep)) +
      (await loops.pruneClassHours(new Date(at.getTime() - CLASS_HOURS_KEEP_MS)))
    return ok({
      pruned,
      leadRows: leads === null ? null : leads.length,
      classRows: classes === null ? null : classes.length,
    })
  })
}

export const hostSummary = (pass: HostPass): string =>
  [
    `sampled the host, pruned ${pass.pruned}`,
    pass.leadRows === null ? 'no lead rows (the process table could not be read)' : `${pass.leadRows} lead row(s)`,
    pass.classRows === null ? 'no class snapshot (top could not be read)' : `${pass.classRows} class row(s)`,
  ].join(', ')
