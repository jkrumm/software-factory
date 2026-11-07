import * as z from 'zod'

/** A NUL, or half of a surrogate pair: what Postgres cannot store in text or JSON. */
// oxlint-disable-next-line no-control-regex -- the NUL is exactly what is removed
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/**
 * Text from someone else (an alert, a GitHub issue, a payload) as the factory keeps it: what Postgres cannot store becomes
 * U+FFFD, other control characters a space, and the ends are trimmed.
 */
export const cleanText = (text: string): string =>
  text
    .replace(UNSTORABLE, '�')
    // oxlint-disable-next-line no-control-regex -- exactly what is removed
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim()

const MAX_FACTS_DEPTH = 32

/** Facts as Postgres can store them: the characters it refuses become U+FFFD, and nesting past a few levels is cut. */
export function storable(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.replace(UNSTORABLE, '�')
  if (typeof value !== 'object' || value === null) return value
  if (depth >= MAX_FACTS_DEPTH) return '[too deep]'
  if (Array.isArray(value)) return value.map((item) => storable(item, depth + 1))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key.replace(UNSTORABLE, '�'), storable(item, depth + 1)]),
  )
}

export const MAX_TITLE_CHARS = 512
export const MAX_TEXT_CHARS = 20_000
export const MAX_FACTS_BYTES = 24 * 1024

const fitsFacts = (facts: unknown): boolean => {
  try {
    return Buffer.byteLength(JSON.stringify(facts) ?? '') <= MAX_FACTS_BYTES
  } catch {
    return false
  }
}

const Title = z.string().transform(cleanText).pipe(z.string().min(1).max(MAX_TITLE_CHARS))
const Facts = z
  .unknown()
  .default({})
  .transform((facts) => storable(facts))
  .refine(fitsFacts, `facts are larger than ${MAX_FACTS_BYTES} bytes`)

/** The name of an automatic source: the path segment of the door's token and the key of its routes. */
export const DoorSource = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'not a source name')
export type DoorSource = z.infer<typeof DoorSource>

export const SIGNAL_KINDS = ['alert', 'request', 'feedback', 'remark'] as const
export const SIGNAL_ORIGINS = ['you', 'application', 'infrastructure', 'github', 'feedback', 'factory'] as const
export const SIGNAL_TRUSTS = ['owner', 'machine', 'agent', 'outside'] as const

/**
 * The envelope every input becomes (`docs/architecture.md` §Signals and triage). `source`, `kind`, `origin`, `trust` and
 * `repo` are set by the receiving side: the route, the poller or the caller, never by an outside payload.
 */
export const Signal = z
  .object({
    /** kuma, hyperdx, beszel, github, checks, launchd, feedback:<app>, owner:hermes, agent:<repo> */
    source: z.string(),
    kind: z.enum(SIGNAL_KINDS),
    origin: z.enum(SIGNAL_ORIGINS),
    trust: z.enum(SIGNAL_TRUSTS),
    /** from the route or the caller, never from an outside payload */
    repo: z.string().nullable(),
    fingerprint: z.string(),
    title: z.string(),
    text: z.string(),
    link: z.string().nullable(),
    /** the loop whose change this signal reports, if a loop made it: receive refuses it for an automatic sender (the loop guard) */
    madeBy: z.string().nullable(),
  })
  .meta({ id: 'Signal' })
export type Signal = z.infer<typeof Signal>

/** What receive answers (`docs/language.md`, Triage). */
export const TRIAGE_OUTCOMES = ['filed', 'amended', 'incident', 'held', 'dropped'] as const
export const TriageOutcome = z.enum(TRIAGE_OUTCOMES)
export type TriageOutcome = z.infer<typeof TriageOutcome>

/** Why it went that way, for the sender and the log. */
export const TRIAGE_DETAILS = [
  'new',
  'matched',
  'replayed',
  'repeat',
  'joined',
  'regression',
  'settling',
  'healed',
  'quiet',
  'unrouted',
  'quarantined',
  'promoted',
  'work_repo',
  'no_project',
  'not_listened',
  'loop_guard',
  'no_repo',
] as const

export const SignalAck = z
  .object({
    outcome: TriageOutcome,
    detail: z.enum(TRIAGE_DETAILS),
    /** the Issue it filed, joined or amended */
    issue: z.string().nullable(),
    /** the stored signal, when it was stored */
    signal: z.string().nullable(),
    /** a sentence for the sender when it was dropped */
    reason: z.string().nullable(),
  })
  .meta({ id: 'SignalAck' })
export type SignalAck = z.infer<typeof SignalAck>

/**
 * `POST /signals`: the owner, Hermes, an agent or an app puts work in. Who is calling picks the trust (`owner*` the
 * owner, `agent:<repo>` an agent in that repo, `feedback:<app>` an outsider); nothing else in the body does.
 */
export const SignalRequest = z
  .strictObject({
    from: z.string().regex(/^(owner|agent|feedback)(:[A-Za-z0-9._-]{1,64})?$/, 'owner[:who], agent:<repo> or feedback:<app>'),
    kind: z.enum(['request', 'feedback', 'remark']).default('request'),
    title: Title,
    text: z
      .string()
      .transform(cleanText)
      .pipe(z.string().max(MAX_TEXT_CHARS))
      .default(''),
    repo: z.string().min(1).max(256).nullish(),
    link: z.string().max(1024).nullish(),
  })
  .refine((body) => !body.from.startsWith('agent') || /^agent:/.test(body.from), {
    message: 'an agent names its repo: agent:<repo>',
    path: ['from'],
  })
  .refine((body) => !body.from.startsWith('feedback') || /^feedback:/.test(body.from), {
    message: 'feedback names its app: feedback:<app>',
    path: ['from'],
  })
  .refine((body) => !body.from.startsWith('owner') || Boolean(body.repo), {
    message: 'the owner names the repo',
    path: ['repo'],
  })
  .meta({ id: 'SignalRequest' })
export type SignalRequest = z.infer<typeof SignalRequest>

/**
 * `POST /signals/alerts`: what the door files for one alert. The payload is data: nothing in it picks a repo, a role, a
 * path or a command, so there is no such field here (the body is strict); the repo comes from the door's routes.
 */
export const AlertRequest = z
  .strictObject({
    source: DoorSource,
    monitor: z.string().transform(cleanText).pipe(z.string().min(1).max(256)),
    event: z.string().transform(cleanText).pipe(z.string().min(1).max(256)),
    status: z.enum(['down', 'up']),
    title: Title,
    facts: Facts,
  })
  .meta({ id: 'AlertRequest' })
export type AlertRequest = z.output<typeof AlertRequest>

/** One stored signal as the owner reads it, held ones first. */
export const StoredSignal = z
  .object({
    id: z.string(),
    source: z.string(),
    kind: z.enum(SIGNAL_KINDS),
    origin: z.enum(SIGNAL_ORIGINS),
    trust: z.enum(SIGNAL_TRUSTS),
    repo: z.string().nullable(),
    title: z.string(),
    text: z.string(),
    link: z.string().nullable(),
    receivedAt: z.string(),
    /** held until promoted, or what it became */
    state: z.enum(['held', 'filed', 'amended', 'incident', 'promoted']),
    issue: z.string().nullable(),
  })
  .meta({ id: 'StoredSignal' })
export type StoredSignal = z.infer<typeof StoredSignal>

export const SignalList = z.object({ signals: z.array(StoredSignal) }).meta({ id: 'SignalList' })
export type SignalList = z.infer<typeof SignalList>

/** `POST /signals/{id}/promote`: the owner (or the Judge) lets a held signal become work. */
export const PromoteRequest = z
  .strictObject({
    /** a held signal may have no repo (app feedback): the promoter names it */
    repo: z.string().min(1).max(256).nullish(),
  })
  .meta({ id: 'PromoteRequest' })
export type PromoteRequest = z.infer<typeof PromoteRequest>

/** A door route: the registry that says which repo a monitor's alerts file in. The owner's estate, not git's. */
export const DoorRoute = z
  .object({
    source: DoorSource,
    monitor: z.string(),
    repo: z.string(),
    quiet: z.number().int(),
    lastQuietAt: z.string().nullable(),
  })
  .meta({ id: 'DoorRoute' })
export type DoorRoute = z.infer<typeof DoorRoute>

export const DoorRouteInput = z
  .strictObject({
    source: DoorSource,
    monitor: z.string().transform(cleanText).pipe(z.string().min(1).max(256)),
    repo: z.string().min(1).max(256),
  })
  .meta({ id: 'DoorRouteInput' })
export type DoorRouteInput = z.output<typeof DoorRouteInput>

export const DoorRouteList = z
  .object({
    routes: z.array(DoorRoute),
    unrouted: z.array(
      z.object({
        source: z.string(),
        monitor: z.string(),
        count: z.number().int(),
        lastSeen: z.string(),
        lastTitle: z.string(),
        status: z.enum(['down', 'up']).nullable(),
        downSince: z.string().nullable(),
        group: z.boolean(),
        issue: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'DoorRouteList' })
export type DoorRouteList = z.infer<typeof DoorRouteList>

/** `POST /signals/door-reports`: what the door says about its sources, best effort. */
export const DoorReport = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('start'), sources: z.array(DoorSource).max(16) }),
    z.strictObject({ kind: z.literal('refused'), source: DoorSource }),
    z.strictObject({ kind: z.literal('accepted'), source: DoorSource }),
  ])
  .meta({ id: 'DoorReport' })
export type DoorReport = z.infer<typeof DoorReport>

export const DoorReportAck = z.object({ ok: z.literal(true) }).meta({ id: 'DoorReportAck' })
