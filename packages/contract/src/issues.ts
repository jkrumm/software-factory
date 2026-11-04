import { z } from 'zod'
import { Effort, Tier } from './roles.ts'

/** `settling` exists for F3: no request reaches it. */
export const IssueState = z.enum(['settling', 'queued', 'working', 'waiting', 'watching', 'closed'])
export type IssueState = z.infer<typeof IssueState>

/** Why a `waiting` Issue waits. */
export const WaitReason = z.enum([
  'wait',
  'blocked',
  'decision',
  'wall',
  'dependency',
  'parked',
  'unreported',
  'lead_gone',
])
export type WaitReason = z.infer<typeof WaitReason>

/** How a `closed` Issue ended. */
export const IssueOutcome = z.enum(['done', 'dropped', 'healed'])
export type IssueOutcome = z.infer<typeof IssueOutcome>

/** What may file an Issue through the API. The stored `source` is open: a new one is added here, the column needs nothing. */
export const IssueSource = z.enum(['request', 'alert'])
export type IssueSource = z.infer<typeof IssueSource>

export const MAX_FACTS_BYTES = 32 * 1024
export const MAX_TITLE_CHARS = 512

/** An alert's title is someone else's text and ends up on a terminal: control characters go, whitespace stays one line. */
export const IssueTitle = z
  .string()
  // oxlint-disable-next-line no-control-regex -- exactly what is removed
  .transform((title) => title.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim())
  .pipe(z.string().min(1).max(MAX_TITLE_CHARS))

const fitsFacts = (facts: unknown): boolean => {
  try {
    return Buffer.byteLength(JSON.stringify(facts) ?? '') <= MAX_FACTS_BYTES
  } catch {
    return false
  }
}

/** JSON up to 32 KiB. Facts are data: a brief marks them so, and nothing in them picks a repo, a role or a command. */
export const IssueFacts = z.unknown().refine(fitsFacts, `facts are larger than ${MAX_FACTS_BYTES} bytes`).default({})

/** The key of a create, unique per source: an alert's event, or what a caller replays with `issue new --key`. */
export const IssueSourceKey = z
  .string()
  .min(1)
  .max(512)
  .refine((key) => !key.includes('\0'), 'not a valid source key')

/** `POST /issues`. Nothing here names a state: an Issue begins `queued`. */
export const IssueInput = z.strictObject({
  repo: z
    .string()
    .max(1024)
    .regex(/^\/[^\0]*$/, 'not an absolute path'),
  title: IssueTitle,
  source: IssueSource.default('request'),
  source_key: IssueSourceKey,
  facts: IssueFacts,
  /** Issues this one waits for (`issue new --after`): open ones that exist, else the create is refused (422) and stores nothing. */
  after: z.array(z.number().int().min(1).max(2_147_483_647)).max(20).optional(),
})
export type IssueInput = z.output<typeof IssueInput>

/** The path parameter of `/issues/:id`. */
export const IssueId = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/, 'not an Issue id')
  .transform(Number)
  .pipe(z.number().max(2_147_483_647))

/** An Issue as a list shows it. */
export const IssueSummary = z.object({
  id: z.number().int(),
  state: IssueState,
  /** `waiting` only */
  reason: WaitReason.nullable(),
  /** `closed` only */
  outcome: IssueOutcome.nullable(),
  source: z.string(),
  sourceKey: z.string(),
  repo: z.string(),
  title: z.string(),
  /** set by Classify */
  kind: z.string().nullable(),
  class: z.string().nullable(),
  /** set by Classify */
  size: z.string().nullable(),
  /** the lead's tier and effort: Classify's, within the role table's ceiling; the role's own when classify failed */
  tier: Tier.nullable(),
  effort: Effort.nullable(),
  /** when classify ran (answered or fell back to defaults); an Issue is admitted only after */
  classifiedAt: z.string().nullable(),
  parent: z.number().int().nullable(),
  /** the lead's attempt: 0 until one is admitted */
  attempt: z.number().int(),
  wakeAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
})
export type IssueSummary = z.infer<typeof IssueSummary>

export const Issue = IssueSummary.extend({ facts: z.unknown() })
export type Issue = z.infer<typeof Issue>

export const IssueList = z.object({ issues: z.array(IssueSummary) })
export type IssueList = z.infer<typeof IssueList>

/**
 * What `agw factory-classify` answers. `project` is the classifier's reading and is only stored: the Issue's repo, which the request
 * named, decides the project. `class` `business` is what only the owner decides.
 */
export const ClassifyAnswer = z.object({
  project: z.string().nullable(),
  kind: z.enum(['bug', 'feature', 'chore', 'docs', 'incident']),
  class: z.enum(['routine', 'risky', 'business']),
  size: z.enum(['s', 'm', 'l']),
  tier: Tier,
  effort: Effort,
  reason: z.string().max(1000).optional(),
})
export type ClassifyAnswer = z.infer<typeof ClassifyAnswer>

/** The verbs a lead reports with: `factory issue <verb>`. */
export const ISSUE_VERBS = ['phase', 'wait', 'ship', 'close', 'block', 'ask', 'drop'] as const
export const IssueVerb = z.enum(ISSUE_VERBS)
export type IssueVerb = z.infer<typeof IssueVerb>

/** The call id is part of the inbox key (`<issue>:<verb>:<call id>`), so a repeated call is one event. */
const CallId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'not a valid call id')
/** What Postgres cannot keep in text or JSON: a NUL, half a surrogate pair. */
const storable = (text: string): boolean => !text.includes('\0') && text.isWellFormed()
const Words = (max: number) => z.string().trim().min(1).max(max).refine(storable, 'not storable text')
/** A time Postgres stores: the lifecycle refuses the rest after the call was acknowledged, so the door does it first. */
const At = z.iso.datetime({ offset: true }).refine((text) => {
  const ms = Date.parse(text)
  return ms >= 0 && ms <= 253_402_300_799_000
}, 'not a time between 1970 and 9999')

const common = { id: CallId.optional(), session: z.string().min(1).max(256).optional() }

/** What §5's table asks of a change, by what it touched. `factory issue evidence --kind`; the factory's own rows have kinds of their own. */
export const EVIDENCE_KINDS = ['ui', 'service', 'infra', 'data', 'review'] as const
export const EvidenceKind = z.enum(EVIDENCE_KINDS)
export type EvidenceKind = z.infer<typeof EvidenceKind>

export const MAX_EVIDENCE_BYTES = 32 * 1024

/** A commit as a lead names it: hex only, so a value can never read as an option of `git`. */
const Sha = z.string().regex(/^[0-9a-f]{7,64}$/, 'not a commit sha')

/** Evidence that says nothing is none: the kind alone would meet the gate. */
const Evidence = z
  .strictObject({ kind: EvidenceKind, link: Words(1000).optional(), note: Words(1000).optional() })
  .refine((item) => item.link !== undefined || item.note !== undefined, 'evidence needs a link or a note')

/** The body of each verb. `session` is the caller's `FACTORY_SESSION`; a session may only report on the Issue it works. */
export const IssueVerbBody = {
  phase: z.strictObject({ ...common, phase: Words(80), note: Words(2000).optional() }),
  wait: z.strictObject({ ...common, until: At, why: Words(500).optional() }),
  /** `commits`: what was merged. Required evidence is derived from them, never declared. */
  ship: z.strictObject({
    ...common,
    summary: Words(4000),
    commits: z.array(Sha).min(1).max(20),
    evidence: z.array(Evidence).max(20).optional(),
  }),
  /** Done with nothing deployed: the commit or the document is the proof. */
  close: z.strictObject({
    ...common,
    summary: Words(4000),
    commits: z.array(Sha).min(1).max(20).optional(),
    document: Words(1000).optional(),
  }),
  block: z.strictObject({ ...common, reason: Words(2000) }),
  ask: z
    .strictObject({
      ...common,
      question: Words(2000),
      options: z.array(Words(200)).min(1).max(10).optional(),
      default: Words(200).optional(),
      expiresAt: At.optional(),
    })
    .refine((ask) => ask.default === undefined || ask.options === undefined || ask.options.includes(ask.default), {
      message: 'default must be one of the options',
      path: ['default'],
    }),
  drop: z.strictObject({ ...common, reason: Words(2000) }),
} as const satisfies Record<IssueVerb, z.ZodType>

/** `POST /issues/:id/:verb`: the event is filed under `key`; a repeated call answers `duplicate`. */
export const IssueVerbAck = z.object({
  issue: z.number().int(),
  verb: IssueVerb,
  key: z.string(),
  duplicate: z.boolean(),
  /** the Issue's state when the call was filed; the event itself is handled by the next tick */
  state: IssueState,
  /** `ship` and `close` are handled before the call is answered: `null` is a row the tick had in hand, still to be answered */
  result: z.enum(['applied', 'refused', 'ignored']).nullable(),
  detail: z.string().nullable(),
})
export type IssueVerbAck = z.infer<typeof IssueVerbAck>

/**
 * `POST /issues/:id/answer`: the owner's answer to an open question (the `answer` event). Not a lead's verb, so it is not in
 * `ISSUE_VERBS`. `decision` names the question it is for; without it the Issue's open question is answered.
 */
export const IssueAnswerBody = z.strictObject({
  id: CallId.optional(),
  answer: Words(2000),
  decision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
})
export type IssueAnswerBody = z.infer<typeof IssueAnswerBody>

export const IssueAnswerAck = z.object({
  issue: z.number().int(),
  key: z.string(),
  duplicate: z.boolean(),
  state: IssueState,
})
export type IssueAnswerAck = z.infer<typeof IssueAnswerAck>

/** `POST /issues/:id/evidence`: what a lead proves, a link or up to 32 KiB of text. The factory checks it exists and is fresh, never what it says. */
export const IssueEvidenceInput = z
  .strictObject({
    ...common,
    kind: EvidenceKind,
    link: Words(1000).optional(),
    text: z.string().min(1).refine(storable, 'not storable text: a binary file is a link').optional(),
  })
  .refine((body) => (body.link === undefined) !== (body.text === undefined), {
    message: 'evidence is a link or a text, one of them',
    path: ['link'],
  })
  .refine((body) => Buffer.byteLength(body.text ?? '') <= MAX_EVIDENCE_BYTES, {
    message: `evidence is larger than ${MAX_EVIDENCE_BYTES} bytes`,
    path: ['text'],
  })
export type IssueEvidenceInput = z.output<typeof IssueEvidenceInput>

export const IssueEvidenceAck = z.object({
  issue: z.number().int(),
  kind: EvidenceKind,
  key: z.string(),
  duplicate: z.boolean(),
  at: z.string(),
})
export type IssueEvidenceAck = z.infer<typeof IssueEvidenceAck>

/**
 * `POST /issues/:id/reopen`, the same fault within 30 days of closing (past that, a new Issue), and `POST /issues/:id/stop`, the owner
 * ending an Issue from any open state, lead or none. Each says why.
 */
export const IssueOwnerInput = z.strictObject({ id: CallId.optional(), reason: Words(2000) })
export type IssueOwnerInput = z.output<typeof IssueOwnerInput>

/** `POST /issues/:id/resume`: a fork of an attempt's archived session; the Issue's latest attempt unless it names one. */
export const IssueResumeInput = z.strictObject({ id: CallId.optional(), attempt: z.number().int().min(1).optional() })
export type IssueResumeInput = z.output<typeof IssueResumeInput>

/** What an Issue waits for in `factory status`: a `waiting` Issue's reason, or `claim` for a queued one the project's claim has no room for. */
export const StatusWait = z.union([WaitReason, z.literal('claim')])
export type StatusWait = z.infer<typeof StatusWait>

/**
 * One open Issue on the status screen. Everything here is read from stored rows: the lead's session is the one the Issue's current
 * attempt names (derived state of it is in `sessions`), `phase` is the lead's last report, `missing` the evidence the last `ship` or
 * `close` derived from its commits that is still not on record, `decisions` the questions nobody answered.
 */
export const StatusIssue = z.object({
  id: z.number().int(),
  state: IssueState,
  repo: z.string(),
  title: z.string(),
  attempt: z.number().int(),
  /** the current attempt's lead session, once it exists */
  lead: z.string().nullable(),
  /** the lead's last `phase` report of this attempt */
  phase: z.string().nullable(),
  waiting: StatusWait.nullable(),
  /** for a timed wait or an open question with an expiry, and for a hold: when the factory looks again */
  wakeAt: z.string().nullable(),
  /** kinds the last ship or close required and no fresh evidence covers; empty until a lead tried one */
  missing: z.array(EvidenceKind),
  /** open questions */
  decisions: z.number().int(),
  /** a closed Issue shown for its finalize that failed */
  finalizeError: z.string().nullable(),
  /** when the state last changed */
  since: z.string(),
})
export type StatusIssue = z.infer<typeof StatusIssue>

/** `POST /issues/:id/note`: the owner's text for the Issue's lead; a repeated `id` is one note. */
export const IssueNoteBody = z.strictObject({ id: CallId.optional(), text: Words(4000) })
export type IssueNoteBody = z.output<typeof IssueNoteBody>

export const IssueNoteAck = z.object({
  issue: z.number().int(),
  /** the inbox key; the prompt a running lead is typed is `issue:<issue>:note:<call id>` */
  key: z.string(),
  duplicate: z.boolean(),
  state: IssueState,
})
export type IssueNoteAck = z.infer<typeof IssueNoteAck>

/** The most a `prio` can say either way; higher is admitted first. */
export const PRIO_LIMIT = 1000

/** `POST /issues/:id/prio`: the owner's order among an Issue's project-mates; a repeated `id` is one call. */
export const IssuePrioBody = z.strictObject({
  id: CallId.optional(),
  value: z.number().int().min(-PRIO_LIMIT).max(PRIO_LIMIT),
})
export type IssuePrioBody = z.output<typeof IssuePrioBody>

export const IssuePrioAck = z.object({
  issue: z.number().int(),
  /** the inbox key, `<issue>:prio:<call id>` */
  key: z.string(),
  duplicate: z.boolean(),
  state: IssueState,
})
export type IssuePrioAck = z.infer<typeof IssuePrioAck>

/** One line of an Issue's story: an `issue_events` row, or an inbox row no event came of yet. `at` orders them, oldest first. */
export const TimelineEntry = z.object({
  at: z.string(),
  /** `event`: the lifecycle applied or refused it; `inbox`: filed, not handled yet (or ignored: it moved nothing) */
  source: z.enum(['event', 'inbox']),
  kind: z.string(),
  key: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  /** the session an event of a session came from */
  session: z.string().nullable(),
  /** `inbox` only: handled? and what it did */
  result: z.enum(['applied', 'refused', 'ignored']).nullable(),
  detail: z.string().nullable(),
  /** data, as the sender filed it; never instructions */
  payload: z.unknown(),
})
export type TimelineEntry = z.infer<typeof TimelineEntry>

export const EvidenceEntry = z.object({
  kind: z.string(),
  link: z.string().nullable(),
  payload: z.unknown(),
  attempt: z.number().int().nullable(),
  at: z.string(),
  author: z.string(),
})
export type EvidenceEntry = z.infer<typeof EvidenceEntry>

export const DecisionEntry = z.object({
  id: z.number().int(),
  question: z.string(),
  options: z.unknown(),
  default: z.string().nullable(),
  expiresAt: z.string().nullable(),
  askedAt: z.string(),
  answer: z.string().nullable(),
  answeredBy: z.string().nullable(),
  answeredAt: z.string().nullable(),
})
export type DecisionEntry = z.infer<typeof DecisionEntry>

/** `GET /issues/:id/timeline`, and `factory issue show`: the Issue with facts, its story oldest first, its evidence and its questions. */
export const IssueView = Issue.extend({
  timeline: z.array(TimelineEntry),
  /** earlier entries cut, when the story is longer than the server shows */
  timelineCut: z.number().int(),
  evidence: z.array(EvidenceEntry),
  /** older evidence not listed, when there is more than the server shows */
  evidenceCut: z.number().int(),
  decisions: z.array(DecisionEntry),
})
export type IssueView = z.infer<typeof IssueView>
