import { z } from 'zod'
import { Effort, RoleName, Tier } from './roles.ts'

/** Pieces both `index.ts` and `read.ts` build on; split out so neither imports the other. */

/**
 * `cancelled` is a queued or waiting spawn that `factory spawn cancel` ended before any claim; its key is spent. `ended` is never stored: it is a `started` spawn whose agent is gone, derived whenever a spawn is read (its session is
 * `dead`, or its pane is no terminal of the current core). An ended spawn's key is spent.
 */
export const SpawnStatus = z.enum(['queued', 'waiting', 'starting', 'started', 'ended', 'failed', 'cancelled'])
export type SpawnStatus = z.infer<typeof SpawnStatus>

/** Why a queued spawn is not starting although capacity may be there: the queue state or its Issue's claim on the project. */
export const HoldReason = z.enum(['drain', 'pace', 'claim', 'load'])
export type HoldReason = z.infer<typeof HoldReason>

export const Spawn = z.object({
  key: z.string(),
  /** `queued` with a `hold` is held; `starting` is claimed (the Runner is at work); `waiting` is waiting for capacity */
  status: SpawnStatus,
  repo: z.string(),
  /** the path whose space the tab goes into (the repo, unless the spawn named another) */
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

export const SessionState = z.enum(['starting', 'working', 'idle', 'waiting', 'walled', 'blocked', 'stuck', 'dead'])
export type SessionState = z.infer<typeof SessionState>

export const WaitOn = z.enum(['workers', 'deploy', 'owner'])
export type WaitOn = z.infer<typeof WaitOn>

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
