import { z } from 'zod'
import { IssueTitle } from './issues.ts'

/** The name of an intake source: the path segment of `POST /alert/<source>` and the key of its token. */
export const DoorSource = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'not a source name')
export type DoorSource = z.infer<typeof DoorSource>

/** A NUL, or half of a surrogate pair: what Postgres cannot store in JSON. */
// oxlint-disable-next-line no-control-regex -- the NUL is exactly what is removed
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/**
 * Text from someone else's alert as the factory keeps it: what Postgres cannot store (a NUL, half of a surrogate pair) becomes
 * U+FFFD, other control characters a space, and the ends are trimmed. The door's parsers and the intake both run it, so a name
 * is the same on both sides.
 */
export const cleanText = (text: string): string =>
  text
    .replace(UNSTORABLE, '\ufffd')
    // oxlint-disable-next-line no-control-regex -- exactly what is removed
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim()

/** A monitor's name or an event's id: someone else's text that ends up on a terminal, so bounded and without control characters. */
const Label = z.string().transform(cleanText).pipe(z.string().min(1).max(256))

export const MAX_INTAKE_FACTS_BYTES = 24 * 1024

const MAX_FACTS_DEPTH = 32

/** Facts as Postgres can store them: the characters it refuses become U+FFFD, and nesting past a few levels is cut. */
export function storable(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.replace(UNSTORABLE, '\ufffd')
  if (typeof value !== 'object' || value === null) return value
  if (depth >= MAX_FACTS_DEPTH) return '[too deep]'
  if (Array.isArray(value)) return value.map((item) => storable(item, depth + 1))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key.replace(UNSTORABLE, '\ufffd'), storable(item, depth + 1)]),
  )
}

const fitsFacts = (facts: unknown): boolean => {
  try {
    return Buffer.byteLength(JSON.stringify(facts) ?? '') <= MAX_INTAKE_FACTS_BYTES
  } catch {
    return false
  }
}

/**
 * `POST /intake`, on the socket only: what the door files for one alert. The payload is data: nothing in it picks a repo, a role,
 * a path or a command, so there is no such field here; the repo comes from the registry.
 */
export const IntakeInput = z.strictObject({
  source: DoorSource,
  monitor: Label,
  event: Label,
  status: z.enum(['down', 'up']),
  title: z.string().transform(cleanText).pipe(IssueTitle),
  // The size is that of what is stored: sanitizing can make facts longer (a cut nesting becomes a marker).
  facts: z
    .unknown()
    .default({})
    .transform((facts) => storable(facts))
    .refine(fitsFacts, `facts are larger than ${MAX_INTAKE_FACTS_BYTES} bytes`),
})
export type IntakeInput = z.output<typeof IntakeInput>

/**
 * What the intake did. `unrouted`: no route, counted. `quiet`: routed, but an `up` with no open Issue, counted on the route.
 * `attached`: a signal on the open Issue. `created`: a new Issue. `replayed`: this event was filed before. `settling`: a `down` the
 * project's `heal:` rule waits on (nothing filed yet). `healed`: an `up` that cancelled such a wait.
 */
export const IntakeOutcome = z.enum(['unrouted', 'quiet', 'attached', 'created', 'replayed', 'settling', 'healed'])
export type IntakeOutcome = z.infer<typeof IntakeOutcome>

export const IntakeAck = z.object({ outcome: IntakeOutcome, issue: z.number().int().nullable() })
export type IntakeAck = z.infer<typeof IntakeAck>

/**
 * `POST /intake/report`, on the socket only: what the door tells the server about its sources. `start`: the sources it holds a token
 * for (at boot). `refused`: a 401 for such a source (never a probe). `accepted`: a message that passed auth and was ignored.
 */
export const DoorReport = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start'), sources: z.array(DoorSource).min(1).max(16) }),
  z.strictObject({ kind: z.literal('refused'), source: DoorSource }),
  z.strictObject({ kind: z.literal('accepted'), source: DoorSource }),
])
export type DoorReport = z.infer<typeof DoorReport>

/** `PUT /door/routes`: which repo an alert of this monitor concerns. */
export const DoorRouteInput = z.strictObject({
  source: DoorSource,
  monitor: Label,
  repo: z
    .string()
    .max(1024)
    .regex(/^\/[^\0]*$/, 'not an absolute path'),
})
export type DoorRouteInput = z.output<typeof DoorRouteInput>

/** `DELETE /door/routes`. */
export const DoorRouteKey = z.strictObject({ source: DoorSource, monitor: Label })
export type DoorRouteKey = z.output<typeof DoorRouteKey>

export const DoorRoute = z.object({
  source: z.string(),
  monitor: z.string(),
  repo: z.string(),
  /** alerts that filed nothing here (an `up` with no open Issue) */
  quiet: z.number().int(),
  lastQuietAt: z.string().nullable(),
})
export type DoorRoute = z.infer<typeof DoorRoute>

export const DoorRouteList = z.object({ routes: z.array(DoorRoute) })
export type DoorRouteList = z.infer<typeof DoorRouteList>

/** A monitor that raised alerts with no route: what the owner reads to decide what to route. */
export const DoorUnrouted = z.object({
  source: z.string(),
  monitor: z.string(),
  count: z.number().int(),
  lastSeen: z.string(),
  lastTitle: z.string(),
  /** the last known state; null for a row from before it was kept */
  status: z.enum(['down', 'up']).nullable().default(null),
  /** when the current down began */
  downSince: z.string().nullable().default(null),
  /** a group monitor files nothing */
  group: z.boolean().default(false),
  /** the Issue the steward filed for the current down */
  issue: z.number().int().nullable().default(null),
})
export type DoorUnrouted = z.infer<typeof DoorUnrouted>

export const DoorUnroutedList = z.object({ unrouted: z.array(DoorUnrouted) })
export type DoorUnroutedList = z.infer<typeof DoorUnroutedList>
