import * as z from 'zod'
import { EVENT_KINDS } from './spool.ts'

/** The hook's line as the socket takes it (`POST /events`): the spool's shape, checked with zod on the server side only. */
export const HookEventBody = z
  .object({
    key: z.string().min(1).max(256),
    session: z.string().min(1).max(256),
    kind: z.enum(EVENT_KINDS),
    at: z.iso.datetime({ offset: true }),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'HookEventBody' })
export type HookEventBody = z.infer<typeof HookEventBody>

/** `recorded: false` is a line the server had already (a replay) or one that is no lead's. */
export const HookEventAnswer = z
  .object({ recorded: z.boolean(), reacted: z.string().nullable() })
  .meta({ id: 'HookEventAnswer' })
export type HookEventAnswer = z.infer<typeof HookEventAnswer>

/** What the Stop hook sends the socket before it records the stop (`POST /sessions/:id/stop-check`). */
export const StopCheckBody = z
  .object({ stopHookActive: z.boolean(), backgroundTasks: z.boolean() })
  .meta({ id: 'StopCheckBody' })
export type StopCheckBody = z.infer<typeof StopCheckBody>

export const StopCheck = z.object({ sendBack: z.boolean(), message: z.string().nullable() }).meta({ id: 'StopCheck' })
export type StopCheck = z.infer<typeof StopCheck>

const IssueRef = z.string().regex(/^(issue_)?[1-9][0-9]*$/, 'an Issue is issue_<n> or <n>')
const Call = z.string().trim().min(1).max(128).optional()
const Reason = z.string().trim().min(1).max(4_000)

/** The lead's verbs. Each names the attempt it speaks for: a verb of an earlier attempt is refused. `call` makes a repeated call one event. */
export const CloseBody = z
  .object({ attempt: z.number().int().min(1), outcome: z.enum(['done', 'dropped']), reason: Reason, call: Call })
  .meta({ id: 'CloseBody' })
export type CloseBody = z.infer<typeof CloseBody>

export const DeferBody = z
  .object({
    attempt: z.number().int().min(1),
    until: z.iso.datetime({ offset: true }).optional(),
    after: z.array(IssueRef).min(1).max(20).optional(),
    call: Call,
  })
  .refine((body) => (body.until === undefined) !== (body.after === undefined), 'give either until or after')
  .meta({ id: 'DeferBody' })
export type DeferBody = z.infer<typeof DeferBody>

export const BlockBody = z
  .object({ attempt: z.number().int().min(1), reason: Reason, call: Call })
  .meta({ id: 'BlockBody' })
export type BlockBody = z.infer<typeof BlockBody>

/** What recording a lead's verb did; `refused` carries the machine's reason in `detail`. */
export const LeadVerbAnswer = z
  .object({
    result: z.enum(['applied', 'refused', 'ignored', 'replayed']),
    detail: z.string().nullable(),
    issue: z.object({
      id: z.string(),
      state: z.string(),
      waitReason: z.string().nullable(),
      outcome: z.string().nullable(),
      version: z.number().int(),
    }),
    event: z.object({ id: z.string(), key: z.string(), version: z.number().int().nullable() }),
  })
  .meta({ id: 'LeadVerbAnswer' })
export type LeadVerbAnswer = z.infer<typeof LeadVerbAnswer>

export const SESSION_STATES = ['starting', 'working', 'idle', 'compacted', 'gone'] as const

/** One lead as the factory follows it: where it runs and the session state its hook events derive. */
export const LeadSession = z
  .object({
    issue: z.string(),
    attempt: z.number().int(),
    key: z.string(),
    terminal: z.string().nullable(),
    worktree: z.string().nullable(),
    branch: z.string(),
    state: z.enum(SESSION_STATES),
    turns: z.number().int(),
    lastEventAt: z.string().nullable(),
  })
  .meta({ id: 'LeadSession' })
export type LeadSession = z.infer<typeof LeadSession>

/** One pass of the lead tick, for the scenarios' entry (`POST /internal/test/tick`). */
export const TickAnswer = z
  .object({
    outbox: z.object({ ran: z.number().int(), failed: z.number().int() }),
    replayed: z.number().int(),
    lost: z.number().int(),
  })
  .meta({ id: 'TickAnswer' })
export type TickAnswer = z.infer<typeof TickAnswer>
