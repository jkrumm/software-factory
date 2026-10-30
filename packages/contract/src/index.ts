import { z } from 'zod'
import { Effort, RoleName, Tier } from './roles.ts'

export * from './roles.ts'
export { EVENT_KINDS, type EventKind } from './spool.ts'

/**
 * The shape of every response body. The server builds each response through its schema and the CLI parses each one
 * with the same schema, so a drift between the two releases is a parse failure (exit 9), never a cast that lies.
 */

export const SpawnStatus = z.enum(['queued', 'waiting', 'starting', 'started', 'failed'])
export type SpawnStatus = z.infer<typeof SpawnStatus>

/** Why a queued spawn is not starting although capacity may be there: the queue state, or the one-wave-per-repo rule. */
export const HoldReason = z.enum(['drain', 'pace', 'wave'])
export type HoldReason = z.infer<typeof HoldReason>

export const Spawn = z.object({
  key: z.string(),
  /** `queued` with a `hold` is held; `starting` is claimed (the Runner is at work); `waiting` is waiting for capacity */
  status: SpawnStatus,
  repo: z.string(),
  /** the path whose herdr space the tab goes into (the repo, unless the spawn named another) */
  space: z.string(),
  role: RoleName,
  tier: Tier,
  effort: Effort,
  hold: HoldReason.nullable(),
  account: z.string().nullable(),
  resumeAt: z.string().nullable(),
  attempts: z.number().int(),
  /** the pane the agent runs in, once started (the same as `pane`; kept for the clients that read it) */
  session: z.string().nullable(),
  pane: z.string().nullable(),
  tab: z.string().nullable(),
  workspace: z.string().nullable(),
  error: z.string().nullable(),
  /** the session that asked for it, when one did */
  parent: z.string().nullable(),
})
export type Spawn = z.infer<typeof Spawn>

export const SpawnList = z.object({ spawns: z.array(Spawn) })
export type SpawnList = z.infer<typeof SpawnList>

export const SessionState = z.enum(['starting', 'working', 'idle', 'waiting', 'walled', 'blocked', 'stuck', 'dead'])
export type SessionState = z.infer<typeof SessionState>

export const WaitOn = z.enum(['workers', 'deploy', 'owner'])
export type WaitOn = z.infer<typeof WaitOn>

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
  /** what herdr last said about the agent, and when */
  herdrStatus: z.string().nullable(),
  herdrSeenAt: z.string().nullable(),
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

/** One reading of one account's quota, as stored; `fresh` is false once the poller has not confirmed it for a while. */
export const Quota = z.object({
  account: z.string(),
  enabled: z.boolean(),
  authOk: z.boolean(),
  /** percent of the 5-hour window used; null when the picker has no sample */
  fiveHourUsed: z.number().nullable(),
  weeklyUsed: z.number().nullable(),
  fiveHourResetsAt: z.string().nullable(),
  weeklyResetsAt: z.string().nullable(),
  /** when the picker marked the account exhausted until */
  exhaustedUntil: z.string().nullable(),
  /** when the sample behind the reading was taken */
  sampledAt: z.string().nullable(),
  readAt: z.string(),
  fresh: z.boolean(),
})
export type Quota = z.infer<typeof Quota>

export const QuotaList = z.object({ quota: z.array(Quota) })
export type QuotaList = z.infer<typeof QuotaList>

export const QueueState = z.enum(['run', 'pace', 'drain'])
export type QueueState = z.infer<typeof QueueState>

/**
 * The queue state of a scope: `project` null is the global one. `state` is what was set at exactly this scope (`run`
 * when nothing was), `effective` the most restrictive of it and the scopes above it. `scopes` lists everything set.
 */
export const QueueView = z.object({
  scope: z.object({ project: z.string().nullable() }),
  state: QueueState,
  effective: QueueState,
  setAt: z.string().nullable(),
  scopes: z.array(z.object({ project: z.string().nullable(), state: QueueState, setAt: z.string() })),
})
export type QueueView = z.infer<typeof QueueView>

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
  /** what needs a decision or a look, one line each */
  attention: z.array(z.string()),
  sessions: z.array(Session),
  queue: z.object({ effective: QueueState, spawns: z.array(Spawn) }),
  accounts: z.array(Quota),
  /** prompts not yet delivered, and those that failed in the last day */
  notes: z.array(Prompt),
  /** prompts beyond the ones listed */
  notesMore: z.number().int(),
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

export const ErrorBody = z.object({ error: z.string() })
export type ErrorBody = z.infer<typeof ErrorBody>
