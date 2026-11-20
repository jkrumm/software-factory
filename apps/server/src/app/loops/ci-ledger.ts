import type { CiLedgerRuns } from '../../domains/improve/ports.ts'
import type { LoopStore } from './stores.ts'
import type { Clock } from '../../kernel/clock.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'
import { passLoop, type LoopSpec, type LoopWiring } from './runner.ts'

const DAY_MS = 24 * 3_600_000
/** A repo with no run in the ledger is read this far back; one with runs is read from the day before its newest. */
const FIRST_READ_DAYS = 14
/** A repo the ledger was refused (outside the roots, no GitHub origin, a 403 or 404) is asked again after this long. */
const REFUSED_RETRY_MS = DAY_MS
/** The ledger keeps its runs this long, past the longest window `read throughput` takes (14 days). */
const KEEP_DAYS = 30

export interface CiLedgerDeps {
  uow: UnitOfWork<{ loops: LoopStore }>
  clock: Clock
  /** one read of a repo's finished runs (`githubCiLedger`) */
  ledger: CiLedgerRuns
  /** the repos of the stored projects (their directory names): the repos followed */
  projects: () => Promise<readonly string[]>
  /** followed whether or not a project is stored for it (the factory's own) */
  always: readonly string[]
  /** repo to the time its refusal is over; the caller keeps the one map between passes, so a refusal is told once */
  refused: Map<string, number>
}

const ciLedgerSummary = (pass: CiLedgerPass): string =>
  [`ci ledger ${pass.runs} run(s) of ${pass.repos} repo(s)`, ...pass.notes].join('; ')

export interface CiLedgerPass {
  repos: number
  runs: number
  pruned: number
  /** a repo whose CI could not be read, with why, told once for a refusal: the pass goes on with the others */
  notes: string[]
}

/**
 * One pass of the CI ledger: the finished runs of every followed repo, written to `factory.ci_runs` (a stored run is
 * overwritten, so a pass over the same runs changes nothing). A repo that cannot be read is a note, never a failed pass:
 * the next pass reads it again from the same place. A refusal (a repo outside the roots, with no GitHub origin, or one the
 * token does not see: 403, 404) will not change by itself, so it is a note once and the repo is left alone for a day.
 * GitHub is called outside any transaction.
 */
export async function ciLedgerPass(deps: CiLedgerDeps): Promise<Result<CiLedgerPass, PortError>> {
  const now = deps.clock.now()
  const repos = [...new Set([...deps.always, ...(await deps.projects())])].sort()

  const pass: CiLedgerPass = { repos: 0, runs: 0, pruned: 0, notes: [] }
  for (const repo of repos) {
    if ((deps.refused.get(repo) ?? 0) > now.getTime()) continue
    const newest = await deps.uow.run(async ({ loops }) => ok(await loops.newestCiRun(repo)))
    if (!newest.ok) return newest
    const since = newest.value
      ? new Date(newest.value.getTime() - DAY_MS)
      : new Date(now.getTime() - FIRST_READ_DAYS * DAY_MS)
    const read = await deps.ledger(repo, since)
    if (!read.ok) {
      pass.notes.push(`ci ledger ${repo}: ${read.error.detail}`)
      if (read.error.kind === 'refused') deps.refused.set(repo, now.getTime() + REFUSED_RETRY_MS)
      continue
    }
    deps.refused.delete(repo)
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

/** The finished CI runs of every stored project and of the factory's own repo, kept per head for `read throughput`. A repo GitHub or the checkout refuses is told once and left alone for a day. */
export const ciLedgerLoop = (wiring: LoopWiring, deps: CiLedgerDeps): LoopSpec =>
  passLoop(wiring, {
    name: 'ci-ledger',
    pass: () => ciLedgerPass(deps),
    problems: (pass) => pass.notes,
    summary: ciLedgerSummary,
  })
