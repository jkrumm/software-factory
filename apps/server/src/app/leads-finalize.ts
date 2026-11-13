import { leadBranch, leadKey } from '../domains/leads/names.ts'
import type { BranchClosure, FinalizeStep } from '../domains/leads/ports.ts'
import type { QualityStore } from '../domains/quality/store.ts'
import type { EffectOf } from '../domains/work/effects.ts'
import { type IssueId, issueNumber } from '../kernel/ids.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import { type LeadDeps, loadIssue } from './leads.ts'

interface Closing {
  closed: BranchClosure
  shipped: string[]
}

/** The commits every attempt shipped, as quality recorded them: what a squash-merged branch is recognised by. */
async function shippedCommits(quality: QualityStore, issue: IssueId, attempts: number): Promise<string[]> {
  const shipped = new Set<string>()
  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const sha of (await quality.lastShip(issue, attempt))?.commits?.commits ?? []) shipped.add(sha)
  }
  return [...shipped]
}

type FinalizeEffect = EffectOf<'finalize'> & { issueId: IssueId }

/** The branch cleaning alone, for a close whose attempt was finalized while the Issue was open. */
async function cleanClosed(
  deps: LeadDeps,
  issue: IssueId,
  repo: string,
  closing: Closing,
): Promise<Result<void, PortError>> {
  const located = await deps.repos.locate(repo)
  if (!located.ok) return located.error.kind === 'refused' ? ok(undefined) : located
  const cleaned = await deps.branches.clean({ repo: located.value, issue: issueNumber(issue), ...closing })
  return cleaned.ok ? ok(undefined) : cleaned
}

/**
 * `finalize`, once per attempt (and once more when a close plans its own, `closed`), in this order: the repo claim goes back (through capacity's port), so nothing below can
 * keep the next Issue waiting; the lead's terminals are closed, so nothing writes after them; its transcripts are
 * archived; its worktree and branch are removed when clean and on the base, otherwise kept and said so; and when the
 * Issue is closed, the branches of all its leads are cleaned off the remote default's side (`LeadBranches`). Each step is a
 * fact stored when it is done, so a crash between two steps replays to one of each, and a finalize that is done is a no-op.
 * The exception is the close's: an attempt a restart already finalized while the Issue was open skips every step, and
 * only cleans the branches (idempotent), failing so the outbox retries when it cannot.
 */
export async function finalizeLead(deps: LeadDeps, effect: FinalizeEffect): Promise<Result<void, PortError>> {
  const { issueId: issue } = effect
  const { attempt } = effect.payload
  const name = leadKey(issue, attempt)

  const read = await deps.uow.run(async ({ work, leads, quality }) => {
    const finalization = await leads.finalization(issue, attempt)
    const loaded = await loadIssue(work, issue)
    const row = await leads.attempt(issue, attempt)
    const facts = await leads.hookFacts(name)
    const closing: Closing | null =
      loaded?.issue.state === 'closed'
        ? {
            closed:
              loaded.issue.outcome === 'dropped' || loaded.issue.outcome === 'cancelled'
                ? loaded.issue.outcome
                : 'other',
            shipped: await shippedCommits(quality, issue, loaded.issue.attempt),
          }
        : null
    // A worktree is judged against what THIS attempt shipped, closed Issue or not: a squash leaves its branch off the base,
    // and another attempt's landed commit says nothing about this attempt's own commits.
    const shipped = (await quality.lastShip(issue, attempt))?.commits?.commits ?? []
    return ok({ finalization, repo: loaded?.issue.repo ?? null, row, facts, closing, shipped })
  })
  if (!read.ok) return read
  const { finalization, repo, row, facts, closing, shipped } = read.value
  if (finalization?.doneAt) {
    if (!effect.payload.closed || closing === null || repo === null) return ok(undefined)
    return cleanClosed(deps, issue, repo, closing)
  }
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
    if (repo === null || (row?.worktreePath == null && closing === null)) {
      // No worktree was ever made for this attempt, and no branches to clean: nothing to take away.
      const marked = await mark('worktree')
      if (!marked.ok) return marked
    } else {
      const located = await deps.repos.locate(repo)
      if (!located.ok && located.error.kind !== 'refused') return located
      const notes: string[] = []
      let path: string | null = null
      if (row?.worktreePath != null) {
        const removal = located.ok
          ? await deps.worktrees.remove({
              repo: located.value,
              branch: leadBranch(issue, attempt),
              path: row.worktreePath,
              shipped,
            })
          : ok({ kept: `the repo ${repo} cannot be found: ${located.error.detail}`, path: row.worktreePath })
        if (!removal.ok) return removal
        if ('kept' in removal.value) {
          notes.push(removal.value.kept)
          path = removal.value.path
        }
      }
      if (closing !== null && located.ok) {
        const cleaned = await deps.branches.clean({ repo: located.value, issue: issueNumber(issue), ...closing })
        if (cleaned.ok) notes.push(...cleaned.value.kept.map((k) => `branch ${k.branch} kept: ${k.why}`))
        else notes.push(`branches not cleaned: ${cleaned.error.detail}`)
      }
      const marked = await mark('worktree', { kept: notes.join('; ') || null, path })
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
