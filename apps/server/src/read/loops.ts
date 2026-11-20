import type { SQL } from 'bun'
import { hygieneReads } from './hygiene-reads.ts'
import { improveReads } from './improve-reads.ts'
import { leadLoopReads } from './lead-loop-reads.ts'
import { planningLoopReads } from './planning-loop-reads.ts'

/** What the loops read across other domains' tables: each domain's slice, one reader (`LoopReads` of `app/loops/stores.ts`). Read-only SQL on the caller's transaction. */
export function loopReads(tx: SQL) {
  return { ...planningLoopReads(tx), ...leadLoopReads(tx), ...improveReads(tx), ...hygieneReads(tx) }
}
