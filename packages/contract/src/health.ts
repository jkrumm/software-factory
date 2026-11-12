import * as z from 'zod'

/**
 * What the Uptime Kuma pusher reads from `GET /health` (`.heartbeat.ok`, `.reason`, `.tickAt`, `.queueMovedAt`): a
 * client outside this repo, so the four names stay. `tickAt` is the last successful tick and `queueMovedAt` the last
 * change of the queue; both are null until there is one. `ok` is false only for a stopped factory; while it is true,
 * `reason` may still say why the factory is not at full pace: `starting`, `deploying`, `starved: …`, `failing: …`.
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

/** One of the door's health lines: what needs a look and is no question for the owner. They inform; they never fail the heartbeat. */
export const HealthLine = z
  .object({ source: z.string(), text: z.string(), since: z.iso.datetime({ offset: true }).nullable() })
  .meta({ id: 'HealthLine' })
export type HealthLine = z.infer<typeof HealthLine>

/** One loop of the runner: when it last passed, how it last failed, how often it runs. */
export const HealthLoop = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    lastOkAt: z.iso.datetime({ offset: true }).nullable(),
    lastPassAt: z.iso.datetime({ offset: true }).nullable().optional(),
    lastError: z.string().nullable(),
    intervalMs: z.number().int().min(0),
  })
  .meta({ id: 'HealthLoop' })
export type HealthLoop = z.infer<typeof HealthLoop>

/** `GET /health`: 200 with `status: ok`, or 503 with `status: unhealthy` and the reason, in the same shape. */
export const Health = z
  .object({
    status: z.enum(['ok', 'unhealthy']),
    /** the deployed commit (`FACTORY_VERSION`), `dev` outside a release */
    version: z.string(),
    reason: z.string().nullable(),
    heartbeat: Heartbeat,
    /** additive (optional so an older server's answer still parses): the door's health lines and the loops; the server always sends both */
    lines: z.array(HealthLine).optional(),
    loops: z.array(HealthLoop).optional(),
  })
  .meta({ id: 'Health' })
export type Health = z.infer<typeof Health>
