import type { HygieneReads, HygieneStore } from '../../domains/hygiene/ports.ts'
import type { ImproveReads, ImproveStore } from '../../domains/improve/ports.ts'
import type { LeadLoopReads, ReaperStore } from '../../domains/leads/ports.ts'
import type { CallStore, PlanningLoopReads } from '../../domains/planning/ports.ts'

/** The loops' own tables (`loops` of the unit of work): each domain's slice, one adapter (`adapters/postgres/loop-store.ts`). */
export type LoopStore = HygieneStore & ImproveStore & CallStore & ReaperStore

/** The loops' read-only SQL on other domains' tables (`loopReads`): each domain's slice, one reader (`read/loops.ts`). */
export type LoopReads = HygieneReads & ImproveReads & PlanningLoopReads & LeadLoopReads
