import type { SQL } from 'bun'
import { postgresCallStore } from './call-store.ts'
import { postgresHygieneStore } from './hygiene-store.ts'
import { postgresImproveStore } from './improve-store.ts'
import { postgresReaperStore } from './reaper-store.ts'

/** The loops' own tables on the transaction's connection: each domain's slice of them, one object (`LoopStore` of `app/loops/stores.ts`). */
export function postgresLoopStore(tx: SQL) {
  return {
    ...postgresCallStore(tx),
    ...postgresHygieneStore(tx),
    ...postgresImproveStore(tx),
    ...postgresReaperStore(tx),
  }
}
