import { DIGEST_ROUTE, DIGEST_WINDOW_MS, digestSummary, planDigests } from '../../domains/loops/digest.ts'
import type { LoopReads, LoopStore } from '../../domains/loops/ports.ts'
import type { PlanningStore } from '../../domains/planning/ports.ts'
import type { Clock } from '../../kernel/clock.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'
import { passLoop, type LoopSpec, type LoopWiring } from './runner.ts'

export interface DigestDeps {
  uow: UnitOfWork<{ loops: LoopStore; loopReads: LoopReads; planning: PlanningStore }>
  clock: Clock
}

interface DigestPass {
  stored: number
  unchanged: number
  idle: number
}

type Out<T> = Promise<Result<T, PortError>>

/**
 * One pass of the digest loop: every project with a `project.yaml` that has an Issue open or closed in the last 7 days and
 * whose digest, built in code from those Issues (`digestOf`), differs from its newest stored one gets a new row. Nothing is
 * called outside the database, so the pass is one read and one write.
 */
async function digestPass(deps: DigestDeps): Out<DigestPass> {
  const now = deps.clock.now()
  return deps.uow.run(async ({ loops, loopReads, planning }) => {
    const plan = planDigests({
      projects: (await planning.projects()).filter((p) => p.source === 'file'),
      issues: await loopReads.digestIssues(new Date(now.getTime() - DIGEST_WINDOW_MS)),
      latest: await loops.latestDigests(),
      now,
    })
    for (const store of plan.stores) {
      await loops.recordDigest({
        project: store.project,
        at: now,
        hash: store.hash,
        route: DIGEST_ROUTE,
        digest: store.digest,
      })
    }
    return ok({ stored: plan.stores.length, unchanged: plan.unchanged.length, idle: plan.idle })
  })
}

const digestPassSummary = (pass: DigestPass): string => digestSummary(pass)

/** A digest built in code for each project whose Issues changed: the summary the Console shows on Flow. Interval only. */
export const digestLoop = (wiring: LoopWiring, deps: DigestDeps): LoopSpec =>
  passLoop(wiring, { name: 'digest', pass: () => digestPass(deps), summary: digestPassSummary })
