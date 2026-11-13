import { attribute } from '../../domains/capacity/leadcost.ts'
import type { ProcessReader } from '../../domains/capacity/ports.ts'
import type { CapacityFacts, HostSampler, LoopStore } from '../../domains/loops/ports.ts'
import type { Clock } from '../../kernel/clock.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

export interface HostPassDeps {
  uow: UnitOfWork<{ loops: LoopStore }>
  clock: Clock
  sampler: HostSampler
  /** the process table with directories; null when it could not be read */
  processes: ProcessReader
  /** what the capacity layer holds now; an error is nulls in the sample */
  facts: () => Promise<Result<CapacityFacts, PortError>>
}

/** The Console draws the last 24 hours; a row is kept an hour longer so the chart's left edge is never short. */
export const HOST_KEEP_MS = 25 * 3_600_000

/** What each lead cost is learned from a month of minutes. */
export const LEAD_SAMPLES_KEEP_MS = 30 * 86_400_000

/** An attempt that ended this long ago still has its processes sampled, so a finishing lead's last minute is kept. */
const ENDED_GRACE_MS = 10 * 60_000

const NO_FACTS: CapacityFacts = { leads: null, queued: null, seats: null, loadCeiling: null }

export interface HostPass {
  pruned: number
  /** the lead rows stored; null: the process table could not be read, no lead rows were recorded */
  leadRows: number | null
}

/**
 * One pass of the host loop: the attempts' worktrees are read, then the host, the process table and the capacity facts
 * (process calls and reads, outside any transaction), then one transaction stores the sample with the lead rows and drops
 * what is older than 25 hours (host samples) or 30 days (lead samples).
 */
export async function hostPass(deps: HostPassDeps): Promise<Result<HostPass, PortError>> {
  const at = deps.clock.now()
  const known = await deps.uow.run(async ({ loops }) =>
    ok(await loops.attemptWorktrees(new Date(at.getTime() - ENDED_GRACE_MS))),
  )
  if (!known.ok) return known
  const [reading, table, facts] = await Promise.all([deps.sampler.sample(), deps.processes.read(), deps.facts()])
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
  return deps.uow.run(async ({ loops }) => {
    await loops.recordHostSample(at, { ...reading, ...(facts.ok ? facts.value : NO_FACTS) }, leads ?? [])
    await loops.pruneLeadSamples(new Date(at.getTime() - LEAD_SAMPLES_KEEP_MS))
    return ok({
      pruned: await loops.pruneHostSamples(new Date(at.getTime() - HOST_KEEP_MS)),
      leadRows: leads === null ? null : leads.length,
    })
  })
}

export const hostSummary = (pass: HostPass): string =>
  `sampled the host, pruned ${pass.pruned}, ${pass.leadRows === null ? 'no lead rows (the process table could not be read)' : `${pass.leadRows} lead row(s)`}`
