import * as z from 'zod'

/**
 * What the Uptime Kuma pusher reads from `GET /health` (`.heartbeat.ok`, `.reason`, `.tickAt`, `.queueMovedAt`): a
 * client outside this repo, so the four names stay. `tickAt` is the last successful tick and `queueMovedAt` the last
 * change of the queue; both are null until there is one.
 */
export const Heartbeat = z
  .object({
    ok: z.boolean(),
    reason: z.string().nullable(),
    tickAt: z.iso.datetime({ offset: true }).nullable(),
    queueMovedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({ id: 'Heartbeat' })
export type Heartbeat = z.infer<typeof Heartbeat>

/** `GET /health`: 200 with `status: ok`, or 503 with `status: unhealthy` and the reason, in the same shape. */
export const Health = z
  .object({
    status: z.enum(['ok', 'unhealthy']),
    /** the deployed commit (`FACTORY_VERSION`), `dev` outside a release */
    version: z.string(),
    reason: z.string().nullable(),
    heartbeat: Heartbeat,
  })
  .meta({ id: 'Health' })
export type Health = z.infer<typeof Health>
