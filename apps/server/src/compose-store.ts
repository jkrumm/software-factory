import type { SQL } from 'bun'
import { postgresCheckpointStore } from './adapters/postgres/checkpoint-store.ts'
import { postgresCollectionStore } from './adapters/postgres/collection-store.ts'
import { postgresCapacityStore } from './adapters/postgres/capacity-store.ts'
import { postgresDeskStore } from './adapters/postgres/desk-store.ts'
import { postgresErrandStore } from './adapters/postgres/errand-store.ts'
import { postgresLoopStore } from './adapters/postgres/loop-store.ts'
import { postgresPlanningStore } from './adapters/postgres/planning-store.ts'
import { postgresReviewStore } from './adapters/postgres/review-store.ts'
import { postgresUnitOfWork } from './adapters/postgres/unit-of-work.ts'
import { postgresVisitStore } from './adapters/postgres/visit-store.ts'
import { postgresWorkStore } from './adapters/postgres/work-store.ts'
import { postgresIntakeStore } from './adapters/intake/store.ts'
import { postgresLeadStore } from './adapters/leads/store.ts'
import { postgresQualityStore } from './adapters/quality/store.ts'
import { loopReads } from './read/loops.ts'
import { readIssues } from './read/planning.ts'

/** The composition's unit of work: each domain's store on the transaction's connection. */
export const composeUow = (sql: SQL) =>
  postgresUnitOfWork(sql, (tx) => ({
    work: postgresWorkStore(tx),
    planning: postgresPlanningStore(tx),
    capacity: postgresCapacityStore(tx),
    reads: readIssues(tx),
    checkpoints: postgresCheckpointStore(tx),
    collections: postgresCollectionStore(tx),
    errands: postgresErrandStore(tx),
    leads: postgresLeadStore(tx),
    quality: postgresQualityStore(tx),
    intake: postgresIntakeStore(tx),
    loops: postgresLoopStore(tx),
    loopReads: loopReads(tx),
    visits: postgresVisitStore(tx),
    reviews: postgresReviewStore(tx),
    desk: postgresDeskStore(tx),
  }))

export type ServerUow = ReturnType<typeof composeUow>
