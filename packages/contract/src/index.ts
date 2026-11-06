import { z } from 'zod'
import { Quota, QueueState, SessionState, Spawn, WaitOn } from './core.ts'
import { FleetBody } from './fleet.ts'
import { StatusIssue } from './issues.ts'

export * from './core.ts'
export * from './door.ts'
export * from './fleet.ts'
export * from './issues.ts'
export * from './notify.ts'
export * from './plan.ts'
export * from './projects.ts'
export * from './read.ts'
export * from './roles.ts'
export { EVENT_KINDS, type EventKind } from './spool.ts'

/**
 * The shape of every response body. The server builds each response through its schema and the CLI parses each one
 * with the same schema, so a drift between the two releases is a parse failure (exit 9), never a cast that lies.
 */

export const SpawnList = z.object({ spawns: z.array(Spawn) })
export type SpawnList = z.infer<typeof SpawnList>

/** A session with its state derived at read time. `id` is `FACTORY_SESSION`: a spawn key, or the name `rd` gave the pane. */
export const Session = z.object({
  id: z.string(),
  state: SessionState,
  /** the open wait, when the state is `waiting` */
  wait: WaitOn.nullable(),
  /** turns started so far */
  turn: z.number().int(),
  lastEventAt: z.string(),
  /** the spawn the factory started it from; null for an `rd` session */
  spawn: z.string().nullable(),
  pane: z.string().nullable(),
  tab: z.string().nullable(),
  /** what `usage` joins on */
  claudeSessionId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  cwd: z.string().nullable(),
  /** what the runner last said about the agent, and when */
  agentStatus: z.string().nullable(),
  agentSeenAt: z.string().nullable(),
  /** the role of its spawn, else the `FACTORY_ROLE` its pane reported */
  role: z.string().nullable(),
  /** the account it runs on: its spawn's, else what the hook reported */
  account: z.string().nullable(),
  /** the session that started it */
  parent: z.string().nullable(),
  /** since when it is in this state (the event that put it there); null while `starting` */
  since: z.string().nullable(),
})
export type Session = z.infer<typeof Session>

export const SessionList = z.object({ sessions: z.array(Session) })
export type SessionList = z.infer<typeof SessionList>

export const EventAck = z.object({ duplicate: z.boolean() })
export type EventAck = z.infer<typeof EventAck>

export const QuotaList = z.object({ quota: z.array(Quota) })
export type QuotaList = z.infer<typeof QuotaList>

/**
 * What the Uptime Kuma heartbeat posts (a pusher reads these four names; they stay): `ok` is true when the last successful tick is under
 * 30 minutes old and no spawn has been due for 30 minutes without a change of status. `reason` names the failing half, `tickAt` is the
 * last successful tick (null until one), `queueMovedAt` the newest status change of any spawn (null: none).
 */
export const Heartbeat = z.object({
  ok: z.boolean(),
  reason: z.string().nullable(),
  tickAt: z.string().nullable(),
  queueMovedAt: z.string().nullable(),
})
export type Heartbeat = z.infer<typeof Heartbeat>

/**
 * `GET /health`: 200 with `status: ok`, or 503 with `status: unhealthy` and the reason, in the same shape. A tick
 * that has not succeeded within three intervals (or a pass that has run past its limit) makes the server unhealthy.
 */
export const Health = z.object({
  status: z.enum(['ok', 'unhealthy']),
  version: z.string(),
  reason: z.string().nullable(),
  tick: z.object({
    lastSuccessAt: z.string().nullable(),
    lastError: z.object({ at: z.string(), message: z.string() }).nullable(),
  }),
  heartbeat: Heartbeat,
})
export type Health = z.infer<typeof Health>

export const PromptStatus = z.enum(['pending', 'typing', 'sent', 'delivered', 'failed'])
export type PromptStatus = z.infer<typeof PromptStatus>

/** Text typed (or to be typed) into a session: `id` is its idempotency key. */
export const Prompt = z.object({
  id: z.string(),
  session: z.string(),
  /** what asked for it: `note` for `factory session note`, else the rule */
  source: z.string(),
  via: z.enum(['type', 'resume']),
  text: z.string(),
  status: PromptStatus,
  createdAt: z.string(),
  /** times it was typed: a second one is the retry */
  sentCount: z.number().int(),
  sentAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  error: z.string().nullable(),
})
export type Prompt = z.infer<typeof Prompt>

/** `POST /sessions/:id/stop-check`, asked by the `Stop` hook over the socket. */
export const StopCheck = z.object({
  /** exit 2 with `message`: the session has workers it neither waits for nor collected */
  sendBack: z.boolean(),
  message: z.string().nullable(),
})
export type StopCheck = z.infer<typeof StopCheck>

/** `GET /status`: one screen. Sessions are ordered walled, blocked, stuck first; dead ones are left out. */
export const Status = z.object({
  now: z.string(),
  /** the asks: what waits on a decision of the owner, one line each (RS3) */
  attention: z.array(z.string()),
  /** the health line: parks, a silent or over-budget lead, regressions and machine failures, one line each; never an ask */
  health: z.array(z.string()).default([]),
  sessions: z.array(Session),
  queue: z.object({ effective: QueueState, spawns: z.array(Spawn) }),
  accounts: z.array(Quota),
  /** open Issues, and a closed one whose finalize failed in the last day */
  issues: z.array(StatusIssue),
  /** open Issues beyond the ones listed */
  issuesMore: z.number().int(),
  /** prompts not yet delivered, and those that failed in the last day */
  notes: z.array(Prompt),
  /** prompts beyond the ones listed */
  notesMore: z.number().int(),
  /** the steward's acts of the last 24 h, counted from the Issues' inbox and events: wakes, nudges and requeues, and Issues whose retries ran out and went to the owner. A server of before the steward sends none */
  steward: z.object({ acts: z.number().int(), exhausted: z.number().int() }).nullish(),
})
export type Status = z.infer<typeof Status>

/**
 * `PUT /slots/:id` on the socket: a request for a test slot and the renewal of the one held, in one call (FL7). `granted`
 * false means the caller waits (`ahead` callers are in front of it) and asks again; granted, `slot` is its number and the
 * lease runs `leaseMs` from this call.
 */
export const Slot = z.object({
  id: z.string(),
  name: z.string(),
  granted: z.boolean(),
  slot: z.number().int().nullable(),
  leaseMs: z.number().int(),
  ahead: z.number().int(),
})
export type Slot = z.infer<typeof Slot>

/** `DELETE /slots/:id`: gives a slot back; `released` is false when the caller held nothing (its lease had expired). */
export const SlotRelease = z.object({ released: z.boolean() })
export type SlotRelease = z.infer<typeof SlotRelease>

/** `code` names a refusal a client can act on (`key_spent`); `spawn` is the stored spawn it concerns. */
export const ErrorBody = z.object({ error: z.string(), code: z.string().optional(), spawn: Spawn.optional() })
export type ErrorBody = z.infer<typeof ErrorBody>

/** `GET /fleet` (`packages/contract/src/fleet.ts`): the read model, with the quota and the queue as `factory status` has them. */
export const Fleet = FleetBody.extend({
  quota: z.array(Quota),
  queue: z.object({
    effective: QueueState,
    spawns: z.array(Spawn),
  }),
})
export type Fleet = z.infer<typeof Fleet>
