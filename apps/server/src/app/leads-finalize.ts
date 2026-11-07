import { leadBranch, leadKey } from '../domains/leads/names.ts'
import type { FinalizeStep } from '../domains/leads/ports.ts'
import type { EffectOf } from '../domains/work/effects.ts'
import type { IssueId } from '../kernel/ids.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import { type LeadDeps, loadIssue } from './leads.ts'

type FinalizeEffect = EffectOf<'finalize'> & { issueId: IssueId }

/**
 * `finalize`, once per attempt, in this order: the repo claim goes back (through capacity's port), so nothing below can
 * keep the next Issue waiting; the lead's terminals are closed, so nothing writes after them; its transcripts are
 * archived; its worktree and branch are removed when clean and on the base, otherwise kept and said so. Each step is a
 * fact stored when it is done, so a crash between two steps replays to one of each, and a finalize that is done is a no-op.
 */
export async function finalizeLead(deps: LeadDeps, effect: FinalizeEffect): Promise<Result<void, PortError>> {
  const { issueId: issue } = effect
  const { attempt } = effect.payload
  const name = leadKey(issue, attempt)

  const read = await deps.uow.run(async ({ work, leads }) => {
    const finalization = await leads.finalization(issue, attempt)
    const loaded = await loadIssue(work, issue)
    const row = await leads.attempt(issue, attempt)
    const facts = await leads.hookFacts(name)
    return ok({ finalization, repo: loaded?.issue.repo ?? null, row, facts })
  })
  if (!read.ok) return read
  const { finalization, repo, row, facts } = read.value
  if (finalization?.doneAt) return ok(undefined)
  const done = (step: FinalizeStep) => finalization?.steps[step] !== undefined

  const mark = async (
    step: FinalizeStep,
    detail?: { archived?: number; kept?: string | null; path?: string | null },
  ) => {
    const at = deps.clock.now()
    return deps.uow.run(async ({ leads }) => {
      await leads.markStep(issue, attempt, step, at, detail)
      return ok(undefined)
    })
  }

  if (!done('claim')) {
    const released = await deps.claims.release({ issue, attempt })
    if (!released.ok) return released
    const marked = await mark('claim')
    if (!marked.ok) return marked
  }

  if (!done('terminals')) {
    const closed = await deps.terminals.close(name)
    if (!closed.ok) return closed
    const marked = await mark('terminals')
    if (!marked.ok) return marked
  }

  if (!done('transcripts')) {
    // Every session the lead ran (a resume or a compaction starts another), as its hooks reported them.
    const sessions = facts
      .filter((fact) => fact.kind === 'session_started')
      .flatMap((fact) => {
        const claudeSession = fact.payload.claudeSessionId
        const transcriptPath = fact.payload.transcriptPath
        return typeof claudeSession === 'string' && typeof transcriptPath === 'string'
          ? [{ claudeSession, transcriptPath }]
          : []
      })
    const unique = [...new Map(sessions.map((session) => [session.claudeSession, session])).values()]
    const archived = await deps.transcripts.archive({ issue, attempt, account: row?.account ?? null, sessions: unique })
    if (!archived.ok) return archived
    const marked = await mark('transcripts', { archived: archived.value.archived })
    if (!marked.ok) return marked
  }

  if (!done('worktree')) {
    if (repo === null || row?.worktreePath == null) {
      // No worktree was ever made for this attempt: nothing to take away.
      const marked = await mark('worktree')
      if (!marked.ok) return marked
    } else {
      const located = await deps.repos.locate(repo)
      if (!located.ok && located.error.kind !== 'refused') return located
      const removal = located.ok
        ? await deps.worktrees.remove({ repo: located.value, branch: leadBranch(issue, attempt) })
        : ok({ kept: `the repo ${repo} cannot be found: ${located.error.detail}`, path: row.worktreePath })
      if (!removal.ok) return removal
      const kept = 'kept' in removal.value ? removal.value : null
      const marked = await mark('worktree', { kept: kept?.kept ?? null, path: kept?.path ?? null })
      if (!marked.ok) return marked
    }
  }

  const at = deps.clock.now()
  const finished = await deps.uow.run(async ({ leads }) => {
    await leads.markFinalized(issue, attempt, at)
    return ok(undefined)
  })
  return finished.ok ? ok(undefined) : finished
}
