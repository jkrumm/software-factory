import { classOf, FIX_WINDOW_DAYS, type FixCommit, type FixCommitRow } from '../../domains/loops/fix-classes.ts'
import type { FixCommitReader, LoopStore } from '../../domains/loops/ports.ts'
import type { PlanningStore } from '../../domains/planning/ports.ts'
import { repoTextOf } from '../../domains/planning/sync.ts'
import type { Clock } from '../../kernel/clock.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

export interface FixClassesDeps {
  uow: UnitOfWork<{ loops: LoopStore; planning: PlanningStore }>
  clock: Clock
  reader: FixCommitReader
  /** only these projects (names or repo texts); null is every project with a `project.yaml` */
  repos: readonly string[] | null
}

export interface FixClassesPass {
  repos: number
  /** fix commits stored this pass */
  stored: number
  /** a repo that could not be read, one line each */
  problems: string[]
}

const DAY_MS = 86_400_000

/**
 * One pass of the fix-classes loop: the fix commits of every project's default branch of the last 35 days, those not stored
 * yet classed by the rules (`classOf`; no rule means `other`) and stored. A repo that cannot be read is named and read
 * again next pass.
 */
export async function fixClassesPass(deps: FixClassesDeps): Promise<Result<FixClassesPass, PortError>> {
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
  const pass: FixClassesPass = { repos: 0, stored: 0, problems: [] }
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
  const { class: cls, reason } = classOf(commit)
  return {
    repo,
    sha: commit.sha,
    committedAt: commit.committedAt,
    subject: commit.subject,
    scope: commit.scope,
    class: cls,
    by: 'rule',
    reason: reason.slice(0, 300),
  }
}

export const fixClassesSummary = (pass: FixClassesPass): string =>
  `${pass.repos} repo(s): ${pass.stored} fix commit(s) classed by rule`
