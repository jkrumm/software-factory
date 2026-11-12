import * as z from 'zod'

/**
 * The shapes the factory sends the agw workflows and parses back, and the routes that show the loops. The workflow
 * side (`agent-workflows`, `packages/capabilities`) holds its own schemas of the same shapes; `fixtures/loops.json` is the
 * one set of examples both repos parse (`apps/server/test/loops/wire.test.ts` here, the host tests there).
 */

const IssueId = z.string().regex(/^issue_[1-9][0-9]*$/, 'an Issue id is issue_<n>')
const Line = z.string().regex(/^[^\r\n\u2028\u2029]{1,240}$/, 'one line, at most 240 characters')
const Text = z.string().trim().min(1).max(4_000)

// ---- factory-ask: the Judge (today's ask is the running factory's; this is the new core's Decision) ----------------------

export const JudgeInputWire = z.object({
  decision: z.string().min(1),
  repo: z.string().min(1),
  issue: z.string(),
  question: z.string().min(1),
  recommendation: z.string().min(1),
  checked: z.string().min(1),
  options: z.array(z.object({ label: z.string().min(1), reversible: z.boolean(), cost: z.string().min(1) })).min(1),
  noAnswer: z.object({
    consequence: z.string().min(1),
    default: z.string().min(1).nullable(),
    waitMinutes: z.number().int().min(1).nullable(),
  }),
  precedents: z.array(
    z.object({
      question: z.string(),
      answer: z.string(),
      settledBy: z.string(),
      worthAsking: z.boolean().nullable(),
      repo: z.string(),
    }),
  ),
})
export type JudgeInputWire = z.infer<typeof JudgeInputWire>

export const JudgeVerdictWire = z.object({
  verdict: z.enum(['answer', 'owner']),
  answer: z.string(),
  reason: z.string(),
  source: z.string(),
})
export type JudgeVerdictWire = z.infer<typeof JudgeVerdictWire>

// ---- factory-steward -----------------------------------------------------------------------------------------------------

export const STALL_CAUSES = ['wall', 'unreported', 'blocked', 'lead_gone', 'regressed'] as const

export const STEWARD_ACTIONS = ['wake', 'requeue', 'raise_decision', 'none'] as const

export const StewardStall = z.object({
  issue: IssueId,
  repo: z.string().min(1),
  title: z.string().min(1).max(500),
  kind: z.enum(['feature', 'bug', 'chore', 'docs', 'incident']),
  cause: z.enum(STALL_CAUSES),
  detail: z.string().max(4_000),
  stalledMinutes: z.number().int().min(0),
  attempt: z.number().int().min(0),
  restarts: z.number().int().min(0),
  regressions: z.number().int().min(0),
  stewardWakes: z.number().int().min(0),
  notes: z.array(z.string().max(500)).max(20),
  history: z.array(z.string().max(500)).max(40),
})
export type StewardStall = z.infer<typeof StewardStall>

/** The Decision form as the steward writes it: the fields of a lead's `factory issue ask`, checked again by the factory. */
export const StewardDecision = z.object({
  question: Text,
  recommendation: Text,
  checked: Text,
  options: z
    .array(z.object({ label: Text, reversible: z.boolean(), cost: Text }))
    .min(2)
    .max(10),
  noAnswer: z.object({
    consequence: Text,
    default: Text.nullable(),
    waitMinutes: z.number().int().min(1).max(10_080).nullable(),
  }),
})
export type StewardDecision = z.infer<typeof StewardDecision>

export const StewardAnswer = z.object({
  action: z.enum(STEWARD_ACTIONS),
  note: z.string().max(4_000),
  reason: Line,
  decision: StewardDecision.nullable(),
})
export type StewardAnswer = z.infer<typeof StewardAnswer>

// ---- factory-triage ------------------------------------------------------------------------------------------------------

const Candidate = z.object({
  id: IssueId,
  title: z.string().min(1).max(500),
  kind: z.string().min(1).max(40),
  state: z.string().min(1).max(40),
})
export type TriageCandidate = z.infer<typeof Candidate>

/** An Issue of the repo closed in the last day, shown so a restated ask can be answered "already settled". */
const SettledCandidate = z.object({
  id: IssueId,
  title: z.string().min(1).max(500),
  outcome: z.string().min(1).max(40),
  reason: z.string().max(300).nullable(),
})
export type TriageSettled = z.infer<typeof SettledCandidate>

export const TriageRequest = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('amend'),
    repo: z.string().min(1),
    candidates: z.array(Candidate).max(40),
    settled: z.array(SettledCandidate).max(20).default([]),
    signal: z.object({
      title: z.string().min(1).max(500),
      text: z.string().max(8_000),
      source: z.string().min(1).max(100),
      kind: z.enum(['alert', 'request', 'feedback', 'remark']),
      origin: z.string().min(1).max(40),
    }),
  }),
  z.object({
    mode: z.literal('settle'),
    repo: z.string().min(1),
    candidates: z.array(Candidate).max(40),
    issue: z.object({
      id: IssueId,
      title: z.string().min(1).max(500),
      text: z.string().max(8_000),
      kind: z.enum(['feature', 'bug', 'chore', 'docs', 'incident']),
      origin: z.string().min(1).max(40),
    }),
  }),
])
export type TriageRequest = z.infer<typeof TriageRequest>

export const TriageAnswer = z.object({
  amend: IssueId.nullable(),
  settled: IssueId.nullable().optional(),
  after: z.array(IssueId).max(10),
  kind: z.enum(['feature', 'bug', 'chore', 'docs', 'incident']).nullable(),
  size: z.enum(['small', 'medium', 'large']).nullable(),
  /** settle mode: `spec` when the change is a new public surface, a data model, a dependency of weight or an unseen screen */
  checkpoint: z.literal('spec').nullable().optional(),
  reason: Line,
})
export type TriageAnswer = z.infer<typeof TriageAnswer>

// ---- factory-queue -------------------------------------------------------------------------------------------------------

/** An id as the workflow's schema takes it; the factory supplies `issue_<n>`, the answer is checked against what was shown. */
const WireId = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, dot, underscore, hyphen')
  .min(1)
  .max(64)

export const QueueIssue = z.object({
  id: IssueId,
  title: z.string().min(1).max(500),
  kind: z.string().min(1).max(40),
  /** `queued` is to be ordered; any other state is chain context */
  state: z.string().min(1).max(40),
  prio: z.number().int().min(-1000).max(1000),
  ageMinutes: z.number().int().min(0),
  size: z.enum(['small', 'medium', 'large']).nullable(),
  summary: z.string().max(600),
  /** the Issue's open blockers; may name an Issue that is not shown */
  after: z.array(IssueId).max(20),
})
export type QueueIssue = z.infer<typeof QueueIssue>

export const QueueRequest = z.object({
  repo: z
    .string()
    .regex(/^[A-Za-z0-9._/-]+$/)
    .min(1)
    .max(200),
  issues: z.array(QueueIssue).min(1).max(40),
})
export type QueueRequest = z.infer<typeof QueueRequest>

export const QueueAnswer = z.object({
  edges: z.array(z.object({ issue: WireId, after: WireId, reason: Line })).max(10),
  /** every queued Issue once, the one to start first at the front; empty when the factory order stands */
  order: z.array(WireId).max(40),
  reason: Line,
})
export type QueueAnswer = z.infer<typeof QueueAnswer>

// ---- factory-hygiene -----------------------------------------------------------------------------------------------------

export const HYGIENE_KINDS = ['stale', 'slop'] as const

/** A tracked file the factory's own scan picked for a read, with the reason it was picked. */
export const HygieneCandidate = z.object({
  /** relative to the checkout root */
  path: z.string().min(1).max(300),
  why: Line,
})
export type HygieneCandidate = z.infer<typeof HygieneCandidate>

/**
 * `cwd` is a read-only checkout of `ref`; the workflow reads the candidates and the code they describe there. `stale` are
 * documents whose code moved on since they were last edited, `slop` are documents edited lately, read for filler.
 */
export const HygieneRequest = z.object({
  repo: z
    .string()
    .regex(/^[A-Za-z0-9._/-]+$/)
    .min(1)
    .max(200),
  cwd: z.string().min(1).max(1_000),
  ref: z.string().min(7).max(64),
  stale: z.array(HygieneCandidate).max(20),
  slop: z.array(HygieneCandidate).max(20),
  /** the most findings the factory will file; the workflow returns its best, no more */
  max: z.number().int().min(1).max(10),
})
export type HygieneRequest = z.infer<typeof HygieneRequest>

export const HygieneFinding = z.object({
  kind: z.enum(HYGIENE_KINDS),
  /** one of the candidates' paths; the factory drops a finding about any other file */
  path: z.string().min(1).max(300),
  title: Line,
  /** what was read: the quoted line or claim, and the code that contradicts it, with line numbers */
  evidence: Text,
  /** what to change */
  fix: Text,
})
export type HygieneFinding = z.infer<typeof HygieneFinding>

export const HygieneAnswer = z.object({
  findings: z.array(HygieneFinding).max(10),
  /** how many candidates were read */
  read: z.number().int().min(0).max(40),
  reason: Line,
})
export type HygieneAnswer = z.infer<typeof HygieneAnswer>

// ---- factory-fix-classes -------------------------------------------------------------------------------------------------

/** The classes a fix commit is sorted into (`docs/product.md` "Fix classes"); the workflow answers with one of the keys. */
export const FIX_CLASSES = [
  { key: 'tests', meaning: 'the fix is in tests, scenarios or e2e only' },
  { key: 'docs', meaning: 'the fix is in documentation only' },
  { key: 'tooling', meaning: 'CI, dependencies, build, lint or scripts' },
  { key: 'review', meaning: 'a follow-up to a finding of a review' },
  { key: 'logic', meaning: "wrong behaviour in the code's own logic" },
  {
    key: 'contract',
    meaning: 'a mismatch across a boundary: an API, a schema, types, a migration or the shape of a config',
  },
  { key: 'concurrency', meaning: 'races, locks, ordering, timers, replay or idempotence' },
  { key: 'environment', meaning: 'deploy, host, process, paths, runtime or secrets' },
  { key: 'other', meaning: 'none of the above' },
] as const
export type FixClassKey = (typeof FIX_CLASSES)[number]['key']
export const FIX_CLASS_KEYS: readonly FixClassKey[] = FIX_CLASSES.map((c) => c.key)

const Sha = z.string().regex(/^[0-9a-f]{7,64}$/, 'a commit sha in lowercase hex')

export const FixClassesRequest = z.object({
  repo: z
    .string()
    .regex(/^[A-Za-z0-9._/-]+$/)
    .min(1)
    .max(200),
  classes: z.array(z.object({ key: z.string().min(1).max(40), meaning: z.string().min(1).max(300) })).min(1),
  commits: z
    .array(
      z.object({
        sha: Sha,
        subject: z.string().min(1).max(500),
        scope: z.string().min(1).max(100).nullable(),
        body: z.string().max(800),
        files: z.array(z.string().min(1).max(300)).max(20),
      }),
    )
    .min(1)
    .max(40),
})
export type FixClassesRequest = z.infer<typeof FixClassesRequest>

export const FixClassesAnswer = z.object({
  answers: z.array(z.object({ sha: Sha, class: z.string().min(1).max(40), reason: Line })).max(40),
})
export type FixClassesAnswer = z.infer<typeof FixClassesAnswer>

// ---- the loops, as the routes show them ----------------------------------------------------------------------------------

export const LOOP_NAMES = [
  'leads',
  'planning',
  'watch',
  'settle',
  'send',
  'steward',
  'triage',
  'queue',
  'friction',
  'hygiene',
  'screen',
  'fix-classes',
  'selfwatch',
  'host',
  'reaper',
  'digest',
] as const
export type LoopName = (typeof LOOP_NAMES)[number]

export const LoopView = z
  .object({
    name: z.enum(LOOP_NAMES),
    /** the interval in ms; 0 is off (the loop runs only when asked) */
    intervalMs: z.number().int().min(0),
    /** an event kicks it, besides the clock */
    onChange: z.boolean(),
    running: z.boolean(),
    runs: z.number().int().min(0),
    /** kicks that started a pass or marked one to run again, and kicks dropped by the loop guard */
    kicks: z.number().int().min(0),
    droppedKicks: z.number().int().min(0),
    lastStartedAt: z.iso.datetime({ offset: true }).nullable(),
    /** when the newest pass ended, ok or failed; kept across restarts, the loop is scheduled from it */
    lastPassAt: z.iso.datetime({ offset: true }).nullable(),
    lastOkAt: z.iso.datetime({ offset: true }).nullable(),
    /** why the last pass failed, while the newest pass is a failure */
    lastError: z.string().nullable(),
    /** what the last pass did, in a line */
    lastSummary: z.string().nullable(),
  })
  .meta({ id: 'LoopView' })
export type LoopView = z.infer<typeof LoopView>

export const LoopList = z.object({ loops: z.array(LoopView) }).meta({ id: 'LoopList' })
export type LoopList = z.infer<typeof LoopList>

export const LoopRunReply = z
  .object({
    loop: LoopView,
    /** false when the loop is in a pass already (single-flight): the pass in flight is not started again */
    started: z.boolean(),
    summary: z.string().nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'LoopRunReply' })
export type LoopRunReply = z.infer<typeof LoopRunReply>

// ---- factory digest ------------------------------------------------------------------------------------------------------

const DigestId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'an identifier')
const DigestInstant = z.string().regex(/^[0-9TZ:.+-]{1,40}$/, 'an ISO-8601 instant')
const DigestTitle = z.string().min(1).max(500)

/** What `agw factory digest` is sent for one project: its Issues of the last 7 days, the stdin of the call. */
export const DigestRequest = z.object({
  project: z.string().min(1).max(200),
  window: z.object({ from: DigestInstant, to: DigestInstant }),
  done: z
    .array(
      z.object({
        id: DigestId,
        title: DigestTitle,
        kind: z.string().min(1).max(40),
        closedAt: DigestInstant,
        outcome: z.string().min(1).max(40),
      }),
    )
    .max(100),
  working: z
    .array(
      z.object({ id: DigestId, title: DigestTitle, kind: z.string().min(1).max(40), since: DigestInstant.optional() }),
    )
    .max(60),
  queued: z.array(z.object({ id: DigestId, title: DigestTitle, after: z.array(DigestId).max(10).optional() })).max(60),
  waiting: z.array(z.object({ id: DigestId, title: DigestTitle, reason: z.string().min(1).max(300) })).max(60),
  previous: z.object({ headline: z.string().max(500), at: DigestInstant }).optional(),
})
export type DigestRequest = z.infer<typeof DigestRequest>

/** A digest line and the Issues it is about. */
export const DigestBullet = z.strictObject({ text: Line, ids: z.array(IssueId).min(1).max(20) })
export type DigestBullet = z.infer<typeof DigestBullet>

/** The digest `agw factory digest` answers (its own schema is strict too; the factory checks the ids against what it sent). */
export const DigestAnswer = z.strictObject({
  headline: z.string().min(1).max(140),
  shipped: z.array(DigestBullet).max(5),
  next: z.array(DigestBullet).max(4),
  risks: z.array(DigestBullet).max(3),
  themes: z.array(z.string().min(1).max(30)).max(5),
})
export type DigestAnswer = z.infer<typeof DigestAnswer>
