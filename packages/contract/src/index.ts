import { z } from 'zod'

/**
 * The shape of every response body. The server builds each response through its schema and the CLI parses each one
 * with the same schema, so a drift between the two releases is a parse failure (exit 9), never a cast that lies.
 */

export const SpawnStatus = z.enum(['queued', 'waiting', 'starting', 'started', 'failed'])
export type SpawnStatus = z.infer<typeof SpawnStatus>

export const Spawn = z.object({
  key: z.string(),
  status: SpawnStatus,
  account: z.string().nullable(),
  resumeAt: z.string().nullable(),
  attempts: z.number().int(),
  session: z.string().nullable(),
  error: z.string().nullable(),
})
export type Spawn = z.infer<typeof Spawn>

export const SpawnList = z.object({ spawns: z.array(Spawn) })
export type SpawnList = z.infer<typeof SpawnList>

export const SessionState = z.enum(['starting', 'working', 'idle', 'walled', 'dead'])
export type SessionState = z.infer<typeof SessionState>

export const Session = z.object({ id: z.string(), state: SessionState, lastEventAt: z.string() })
export type Session = z.infer<typeof Session>

export const EventAck = z.object({ duplicate: z.boolean() })
export type EventAck = z.infer<typeof EventAck>

export const CapacityAck = z.object({
  account: z.string(),
  weeklyUsed: z.number(),
  fiveHourUsed: z.number(),
  resetsAt: z.string(),
})
export type CapacityAck = z.infer<typeof CapacityAck>

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
