import * as z from 'zod'
import { IssueRef } from './planning.ts'

/** Why a queued Issue stays queued. The word is "stays queued"; "hold" is retired. */
export const QUEUE_REASONS = [
  'chain',
  'line',
  'finalizing',
  'unknown_project',
  'drain',
  'load',
  'memory',
  'claim',
  'window',
  'cap',
] as const

export const QueueReason = z.object({
  kind: z.enum(QUEUE_REASONS),
  /** names the reason and its numbers: "the host is short of memory: swapouts 3100 MiB/300s (ceiling 2048), …" */
  message: z.string(),
  /** when a reading says the reason may end */
  opensAt: z.string().nullable(),
})

/** One queued Issue in queue order. */
export const QueueEntry = z
  .object({
    issue: IssueRef,
    repo: z.string(),
    project: z.string().nullable(),
    kind: z.string(),
    /** the owner's `prio`; 0 when none */
    prio: z.number().int(),
    /** null: nothing keeps it out, it is admitted when it is its turn */
    reason: QueueReason.nullable(),
    /** the account it would run on, when nothing keeps it out */
    account: z.string().nullable(),
  })
  .meta({ id: 'QueueEntry' })
export type QueueEntry = z.infer<typeof QueueEntry>

export const QueueOrder = z
  .object({ queue: z.array(QueueEntry), notes: z.array(z.string()) })
  .meta({ id: 'QueueOrder' })
export type QueueOrder = z.infer<typeof QueueOrder>

export const AdmitAnswer = z
  .object({
    admitted: z.array(z.object({ issue: IssueRef, attempt: z.number().int(), account: z.string(), repo: z.string() })),
    queue: z.array(QueueEntry),
    notes: z.array(z.string()),
  })
  .meta({ id: 'AdmitAnswer' })
export type AdmitAnswer = z.infer<typeof AdmitAnswer>

export const AccountView = z.object({
  account: z.string(),
  enabled: z.boolean(),
  authOk: z.boolean(),
  fiveHourUsed: z.number().nullable(),
  weeklyUsed: z.number().nullable(),
  fiveHourResetsAt: z.string().nullable(),
  weeklyResetsAt: z.string().nullable(),
  exhaustedUntil: z.string().nullable(),
  sampledAt: z.string().nullable(),
  readAt: z.string(),
  /** false once the poll has not confirmed it for 10 minutes: it admits nothing */
  fresh: z.boolean(),
  /** whether it takes a new lead now, and if not why */
  open: z.boolean(),
  why: z.string().nullable(),
  opensAt: z.string().nullable(),
})

export type AccountView = z.infer<typeof AccountView>

export const QueueStatesView = z
  .object({
    global: z.enum(['run', 'pace', 'drain']),
    projects: z.record(z.string(), z.enum(['run', 'pace', 'drain'])),
  })
  .meta({ id: 'QueueStatesView' })
export type QueueStatesView = z.infer<typeof QueueStatesView>

export const QueueSetBody = z
  .object({
    /** a project name; absent: the whole queue */
    project: z.string().min(1).nullable().default(null),
    state: z.enum(['run', 'pace', 'drain']),
  })
  .meta({ id: 'QueueSetBody' })
export type QueueSetBody = z.infer<typeof QueueSetBody>

export const CapacityView = z
  .object({
    accounts: z.array(AccountView),
    host: z.object({
      load: z.number().nullable(),
      loadCeiling: z.number(),
      memory: z.object({ swapoutMbPer300s: z.number(), swapUsedPct: z.number() }).nullable(),
      memoryCeilings: z.object({ swapoutMbPer300s: z.number(), swapUsedPct: z.number() }),
      notes: z.array(z.string()),
    }),
    /** who sits in which repo, on which account */
    seats: z.array(
      z.object({
        issue: IssueRef,
        repo: z.string(),
        account: z.string().nullable(),
        urgent: z.boolean(),
        takenAt: z.string(),
      }),
    ),
    leadsPerAccount: z.number().int(),
    queue: QueueStatesView,
    slots: z.object({
      total: z.number().int(),
      held: z.array(z.object({ slot: z.number().int(), name: z.string(), grantedAt: z.string() })),
      waiting: z.array(z.string()),
      lines: z.array(z.string()),
    }),
  })
  .meta({ id: 'CapacityView' })
export type CapacityView = z.infer<typeof CapacityView>

export const RefreshAnswer = z.object({ accounts: z.array(AccountView) }).meta({ id: 'RefreshAnswer' })
export type RefreshAnswer = z.infer<typeof RefreshAnswer>

/** The default run limit of a test-slot command: 30 minutes. */
export const DEFAULT_SLOT_RUN_MS = 30 * 60_000

export const SlotBody = z
  .object({
    name: z.string().min(1).max(200),
    cwd: z.string().min(1).max(4096).optional(),
    limitMs: z
      .number()
      .int()
      .min(1)
      .max(24 * 3_600_000)
      .optional(),
  })
  .meta({ id: 'SlotBody' })
export type SlotBody = z.infer<typeof SlotBody>

export const Slot = z
  .object({
    id: z.string(),
    name: z.string(),
    granted: z.boolean(),
    slot: z.number().int().nullable(),
    /** a holder that does not call again within this long loses the slot */
    leaseMs: z.number().int(),
    /** callers in line before this one */
    ahead: z.number().int(),
    /** how long the command may run once granted */
    runMs: z.number().int(),
  })
  .meta({ id: 'Slot' })
export type Slot = z.infer<typeof Slot>

export const SlotRelease = z.object({ released: z.boolean() }).meta({ id: 'SlotRelease' })
export type SlotRelease = z.infer<typeof SlotRelease>
