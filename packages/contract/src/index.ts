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
  status: SpawnStatus,
  role: RoleName,
  tier: Tier,
  effort: Effort,
  hold: HoldReason.nullable(),
  account: z.string().nullable(),
  resumeAt: z.string().nullable(),
  attempts: z.number().int(),
  session: z.string().nullable(),
  error: z.string().nullable(),
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
  /** what `usage` joins on */
  claudeSessionId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  cwd: z.string().nullable(),
  /** what herdr last said about the agent, and when */
  herdrStatus: z.string().nullable(),
  herdrSeenAt: z.string().nullable(),
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

export const ErrorBody = z.object({ error: z.string() })
export type ErrorBody = z.infer<typeof ErrorBody>
