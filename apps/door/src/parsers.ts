import {
  type AlertRequest,
  cleanText,
  type FeedbackRequest,
  MAX_TEXT_CHARS as MAX_FEEDBACK_CHARS,
} from '@software-factory/contract'
import { z } from 'zod'
import { redactUrls, withoutUserinfo } from './redact.ts'

/** What every source's payload comes down to: an alert request minus its source. The payload is data: nothing in it picks a repo, a role, a path or a command. */
export type Alert = Omit<AlertRequest, 'source' | 'facts'> & {
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
/** A type, a host, a port, a time, an id: short by nature, so a long one is a mistake or an attack, and is cut. */
const MAX_FIELD_CHARS = 128
const MAX_PART_CHARS = 64

/** The first `max` UTF-16 units, never ending inside a surrogate pair (half of one is no text Postgres stores). */
const cut = (text: string, max: number): string => {
  if (text.length <= max) return text
  const end = /[\ud800-\udbff]/.test(text.charAt(max - 1)) ? max - 1 : max
  return text.slice(0, end)
}

/** A short field of a payload as a fact: cut, or null when there is none. */
const field = (text: string | null | undefined): string | null =>
  text ? clip(redactUrls(text), MAX_FIELD_CHARS) : null

/** A piece of an event id: short enough that the pieces and the status after them fit the name a key may have. */
const part = (text: string | null | undefined): string => clip(text ?? '', MAX_PART_CHARS)

/** A name as the factory keeps it, or the source's own name when nothing is left of it: an alert is never refused for its label. */
const name = (text: string, max: number, fallback: string): string => clip(redactUrls(cleanText(text)), max) || fallback

/** Free text as a fact: URLs redacted, then cut. */
const prose = (text: string, max: number): string => clip(redactUrls(text), max)

const clip = (text: string, max: number): string => (text.length > max ? `${cut(text, max - 1)}…` : text)

function shape<S extends z.ZodType>(schema: S, payload: unknown): z.output<S> {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new PayloadError(z.prettifyError(parsed.error).replace(/\s+/g, ' '))
  return parsed.data
}

const KumaPayload = z.object({
  msg: z.string().nullish(),
  monitor: z
    .object({
      name: z.string(),
      type: z.string().nullish(),
      hostname: z.string().nullish(),
      port: z.union([z.number(), z.string()]).nullish(),
    })
    .nullable(),
  heartbeat: z
    .object({
      status: z.number(),
      time: z.string(),
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
  const label = name(monitor.name, MAX_NAME_CHARS, 'kuma')
  const detail = heartbeat.msg ?? msg
  const time = name(heartbeat.time, MAX_FIELD_CHARS, '-')
  return {
    kind: 'alert',
    alert: {
      monitor: label,
      event: time,
      status,
      title: name(
        detail ? `${label} is ${status}: ${detail}` : `${label} is ${status}`,
        MAX_TITLE_CHARS,
        `${label} is ${status}`,
      ),
      facts: {
        msg: msg ? prose(msg, MAX_TEXT_CHARS) : null,
        monitor: {
          type: field(monitor.type),
          hostname: field(monitor.hostname),
          port: typeof monitor.port === 'number' ? monitor.port : field(monitor.port),
        },
        heartbeat: {
          status: heartbeat.status,
          time,
          msg: heartbeat.msg ? prose(heartbeat.msg, MAX_TEXT_CHARS) : null,
          ping: heartbeat.ping ?? null,
          retries: heartbeat.retries ?? null,
        },
      },
    },
  }
}

const Instant = z.union([z.string(), z.number()]).transform(String)

const HyperdxPayload = z.object({
  title: z.string(),
  body: z.string().nullish(),
  link: z.string().nullish(),
  state: z.string(),
  startTime: Instant.nullish(),
  endTime: Instant.nullish(),
  eventId: z.string(),
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
  const bare = cleanText(cut(title, MAX_TITLE_CHARS).replace(TITLE_PREFIX, ''))
  const named = NAMED_TITLE.exec(bare)?.[1]?.trim()
  if (named) return clip(named, MAX_NAME_CHARS)
  return clip(stripTrailingNumbers(bare) || bare, MAX_NAME_CHARS)
}

/**
 * HyperDX's generic webhook, whose body is the template in this package's README. `{{state}}` is `ALERT` while it fires and `OK`
 * when it recovers; the firing and the recovery share an `eventId`, so the event is that id with the window it was evaluated over (start and end) and the
 * status: a re-fire over a later window is a new event, a retry of one notification is the same. Any other state is neither.
 */
export const parseHyperdx: Parser = (payload) => {
  const hook = shape(HyperdxPayload, payload)
  if (hook.state !== 'ALERT' && hook.state !== 'OK') return { kind: 'ignore', reason: 'neither firing nor resolved' }
  const status = hook.state === 'ALERT' ? 'down' : 'up'
  const title = redactUrls(hook.title)
  const monitor = hyperdxMonitor(title) || 'hyperdx'
  const [eventId, startTime, endTime, alertId] = [hook.eventId, hook.startTime, hook.endTime, hook.alertId].map(field)
  return {
    kind: 'alert',
    alert: {
      monitor,
      event: `${part(eventId)}@${part(startTime)}/${part(endTime)}:${status}`,
      status,
      title: name(title.replace(TITLE_PREFIX, ''), MAX_TITLE_CHARS, monitor),
      facts: {
        title: clip(title, MAX_TITLE_CHARS),
        body: hook.body ? prose(hook.body, MAX_TEXT_CHARS) : null,
        // A deep link's query is the search the alert ran: it stays, the userinfo and the fragment do not.
        link: hook.link ? clip(withoutUserinfo(hook.link).replace(/#.*$/s, ''), MAX_LINK_CHARS) : null,
        alertId,
        eventId,
        window: { start: startTime, end: endTime },
      },
    },
  }
}

export const PARSERS: Readonly<Record<string, Parser>> = { kuma: parseKuma, hyperdx: parseHyperdx }

const FeedbackPayload = z.strictObject({
  title: z.string(),
  text: z.string().nullish(),
  version: z.string(),
  route: z.string(),
  link: z.string().nullish(),
})

/** A required line of the envelope as the factory keeps it: cleaned and cut, and a payload that leaves nothing of it is refused. */
const required = (label: string, text: string, max: number): string => {
  const value = cut(cleanText(text), max)
  if (!value) throw new PayloadError(`${label}: empty`)
  return value
}

/**
 * An app's feedback payload `{ title, text?, version, route, link? }` and the app from the URL as the shared envelope. The body is strict: a `repo`
 * (or any other field) is a 400, because the app's route in the server's registry picks the repo and nothing in a payload does.
 * Free text stays as the user wrote it (the server holds it as outside data); a link loses its userinfo and fragment.
 */
export function parseFeedback(app: string, payload: unknown): FeedbackRequest {
  const body = shape(FeedbackPayload, payload)
  return {
    app,
    version: required('version', body.version, 64),
    route: required('route', body.route, 256),
    title: required('title', body.title, MAX_TITLE_CHARS),
    text: cut(cleanText(body.text ?? ''), MAX_FEEDBACK_CHARS),
    link: body.link ? cut(withoutUserinfo(cleanText(body.link)).replace(/#.*$/s, ''), MAX_LINK_CHARS) : null,
  }
}
