import {
  assignClasses,
  classRows,
  cpuSince,
  emptySnapshotMemory,
  notableProcs,
  remember,
  stepNames,
  type SnapshotMemory,
} from '../../domains/capacity/classes.ts'
import { dueWorktrees } from '../../domains/capacity/disk.ts'
import { attribute } from '../../domains/capacity/leadcost.ts'
import type { HostSnapshotReader, ProcessReader, WorktreeSizer } from '../../domains/capacity/ports.ts'
import type {
  CapacityFacts,
  ClassSampleRow,
  HostSampler,
  HostSignals,
  LoopStore,
  ProcessSampleRow,
  WorktreeSizeRow,
} from '../../domains/loops/ports.ts'
import type { Clock } from '../../kernel/clock.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'
import { passLoop, type LoopSpec, type LoopWiring } from './runner.ts'

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
  /**
   * measures what an attempt's worktree takes on disk, which admission learns a repo's footprint from; absent: no worktree is
   * measured. `measuredAt` is when each path was last measured, kept by the caller between passes.
   */
  sizer?: { reader: WorktreeSizer; measuredAt: Map<string, number> }
  /** what the capacity layer holds now; an error is nulls in the sample */
  facts: () => Promise<Result<CapacityFacts, PortError>>
}

/** The collector's memory at start: no CPU times and no footprints yet, so the first snapshot has no CPU figures. */
export const freshHostMemory = (): { current: SnapshotMemory } => ({ current: emptySnapshotMemory() })

/** Host samples, class rows and notable processes are kept two weeks: the Console's 24 hours and the loop's 14-day medians. */
const HOST_KEEP_MS = 14 * 86_400_000

/** The hourly class rollups are kept 400 days: a year against the year before. */
const CLASS_HOURS_KEEP_MS = 400 * 86_400_000

/** What each lead cost is learned from a month of minutes. */
const LEAD_SAMPLES_KEEP_MS = 30 * 86_400_000

/** What the measured worktree sizes are learned from: a month. */
const SIZES_KEEP_MS = 30 * 86_400_000

/** An attempt that ended this long ago still has its processes sampled, so a finishing lead's last minute is kept. */
const ENDED_GRACE_MS = 10 * 60_000

const NO_FACTS: CapacityFacts = { leads: null, queued: null, seats: null, loadCeiling: null }
const NO_SIGNALS: HostSignals = {
  pressureLevel: null,
  kernelFreePct: null,
  compressorMib: null,
  processes: null,
  cpuIdlePct: null,
  cpuUserPct: null,
  cpuSysPct: null,
  vmFreeGib: null,
  collectorCpuMs: null,
}

export interface HostPass {
  pruned: number
  /** the lead rows stored; null: the process table or the class snapshot could not be read, no lead rows were recorded */
  leadRows: number | null
  /** the class rows stored; null: `top`, `ps`, `launchctl` or `lsof` could not be read, no classes were recorded */
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
  // A lead's cost leaves out what runs under a slot run (the slot grant weighs that on its own), told by the class
  // snapshot's holders and `FACTORY_SLOT_ACTIVE`; without that snapshot no minute can say which processes those are.
  const leads =
    table === null || !snapshot?.procs
      ? null
      : attribute(table, known.value, new Set(stepNames(snapshot.procs).keys())).map((cost) => ({
          worktree: cost.path,
          repo: cost.repo,
          issue: cost.issue,
          attempt: cost.attempt,
          rssMib: cost.rssMib,
          footprintMib: cost.footprintMib,
          procs: cost.procs,
        }))

  const sizes = await measureWorktrees(deps, known.value, at)

  let classes: ClassSampleRow[] | null = null
  let notable: ProcessSampleRow[] = []
  // a degraded snapshot (no procs) stores its signals only; the memory is kept, so the next minute's CPU covers both
  if (snapshot?.procs) {
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
          kernelFreePct: snapshot.kernelFreePct,
          compressorMib: snapshot.compressorMib,
          processes: snapshot.processes,
          cpuIdlePct: snapshot.cpuIdlePct,
          cpuUserPct: snapshot.cpuUserPct,
          cpuSysPct: snapshot.cpuSysPct,
          vmFreeGib: snapshot.vmFreeGib,
          collectorCpuMs: snapshot.collectorCpuMs,
        }

  return deps.uow.run(async ({ loops }) => {
    await loops.recordHostSample(at, { ...reading, ...(facts.ok ? facts.value : NO_FACTS), ...signals }, leads ?? [])
    if (classes !== null) await loops.recordClassSnapshot(at, classes, notable)
    await loops.rollUpClassHours(at)
    await loops.pruneLeadSamples(new Date(at.getTime() - LEAD_SAMPLES_KEEP_MS))
    if (sizes.length > 0) await loops.recordWorktreeSizes(at, sizes)
    await loops.pruneWorktreeSizes(new Date(at.getTime() - SIZES_KEEP_MS))
    const keep = new Date(at.getTime() - HOST_KEEP_MS)
    const pruned =
      (await loops.pruneHostSamples(keep)) +
      (await loops.pruneClassSamples(keep)) +
      (await loops.pruneTestResults(keep)) +
      (await loops.pruneClassHours(new Date(at.getTime() - CLASS_HOURS_KEEP_MS)))
    return ok({
      pruned,
      leadRows: leads === null ? null : leads.length,
      classRows: classes === null ? null : classes.length,
    })
  })
}

/** The attempts' worktrees due a measurement (`dueWorktrees`), measured side by side; one that could not be read is left for the next pass. */
async function measureWorktrees(
  deps: HostPassDeps,
  worktrees: readonly { path: string; repo: string; issue: number | null; attempt: number | null }[],
  at: Date,
): Promise<WorktreeSizeRow[]> {
  const { sizer } = deps
  if (!sizer) return []
  const due = dueWorktrees(worktrees, sizer.measuredAt, at.getTime())
  const read = await Promise.all(
    due.map(async (path) => ({ path, mib: await sizer.reader.sizeMib(path).catch(() => null) })),
  )
  const rows: WorktreeSizeRow[] = []
  for (const { path, mib } of read) {
    // a read that failed (a worktree already gone) waits as long as one that did not, so it never crowds the others out of a pass
    sizer.measuredAt.set(path, at.getTime())
    if (mib === null) continue
    const worktree = worktrees.find((w) => w.path === path)
    if (worktree)
      rows.push({ worktree: path, repo: worktree.repo, issue: worktree.issue, attempt: worktree.attempt, mib })
  }
  return rows
}

const hostSummary = (pass: HostPass): string =>
  [
    `sampled the host, pruned ${pass.pruned}`,
    pass.leadRows === null
      ? 'no lead rows (the process table or the class snapshot could not be read)'
      : `${pass.leadRows} lead row(s)`,
    pass.classRows === null
      ? 'no class snapshot (top, ps, launchctl or lsof could not be read)'
      : `${pass.classRows} class row(s)`,
  ].join(', ')

/**
 * One reading of the host a minute with its class snapshot, kept 14 days: the Live popover and `read throughput` draw it.
 * `aim` moves the slot aim on the sample just stored; its failure is said in the line, never a failed host pass.
 */
export const hostLoop = (
  wiring: LoopWiring,
  deps: HostPassDeps,
  aim: () => Promise<Result<string, PortError>>,
): LoopSpec =>
  passLoop(wiring, {
    name: 'host',
    pass: async () => {
      const pass = await hostPass(deps)
      if (!pass.ok) return pass
      const moved = await aim()
      return ok(
        moved.ok
          ? `${hostSummary(pass.value)}; ${moved.value}`
          : `${hostSummary(pass.value)}; slot aim: ${moved.error.detail}`,
      )
    },
    summary: (line) => line,
  })
