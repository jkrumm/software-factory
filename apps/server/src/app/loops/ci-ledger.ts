import type { CiLedgerRuns, LoopStore } from '../../domains/loops/ports.ts'
import type { Clock } from '../../kernel/clock.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

const DAY_MS = 24 * 3_600_000
/** A repo with no run in the ledger is read this far back; one with runs is read from the day before its newest. */
const FIRST_READ_DAYS = 14
/** The projects followed: the repos an Issue had an event in over this long. */
const FOLLOW_DAYS = 14
/** The ledger keeps its runs this long, past the longest window `read throughput` takes (14 days). */
const KEEP_DAYS = 30

export interface CiLedgerDeps {
  uow: UnitOfWork<{ loops: LoopStore }>
  clock: Clock
  /** one read of a repo's finished runs (`githubCiLedger`) */
  ledger: CiLedgerRuns
  /** repos followed whether or not an Issue touched them lately (the factory's own) */
  always: readonly string[]
}

export interface CiLedgerPass {
  repos: number
  runs: number
  pruned: number
  /** a repo whose CI could not be read, with why: the pass goes on with the others */
  notes: string[]
}

/**
 * One pass of the CI ledger: the finished runs of every followed repo, written to `factory.ci_runs` (a stored run is
 * overwritten, so a pass over the same runs changes nothing). A repo that cannot be read is a note, never a failed pass:
 * the next pass reads it again from the same place. GitHub is called outside any transaction.
 */
export async function ciLedgerPass(deps: CiLedgerDeps): Promise<Result<CiLedgerPass, PortError>> {
  const now = deps.clock.now()
  const followed = await deps.uow.run(async ({ loops }) =>
    ok(await loops.ciLedgerRepos(new Date(now.getTime() - FOLLOW_DAYS * DAY_MS))),
  )
  if (!followed.ok) return followed
  const repos = [...new Set([...deps.always, ...followed.value])].sort()

  const pass: CiLedgerPass = { repos: 0, runs: 0, pruned: 0, notes: [] }
  for (const repo of repos) {
    const newest = await deps.uow.run(async ({ loops }) => ok(await loops.newestCiRun(repo)))
    if (!newest.ok) return newest
    const since = newest.value
      ? new Date(newest.value.getTime() - DAY_MS)
      : new Date(now.getTime() - FIRST_READ_DAYS * DAY_MS)
    const read = await deps.ledger(repo, since)
    if (!read.ok) {
      pass.notes.push(`ci ledger ${repo}: ${read.error.detail}`)
      continue
    }
    const stored = await deps.uow.run(async ({ loops }) => ok(await loops.recordCiRuns(repo, read.value)))
    if (!stored.ok) return stored
    pass.repos++
    pass.runs += stored.value
  }
  const pruned = await deps.uow.run(async ({ loops }) =>
    ok(await loops.pruneCiRuns(new Date(now.getTime() - KEEP_DAYS * DAY_MS))),
  )
  if (!pruned.ok) return pruned
  pass.pruned = pruned.value
  return ok(pass)
}
