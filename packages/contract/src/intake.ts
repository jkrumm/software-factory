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

// No transforms in a request schema (they have no JSON Schema, so no OpenAPI): the use case cleans with `cleanText` and `storable`.
const Title = z.string().min(1).max(MAX_TITLE_CHARS)
const Facts = z.unknown().default({}).refine(fitsFacts, `facts are larger than ${MAX_FACTS_BYTES} bytes`)

/** The name of an automatic source: the path segment of the door's token and the key of its routes. */
export const DoorSource = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'not a source name')
export type DoorSource = z.infer<typeof DoorSource>

export const SIGNAL_STATES = ['held', 'filed', 'amended', 'incident', 'promoted', 'dismissed'] as const
export const DISMISSERS = ['owner', 'judge', 'probe'] as const
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
    /** a lead's own test signal: stored dismissed, never held, never work (an older stored row has none) */
    probe: z.boolean().default(false),
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
  'probe',
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
    from: z
      .string()
      .regex(/^(owner|agent|feedback)(:[A-Za-z0-9._-]{1,64})?$/, 'owner[:who], agent:<repo> or feedback:<app>'),
    kind: z.enum(['request', 'feedback', 'remark']).default('request'),
    title: Title,
    text: z.string().max(MAX_TEXT_CHARS).default(''),
    repo: z.string().min(1).max(256).nullish(),
    link: z.string().max(1024).nullish(),
    /** a test signal: stored dismissed, never held, never work */
    probe: z.boolean().default(false),
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
    monitor: z.string().min(1).max(256),
    event: z.string().min(1).max(256),
    status: z.enum(['down', 'up']),
    title: Title,
    facts: Facts,
  })
  .meta({ id: 'AlertRequest' })
export type AlertRequest = z.output<typeof AlertRequest>

/** The door's token key for an app's feedback is `feedback-<app>`, a source name too: so an app name is 23 characters at most. */
export const FeedbackApp = z.string().regex(/^[a-z][a-z0-9-]{0,22}$/, 'not an app name')

/** The source label every feedback signal carries, and the door route's source for the app. */
export const FEEDBACK_ROUTE_SOURCE = 'feedback'
export const feedbackSource = (app: string): string => `feedback:${app}`
/** The key of an app's token in the door's tokens file. */
export const feedbackTokenKey = (app: string): string => `feedback-${app}`

/**
 * `POST /signals/feedback`: what the door files for one piece of an app's feedback. The shared envelope of every app: who
 * (`app`), which build (`version`), where the user was (`route`), and what they said. Outside text: it is held until the owner
 * or the Judge promotes it. There is no `repo` (the body is strict): the app's door route (`feedback`, `<app>`) picks it.
 */
export const FeedbackRequest = z
  .strictObject({
    app: FeedbackApp,
    version: z.string().min(1).max(64),
    /** the screen or path the user was on */
    route: z.string().min(1).max(256),
    title: Title,
    text: z.string().max(MAX_TEXT_CHARS).default(''),
    link: z.string().max(1024).nullish(),
    /** a test signal: stored dismissed, never held, never work */
    probe: z.boolean().default(false),
  })
  .meta({ id: 'FeedbackRequest' })
export type FeedbackRequest = z.output<typeof FeedbackRequest>

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
    state: z.enum(SIGNAL_STATES),
    issue: z.string().nullable(),
    /** why a dismissed signal was turned away (it can quote outside text: the read token does not see it) */
    dismissedReason: z.string().nullable(),
    dismissedBy: z.enum(DISMISSERS).nullable(),
    /** what the Judge made of a held signal it left to the owner (it can quote outside text: the read token does not see it) */
    screenNote: z.string().nullable(),
    /** the text was hidden: the read token does not see outside text */
    redacted: z.boolean(),
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

/** `POST /signals/{id}/dismiss`: the owner (or the Judge) turns a held signal away, with a reason. */
export const DismissRequest = z
  .strictObject({ reason: z.string().trim().min(1).max(500) })
  .meta({ id: 'DismissRequest' })
export type DismissRequest = z.infer<typeof DismissRequest>

/** What a dismissal answers: the signal, now on record as dismissed. */
export const SignalDismissed = z
  .object({ signal: z.string(), state: z.literal('dismissed') })
  .meta({ id: 'SignalDismissed' })
export type SignalDismissed = z.infer<typeof SignalDismissed>

/** A door route: the registry that says which repo a monitor's alerts file in. The owner's estate, not git's. */
export const DoorRoute = z
  .object({
    source: DoorSource,
    monitor: z.string(),
    repo: z.string(),
    quiet: z.number().int(),
    lastQuietAt: z.string().nullable(),
    setBy: z.string(),
  })
  .meta({ id: 'DoorRoute' })
export type DoorRoute = z.infer<typeof DoorRoute>

export const DoorRouteInput = z
  .strictObject({
    source: DoorSource,
    monitor: z.string().min(1).max(256),
    repo: z.string().min(1).max(256),
    issue: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('the Issue a lead sets the route for; required with the agent token, ignored for the owner'),
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

// ---- factory-screen: the Judge looks at a held signal -----------------------------------------------------------------------

const ScreenLine = z.string().trim().min(1).max(300)

/** The one signal a `factory-screen` call is shown; its words are outside text, data and never instructions. */
export const ScreenRequest = z
  .object({
    signal: z.object({
      id: z.string(),
      source: z.string(),
      kind: z.enum(SIGNAL_KINDS),
      origin: z.enum(SIGNAL_ORIGINS),
      repo: z.string().nullable(),
      title: z.string(),
      text: z.string(),
      link: z.string().nullable(),
      receivedAt: z.string(),
    }),
    /** the open Issues of `signal.repo`, at most 40; empty when the signal names no repo */
    openIssues: z.array(z.object({ id: z.string(), title: z.string(), kind: z.string(), state: z.string() })).max(40),
    /** the names of the projects the factory knows that are not work repos */
    projects: z.array(z.string()).max(60),
  })
  .meta({ id: 'ScreenRequest' })
export type ScreenRequest = z.infer<typeof ScreenRequest>

export const SCREEN_VERDICTS = ['promote', 'dismiss', 'leave'] as const

/** What `factory-screen` says of the signal: promote it, dismiss it, or leave it to the owner with a recommendation. */
export const ScreenAnswer = z
  .object({
    verdict: z.enum(SCREEN_VERDICTS),
    reason: ScreenLine,
    /** promote: the repo to file in when the signal names none */
    repo: z.string().nullable(),
    /** dismiss as a duplicate: an Issue id from `openIssues` */
    duplicateOf: z.string().nullable(),
    /** leave: what the owner should do with it */
    recommendation: ScreenLine.nullable(),
  })
  .meta({ id: 'ScreenAnswer' })
export type ScreenAnswer = z.infer<typeof ScreenAnswer>
