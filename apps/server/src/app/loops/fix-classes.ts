import {
  batchesOf,
  batchKey,
  checkAnswer,
  FIX_WINDOW_DAYS,
  type FixCommit,
  type FixCommitRow,
  requestOf,
  ruleClass,
} from '../../domains/loops/fix-classes.ts'
import type { FixClassesWorkflow, FixCommitReader, LoopStore } from '../../domains/loops/ports.ts'
import type { PlanningStore } from '../../domains/planning/ports.ts'
import { repoTextOf } from '../../domains/planning/sync.ts'
import type { Clock } from '../../kernel/clock.ts'
import { ok, type PortError, type Result } from '../../kernel/result.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

export interface FixClassesDeps {
  uow: UnitOfWork<{ loops: LoopStore; planning: PlanningStore }>
  clock: Clock
  reader: FixCommitReader
  workflow: FixClassesWorkflow
  /** only these projects (names or repo texts); null is every project with a `project.yaml` */
  repos: readonly string[] | null
}

export interface FixClassesPass {
  repos: number
  /** fix commits stored this pass, by the rules and by the workflow */
  byRule: number
  byWorkflow: number
  /** commits left for the next pass: a batch the workflow failed or answered wrongly */
  left: number
  /** a repo that could not be read, a workflow that failed or an answer that was refused, one line each */
  problems: string[]
}

const DAY_MS = 86_400_000

/**
 * One pass of the fix-classes loop: the fix commits of every project's default branch of the last 35 days, those not stored
 * yet sorted by the rules or by `factory-fix-classes` (batches of 40), stored. A port that fails never throws the loop: the
 * commits it did not settle are read again next pass, and the ones the rules settled are stored regardless.
 */
export async function fixClassesPass(deps: FixClassesDeps): Promise<Result<FixClassesPass, PortError>> {
  const now = deps.clock.now()
  const day = now.toISOString().slice(0, 10)
  const since = new Date(now.getTime() - FIX_WINDOW_DAYS * DAY_MS)
  const read = await deps.uow.run(async ({ planning }) => ok(await planning.projects()))
  if (!read.ok) return read
  const projects = read.value.filter(
    (p) =>
      p.source === 'file' &&
      !p.project.work &&
      (deps.repos === null || deps.repos.includes(p.name) || deps.repos.includes(repoTextOf(p))),
  )
  const pass: FixClassesPass = { repos: 0, byRule: 0, byWorkflow: 0, left: 0, problems: [] }
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
    const rows: FixCommitRow[] = []
    const unsettled: FixCommit[] = []
    for (const commit of fresh) {
      const settled = ruleClass(commit)
      if (!settled) {
        unsettled.push(commit)
        continue
      }
      rows.push(rowOf(repo, commit, settled.class, 'rule', settled.reason))
      pass.byRule++
    }
    for (const batch of batchesOf(unsettled)) {
      const request = requestOf(repo, batch)
      const asked = await deps.workflow.ask(
        request,
        batchKey(
          repo,
          batch.map((c) => c.sha),
          day,
        ),
      )
      if (!asked.ok) {
        pass.left += batch.length
        pass.problems.push(`${repo}: workflow ${asked.error.kind}: ${asked.error.detail}`.slice(0, 300))
        continue
      }
      const checked = checkAnswer(request, asked.value)
      if (!checked.ok) {
        pass.left += batch.length
        pass.problems.push(`${repo}: answer refused: ${checked.why}`.slice(0, 300))
        continue
      }
      for (const commit of batch) {
        const answer = checked.bySha.get(commit.sha)
        if (!answer) continue
        rows.push(rowOf(repo, commit, answer.class, 'workflow', answer.reason))
        pass.byWorkflow++
      }
    }
    if (rows.length === 0) continue
    const recorded = await deps.uow.run(async ({ loops }) => {
      await loops.recordFixCommits(rows)
      return ok(undefined)
    })
    if (!recorded.ok) return recorded
  }
  return ok(pass)
}

const rowOf = (
  repo: string,
  commit: FixCommit,
  cls: FixCommitRow['class'],
  by: FixCommitRow['by'],
  reason: string,
): FixCommitRow => ({
  repo,
  sha: commit.sha,
  committedAt: commit.committedAt,
  subject: commit.subject,
  scope: commit.scope,
  class: cls,
  by,
  reason: reason.slice(0, 300),
})

export const fixClassesSummary = (pass: FixClassesPass): string =>
  `${pass.repos} repo(s): ${pass.byRule} fix commit(s) sorted by rule, ${pass.byWorkflow} by workflow, ${pass.left} left for the next pass`
