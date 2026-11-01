import { z } from 'zod'

/** What every source's payload comes down to. The payload is data: nothing in it picks a repo, a role, a path or a command. */
export interface Alert {
  /** the stable name the registry routes by */
  monitor: string
  /** unique per occurrence: a retry of the same event has the same one */
  event: string
  status: 'down' | 'up'
  title: string
  /** what a lead is told, picked field by field from the payload */
  facts: Record<string, unknown>
}

export type Parsed = { kind: 'alert'; alert: Alert } | { kind: 'ignore'; reason: string }

/** A payload that is not the source's shape; the message names the field, never its value. */
export class PayloadError extends Error {}

export type Parser = (payload: unknown) => Parsed

const MAX_NAME_CHARS = 256
const MAX_TITLE_CHARS = 500
const MAX_TEXT_CHARS = 1500
const MAX_LINK_CHARS = 1024

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function shape<S extends z.ZodType>(schema: S, payload: unknown): z.output<S> {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new PayloadError(z.prettifyError(parsed.error).replace(/\s+/g, ' '))
  return parsed.data
}

const KumaPayload = z.object({
  msg: z.string().nullish(),
  monitor: z
    .object({
      name: z.string().min(1),
      type: z.string().nullish(),
      hostname: z.string().nullish(),
      port: z.union([z.number(), z.string()]).nullish(),
    })
    .nullable(),
  heartbeat: z
    .object({
      status: z.number(),
      time: z.string().min(1),
      msg: z.string().nullish(),
      ping: z.number().nullish(),
      retries: z.number().nullish(),
    })
    .nullable(),
})

/**
 * Uptime Kuma's webhook provider: `{ heartbeat, monitor, msg }`. The monitor's `url` is not read (it can carry credentials), and
 * its name is the key because ids change between syncs. The test message has both keys, null; one that lacks them is not Kuma's; a pending (2) or
 * maintenance (3) beat is neither down nor up.
 */
export const parseKuma: Parser = (payload) => {
  const { monitor, heartbeat, msg } = shape(KumaPayload, payload)
  if (!monitor && !heartbeat) return { kind: 'ignore', reason: 'a test message' }
  if (!monitor || !heartbeat) throw new PayloadError('heartbeat and monitor come together')
  if (heartbeat.status !== 0 && heartbeat.status !== 1) return { kind: 'ignore', reason: 'neither down nor up' }
  const status = heartbeat.status === 0 ? 'down' : 'up'
  const name = clip(monitor.name, MAX_NAME_CHARS)
  const detail = heartbeat.msg ?? msg
  return {
    kind: 'alert',
    alert: {
      monitor: name,
      event: clip(heartbeat.time, MAX_NAME_CHARS),
      status,
      title: clip(detail ? `${name} is ${status}: ${detail}` : `${name} is ${status}`, MAX_TITLE_CHARS),
      facts: {
        msg: msg ? clip(msg, MAX_TEXT_CHARS) : null,
        monitor: { type: monitor.type ?? null, hostname: monitor.hostname ?? null, port: monitor.port ?? null },
        heartbeat: {
          status: heartbeat.status,
          time: heartbeat.time,
          msg: heartbeat.msg ? clip(heartbeat.msg, MAX_TEXT_CHARS) : null,
          ping: heartbeat.ping ?? null,
          retries: heartbeat.retries ?? null,
        },
      },
    },
  }
}

const Instant = z.union([z.string(), z.number()]).transform(String)

const HyperdxPayload = z.object({
  title: z.string().min(1),
  body: z.string().nullish(),
  link: z.string().nullish(),
  state: z.string(),
  startTime: Instant.nullish(),
  endTime: Instant.nullish(),
  eventId: z.string().min(1),
  alertId: z.string().nullish(),
})

/** The 🚨 and ✅ that HyperDX puts in front of a title. */
// oxlint-disable-next-line prefer-regex-literals -- the formatter turns \u escapes in a literal into invisible characters
const TITLE_PREFIX = new RegExp('^(?:\\u{1F6A8}|\\u2705)\\uFE0F?\\s*', 'u')
/** One number at the end of a title (a count, a percentage, a threshold), with what leads into it. */
// oxlint-disable-next-line prefer-regex-literals -- as above
const TRAILING_NUMBER = new RegExp('[\\s:=#(<>\\u2264\\u2265\\-\\u2013\\u2014]*\\d[\\d.,]*%?\\)?$', 'u')

/** Peels the numbers off the end one by one. The caller clips the title, so the quadratic worst case stays small. */
const stripTrailingNumbers = (text: string): string => {
  let rest = text
  for (let next = rest.replace(TRAILING_NUMBER, ''); next !== rest; next = rest.replace(TRAILING_NUMBER, ''))
    rest = next
  return rest.trim()
}

/** HyperDX titles an alert `Alert for "<name>" - <value> ...`: the name is what stays the same from one firing to the next. */
const NAMED_TITLE = /^Alert for "(.+)" - /u

/**
 * The alert's own name: the quoted name of HyperDX's title, or, for a title of another shape, the title without its prefix and
 * the numbers at its end. The value in the title (a count, a percentage) changes with every firing.
 */
export const hyperdxMonitor = (title: string): string => {
  // Cut, not clipped: an ellipsis at the end would stop the trailing numbers from being peeled off.
  const bare = title.slice(0, MAX_TITLE_CHARS).replace(TITLE_PREFIX, '').trim()
  const named = NAMED_TITLE.exec(bare)?.[1]?.trim()
  if (named) return clip(named, MAX_NAME_CHARS)
  return clip(stripTrailingNumbers(bare) || bare, MAX_NAME_CHARS)
}

/**
 * HyperDX's generic webhook, whose body is the template in this package's README. `{{state}}` is `ALERT` while it fires and `OK`
 * when it recovers; the firing and the recovery share an `eventId`, so the event is that id with the window it began in and the
 * status. Any other state is neither.
 */
export const parseHyperdx: Parser = (payload) => {
  const hook = shape(HyperdxPayload, payload)
  if (hook.state !== 'ALERT' && hook.state !== 'OK') return { kind: 'ignore', reason: 'neither firing nor resolved' }
  const status = hook.state === 'ALERT' ? 'down' : 'up'
  const monitor = hyperdxMonitor(hook.title)
  return {
    kind: 'alert',
    alert: {
      monitor,
      event: clip(`${hook.eventId}@${hook.startTime ?? ''}:${status}`, MAX_NAME_CHARS),
      status,
      title: clip(hook.title.replace(TITLE_PREFIX, '').trim() || monitor, MAX_TITLE_CHARS),
      facts: {
        title: clip(hook.title, MAX_TITLE_CHARS),
        body: hook.body ? clip(hook.body, MAX_TEXT_CHARS) : null,
        link: hook.link ? clip(hook.link, MAX_LINK_CHARS) : null,
        alertId: hook.alertId ?? null,
        eventId: hook.eventId,
        window: { start: hook.startTime ?? null, end: hook.endTime ?? null },
      },
    },
  }
}

export const PARSERS: Readonly<Record<string, Parser>> = { kuma: parseKuma, hyperdx: parseHyperdx }
