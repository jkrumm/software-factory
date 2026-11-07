import type { LeadSession } from '@software-factory/contract'
import { leadBranch, leadKey } from '../domains/leads/names.ts'
import { deriveSession } from '../domains/leads/session.ts'
import type { IssueId } from '../kernel/ids.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import { type LeadDeps, loadIssue } from './leads.ts'

/** The current attempt's lead and the session state its hook events derive; null when the Issue has no lead yet. */
export async function leadSession(deps: LeadDeps, issue: IssueId): Promise<Result<LeadSession | null, PortError>> {
  return deps.uow.run(async ({ work, leads }) => {
    const loaded = await loadIssue(work, issue)
    if (!loaded || loaded.issue.attempt < 1) return ok(null)
    const { attempt } = loaded.issue
    const row = await leads.attempt(issue, attempt)
    if (!row) return ok(null)
    const name = leadKey(issue, attempt)
    const view = deriveSession(await leads.hookFacts(name))
    return ok({
      issue,
      attempt,
      key: name,
      terminal: row.terminal,
      worktree: row.worktreePath,
      branch: leadBranch(issue, attempt),
      state: view.state,
      turns: view.turns,
      lastEventAt: view.lastEventAt?.toISOString() ?? null,
    })
  })
}
