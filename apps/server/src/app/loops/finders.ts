import type { Finder, FindersModel } from '@software-factory/contract'
import { verdictOf } from '../../domains/improve/finders.ts'
import type { LoopReads } from './stores.ts'

const ORDER = { muted: 0, probation: 1, open: 2 } as const
const by = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Every finder the friction and hygiene loops have filed for, with its verdict: muted first.
 */
export async function finders(reads: Pick<LoopReads, 'allClassIssues'>, now: Date): Promise<FindersModel> {
  const all = await reads.allClassIssues()
  const finders: Finder[] = all.map((entry) => {
    const verdict = verdictOf(entry.issues, now)
    return {
      loop: entry.loop,
      finder: entry.class,
      status: verdict.status,
      issues: entry.issues.length,
      decided: verdict.decided,
      noise: verdict.noise,
      share: verdict.share,
      open: verdict.open,
      mutedUntil: verdict.mutedUntil?.toISOString() ?? null,
    }
  })
  finders.sort((a, b) => ORDER[a.status] - ORDER[b.status] || by(a.loop, b.loop) || by(a.finder, b.finder))
  return { at: now.toISOString(), finders }
}
