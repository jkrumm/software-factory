import type { FindingClass, FindingClassesModel } from '@software-factory/contract'
import { verdictOf } from '../../domains/loops/classes.ts'
import type { LoopReads } from '../../domains/loops/ports.ts'

const ORDER = { held: 0, probation: 1, open: 2 } as const
const by = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Every finding class the friction and hygiene loops have filed, with the verdict they hold it to: held first. */
export async function findingClasses(
  reads: Pick<LoopReads, 'allClassIssues'>,
  now: Date,
): Promise<FindingClassesModel> {
  const all = await reads.allClassIssues()
  const classes: FindingClass[] = all.map((entry) => {
    const verdict = verdictOf(entry.issues, now)
    return {
      loop: entry.loop,
      class: entry.class,
      status: verdict.status,
      issues: entry.issues.length,
      decided: verdict.decided,
      noise: verdict.noise,
      share: verdict.share,
      open: verdict.open,
      heldUntil: verdict.heldUntil?.toISOString() ?? null,
    }
  })
  classes.sort((a, b) => ORDER[a.status] - ORDER[b.status] || by(a.loop, b.loop) || by(a.class, b.class))
  return { at: now.toISOString(), classes }
}
