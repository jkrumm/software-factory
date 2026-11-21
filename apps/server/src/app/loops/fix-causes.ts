import { causeOf, FIX_WINDOW_DAYS, type FixCommit, type FixCommitRow } from '../../domains/hygiene/fix-causes.ts'
import type { FixCommitReader } from '../../domains/hygiene/ports.ts'
import type { LoopStore } from './stores.ts'
import type { PlanningStore } from '../../domains/planning/ports.ts'
import { repoTextOf } from '../../domains/planning/sync.ts'
import type { Clock } from '../../kernel/clock.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'
import { passLoop, type LoopSpec, type LoopWiring } from './runner.ts'

export interface FixCausesDeps {
  uow: UnitOfWork<{ loops: LoopStore; planning: PlanningStore }>
  clock: Clock
  reader: FixCommitReader
  /** only these projects (names or repo texts); null is every project with a `project.yaml` */
  repos: readonly string[] | null
}

interface FixCausesPass {
  repos: number
  /** fix commits stored this pass */
  stored: number
  /** a repo that could not be read, one line each */
  problems: string[]
}

const DAY_MS = 86_400_000

/**
 * One pass of the fix-causes loop: the fix commits of every project's default branch of the last 35 days, those not stored
 * yet sorted by the rules (`causeOf`; no rule means `other`) and stored. A repo that cannot be read is named and read
 * again next pass.
 */
async function fixCausesPass(deps: FixCausesDeps): Promise<Result<FixCausesPass, PortError>> {
  const now = deps.clock.now()
  const since = new Date(now.getTime() - FIX_WINDOW_DAYS * DAY_MS)
  const read = await deps.uow.run(async ({ planning }) => ok(await planning.projects()))
  if (!read.ok) return read
  const projects = read.value.filter(
    (p) =>
      p.source === 'file' &&
      !p.project.work &&
      (deps.repos === null || deps.repos.includes(p.name) || deps.repos.includes(repoTextOf(p))),
  )
  const pass: FixCausesPass = { repos: 0, stored: 0, problems: [] }
  for (const project of projects) {
    const repo = repoTextOf(project)
    const commits = await deps.reader.read(repo, since)
    if (!commits.ok) {
      pass.problems.push(`${repo}: ${commits.error.kind}: ${commits.error.detail}`.slice(0, 300))
      continue
    }
    pass.repos++
    const stored = await deps.uow.run(async ({ loops }) => ok(await loops.storedFixShas(repo)))
    if (!stored.ok) return stored
    const fresh = commits.value.filter((c) => !stored.value.has(c.sha))
    const rows = fresh.map((commit) => rowOf(repo, commit))
    if (rows.length === 0) continue
    const recorded = await deps.uow.run(async ({ loops }) => {
      await loops.recordFixCommits(rows)
      return ok(undefined)
    })
    if (!recorded.ok) return recorded
    pass.stored += rows.length
  }
  return ok(pass)
}

const rowOf = (repo: string, commit: FixCommit): FixCommitRow => {
  const { cause, reason } = causeOf(commit)
  return {
    repo,
    sha: commit.sha,
    committedAt: commit.committedAt,
    subject: commit.subject,
    scope: commit.scope,
    class: cause,
    by: 'rule',
    reason: reason.slice(0, 300),
  }
}

const fixCausesSummary = (pass: FixCausesPass): string =>
  `${pass.repos} repo(s): ${pass.stored} fix commit(s) sorted by rule`

/** Fix commits of every project's default branch, sorted by cause by rule, stored for the Improve screen. */
export const fixCausesLoop = (wiring: LoopWiring, deps: FixCausesDeps): LoopSpec =>
  passLoop(wiring, {
    name: 'fix-causes',
    pass: () => fixCausesPass(deps),
    problems: (pass) => pass.problems,
    summary: fixCausesSummary,
  })
