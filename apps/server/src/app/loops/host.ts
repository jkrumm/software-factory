import type { HostSampler, LoopStore } from '../../domains/loops/ports.ts'
import type { Clock } from '../../kernel/clock.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

export interface HostPassDeps {
  uow: UnitOfWork<{ loops: LoopStore }>
  clock: Clock
  sampler: HostSampler
}

/** The Console draws the last 24 hours; a row is kept an hour longer so the chart's left edge is never short. */
export const HOST_KEEP_MS = 25 * 3_600_000

export interface HostPass {
  pruned: number
}

/**
 * One pass of the host loop: the host is read first (a process call, outside any transaction), then one transaction
 * stores the sample and drops what is older than 25 hours.
 */
export async function hostPass(deps: HostPassDeps): Promise<Result<HostPass, PortError>> {
  const sample = await deps.sampler.sample()
  const at = deps.clock.now()
  return deps.uow.run(async ({ loops }) => {
    await loops.recordHostSample(at, sample)
    return ok({ pruned: await loops.pruneHostSamples(new Date(at.getTime() - HOST_KEEP_MS)) })
  })
}

export const hostSummary = (pass: HostPass): string => `sampled the host, pruned ${pass.pruned}`
