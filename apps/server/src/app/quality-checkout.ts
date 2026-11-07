import type { LeadCheckout } from '../domains/quality/ports.ts'
import type { LeadStore } from '../domains/leads/ports.ts'
import { ok } from '../kernel/result.ts'
import type { UnitOfWork } from './unit-of-work.ts'

/**
 * Quality's view of the lead's package: where an attempt worked, read from the lead attempt row (the leads store, never
 * a query into its tables). The branch is the lead's branch, the cut the commit its worktree was cut from, and the repo
 * the directory it located inside the allowed roots.
 */
export function leadCheckoutOf(uow: UnitOfWork<{ leads: LeadStore }>): LeadCheckout {
  return {
    of: (issue, attempt) =>
      uow.run(async ({ leads }) => {
        const row = await leads.attempt(issue, attempt)
        return ok(row ? { repo: row.repoPath, branch: row.branch, cut: row.baseSha } : null)
      }),
  }
}
