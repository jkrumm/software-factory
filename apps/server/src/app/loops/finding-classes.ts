import type { FindingClass, FindingClassesModel } from '@software-factory/contract'
import { verdictOf } from '../../domains/loops/classes.ts'
import type { LoopReads } from '../../domains/loops/ports.ts'

const ORDER = { held: 0, probation: 1, open: 2 } as const
const NO_STARTS: NonNullable<FindingClass['seat']> = {
  starts: 0,
  movedUp: 0,
  finishedWatches: 0,
  finishedPassRate: null,
  windowStarts: 0,
  windowMovedUp: 0,
  windowShare: null,
  out: false,
  why: null,
}
const by = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Where the hygiene classes' Issues start (`read/finding-seats.ts`), by the loop's class name, and the bound it was judged against. */
export interface ClassSeats {
  bound: number | null
  byClass: ReadonlyMap<string, NonNullable<FindingClass['seat']>>
}

/**
 * Every finding class the friction and hygiene loops have filed, with the verdict they hold it to: held first. A hygiene
 * class carries where its Issues start; a class with no started lead yet has no figures and starts light.
 */
export async function findingClasses(
  reads: Pick<LoopReads, 'allClassIssues'>,
  now: Date,
  seats: ClassSeats = { bound: null, byClass: new Map() },
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
      seat: entry.loop === 'hygiene' ? (seats.byClass.get(entry.class) ?? NO_STARTS) : null,
    }
  })
  classes.sort((a, b) => ORDER[a.status] - ORDER[b.status] || by(a.loop, b.loop) || by(a.class, b.class))
  return { at: now.toISOString(), bound: seats.bound, classes }
}
