import { checkDigest, DIGEST_ROUTE, DIGEST_WINDOW_MS, digestSummary, planDigests } from '../../domains/loops/digest.ts'
import type { DigestWorkflow, LoopReads, LoopStore } from '../../domains/loops/ports.ts'
import type { PlanningStore } from '../../domains/planning/ports.ts'
import type { Clock } from '../../kernel/clock.ts'
import { key } from '../../kernel/keys.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

export interface DigestDeps {
  uow: UnitOfWork<{ loops: LoopStore; loopReads: LoopReads; planning: PlanningStore }>
  clock: Clock
  workflow: DigestWorkflow
}

export interface DigestPass {
  called: number
  stored: number
  failed: number
  unchanged: number
  idle: number
  problems: string[]
}

type Out<T> = Promise<Result<T, PortError>>

/**
 * One pass of the digest loop: every project with a `project.yaml` that has an Issue open or closed in the last 7 days and
 * whose Issues differ from what its newest digest was made from is summarised by `agw factory digest`, one call a project.
 * The Issues are read and committed first, each call is made outside any transaction, and a digest is a new row. A failed
 * call stores nothing (the project's previous digest stays), is named in the pass, and is asked again on the next pass.
 */
export async function digestPass(deps: DigestDeps): Out<DigestPass> {
  const now = deps.clock.now()
  const read = await deps.uow.run(async ({ loops, loopReads, planning }) =>
    ok({
      projects: (await planning.projects()).filter((p) => p.source === 'file'),
      issues: await loopReads.digestIssues(new Date(now.getTime() - DIGEST_WINDOW_MS)),
      latest: await loops.latestDigests(),
    }),
  )
  if (!read.ok) return read
  const plan = planDigests({ ...read.value, now })
  const pass: DigestPass = {
    called: 0,
    stored: 0,
    failed: 0,
    unchanged: plan.unchanged.length,
    idle: plan.idle,
    problems: [],
  }
  for (const call of plan.calls) {
    pass.called++
    // the instant is in the key: a call that failed is asked again by the next pass, not replayed as the failed run
    const answered = await deps.workflow.digest(
      call.request,
      key('digest', call.project, call.hash.slice(0, 16), now.getTime()),
    )
    if (!answered.ok) {
      pass.failed++
      pass.problems.push(`${call.project}: ${answered.error.kind}: ${answered.error.detail}`.slice(0, 300))
      continue
    }
    const stored = await deps.uow.run(async ({ loops }) => {
      await loops.recordDigest({
        project: call.project,
        at: deps.clock.now(),
        hash: call.hash,
        route: DIGEST_ROUTE,
        digest: checkDigest(answered.value, call.request),
      })
      return ok(undefined)
    })
    if (!stored.ok) {
      pass.failed++
      pass.problems.push(`${call.project}: ${stored.error.detail}`.slice(0, 300))
      continue
    }
    pass.stored++
  }
  return ok(pass)
}

export const digestPassSummary = (pass: DigestPass): string =>
  `${digestSummary(pass)}${pass.problems.length ? `: ${pass.problems.slice(0, 3).join(' | ')}` : ''}`
