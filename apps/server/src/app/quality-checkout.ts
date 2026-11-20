import type { LeadAttempt, LeadStore } from '../domains/leads/ports.ts'
import type { BranchCut, LeadCheckout } from '../domains/quality/ports.ts'
import { ok } from '../kernel/result.ts'
import type { UnitOfWork } from './unit-of-work.ts'

/**
 * Quality's view of the lead's package: where an attempt worked, read from the lead attempt rows (the leads store, never
 * a query into its tables). The branch is the lead's branch, the cut the commit its worktree was cut from, and the repo
 * the directory it located inside the allowed roots. The Issue's cut is its first attempt's, and the branches are every
 * attempt's up to this one: what an earlier attempt landed is this Issue's work too.
 */
export function leadCheckoutOf(uow: UnitOfWork<{ leads: LeadStore }>): LeadCheckout {
  return {
    of: (issue, attempt) =>
      uow.run(async ({ leads }) => {
        const rows: LeadAttempt[] = []
        for (let n = 1; n <= attempt; n++) {
          const row = await leads.attempt(issue, n)
          if (row) rows.push(row)
        }
        const row = rows.find((one) => one.attempt === attempt)
        if (!row) return ok(null)
        const branches: BranchCut[] = rows
          .flatMap((one) => (one.baseSha ? [{ branch: one.branch, cut: one.baseSha }] : []))
          .reverse()
        return ok({
          // Every attempt works in the Issue's one repo: one made before this attempt's worktree knows the directory too.
          repo: row.repoPath ?? rows.findLast((one) => one.repoPath)?.repoPath ?? null,
          branch: row.branch,
          cut: row.baseSha,
          issueCut: branches.at(-1)?.cut ?? null,
          branches,
        })
      }),
  }
}
