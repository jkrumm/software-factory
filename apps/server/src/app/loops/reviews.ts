import { type ExternalWait, type ReviewPort, wakeReason } from '../../domains/loops/reviews.ts'
import type { PlanningStore } from '../../domains/planning/ports.ts'
import { projectOf } from '../../domains/planning/sync.ts'
import type { WorkStore } from '../../domains/work/ports.ts'
import type { Clock } from '../../kernel/clock.ts'
import { type IdSource, type IssueId } from '../../kernel/ids.ts'
import { key } from '../../kernel/keys.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import { recordIn } from '../issues.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

/** The review poll's own table: what the first look of each wait saw. */
export interface ReviewStore {
  /** the Issues that wait on a pull request's review, with the version that began each wait */
  waits(): Promise<ExternalWait[]>
  baseline(issue: string, since: number): Promise<number | null>
  saveBaseline(issue: string, since: number, baseline: number, at: Date): Promise<void>
}

export interface ReviewsDeps {
  uow: UnitOfWork<{ work: WorkStore; planning: PlanningStore; reviews: ReviewStore }>
  clock: Clock
  ids: IdSource
  port: ReviewPort
}

export interface ReviewsPass {
  /** the review waits the pass looked at */
  looked: number
  /** the Issues whose wait ended because the reviewer acted */
  woken: string[]
  problems: string[]
}

type Out<T> = Promise<Result<T, PortError>>

/**
 * One pass of the `reviews` loop: every Issue that waits on a pull request's review is looked at through `gh` (GitHub) or
 * `glab` (GitLab), outside any transaction, in the repo's checkout. An approval, a request for changes, a merge, a close, or
 * a review or comment by someone else that the first look did not see ends the wait with `woken`; the lead hears what
 * happened. A look that fails changes nothing and is named in the pass. The wake is named by the wait's `since` and keyed by
 * it, so a replayed pass wakes once.
 */
export async function reviewsPass(deps: ReviewsDeps): Out<ReviewsPass> {
  const read = await deps.uow.run(async ({ reviews, planning }) =>
    ok({ waits: await reviews.waits(), projects: await planning.projects() }),
  )
  if (!read.ok) return read
  const pass: ReviewsPass = { looked: read.value.waits.length, woken: [], problems: [] }
  for (const wait of read.value.waits) {
    const project = projectOf(read.value.projects, wait.repo)
    const cwd = project?.repo ?? (wait.repo.startsWith('/') ? wait.repo : null)
    const work = project ? project.source === 'defaults' || project.project.work : false
    const looked = await deps.port.look({ cwd, ref: wait.ref, work })
    if (!looked.ok) {
      pass.problems.push(`${wait.issue}: ${looked.error.detail}`.slice(0, 300))
      continue
    }
    const look = looked.value
    const kept = await deps.uow.run(async ({ reviews }) => {
      const stored = await reviews.baseline(wait.issue, wait.since)
      if (stored !== null) return ok(stored)
      await reviews.saveBaseline(wait.issue, wait.since, look.others, deps.clock.now())
      return ok(look.others)
    })
    if (!kept.ok) {
      pass.problems.push(`${wait.issue}: ${kept.error.detail}`.slice(0, 300))
      continue
    }
    const reason = wakeReason(look, kept.value)
    if (reason === null) continue
    const woken = await deps.uow.run(async ({ work: store }) => {
      const recorded = await recordIn(store, deps, {
        issueId: wait.issue as IssueId,
        key: key('woken', wait.issue, 'external', wait.since),
        event: {
          kind: 'woken',
          payload: { since: wait.since, detail: `${wait.ref}: ${reason}` },
          actor: 'factory',
        },
      })
      return ok(recorded.ok ? recorded.value.result : `refused: ${JSON.stringify(recorded.error)}`)
    })
    if (!woken.ok) pass.problems.push(`${wait.issue}: ${woken.error.detail}`.slice(0, 300))
    else if (woken.value === 'applied') pass.woken.push(wait.issue)
    else if (woken.value.startsWith('refused')) pass.problems.push(`${wait.issue}: ${woken.value}`.slice(0, 300))
  }
  return ok(pass)
}

export const reviewsSummary = (pass: ReviewsPass): string =>
  `${pass.looked} review waits looked at, ${pass.woken.length} woken${
    pass.problems.length ? `: ${pass.problems.slice(0, 3).join(' | ')}` : ''
  }`
