import * as z from 'zod'

/**
 * Where the factory stops for a person: Decisions, artifacts, Errands and the owner's line (`docs/language.md`, "Where
 * the owner comes in"). Request bodies are deliberately loose: the server names each missing field itself (422
 * `missing_field`), which a schema failure would not.
 */

const iso = z.iso.datetime({ offset: true })

export const Option = z.object({ label: z.string(), reversible: z.boolean(), cost: z.string() })
export const NoAnswer = z.object({
  consequence: z.string(),
  default: z.string().nullable(),
  waitMinutes: z.number().int().nullable(),
})

/** The option and no-answer forms of a request: every property optional, so a missing one is named by the use case. */
const OptionInput = z.object({
  label: z.string().optional(),
  reversible: z.boolean().optional(),
  cost: z.string().optional(),
})
const NoAnswerInput = z.object({
  consequence: z.string().optional(),
  default: z.string().nullable().optional(),
  waitMinutes: z.number().int().nullable().optional(),
})

export const SETTLERS = ['policy', 'judge', 'default', 'owner'] as const
export const ARTIFACT_KINDS = ['concept', 'spec', 'decision', 'report'] as const
export const VERDICTS = ['looks_good', 'with_notes', 'changes', 'no_longer_applies'] as const

/** Where the Issue stands after the write, and the effects it planned (a `note_lead` among them). */
export const IssueMove = z.object({
  state: z.string(),
  waitReason: z.string().nullable(),
  version: z.number().int(),
  effects: z.array(z.object({ kind: z.string(), key: z.string() })),
})

export const Step = z.object({
  step: z.enum(SETTLERS),
  outcome: z.enum(['answered', 'passed', 'rejected', 'failed', 'open']).nullable(),
  at: iso.nullable(),
  detail: z.string().nullable(),
})

export const DecisionView = z
  .object({
    id: z.string(),
    issueId: z.string(),
    repo: z.string(),
    attempt: z.number().int(),
    question: z.string(),
    recommendation: z.string(),
    checked: z.string(),
    options: z.array(Option),
    noAnswer: NoAnswer,
    askedAt: iso,
    /** the time the default is taken; null when the Decision has none */
    defaultAt: iso.nullable(),
    status: z.enum(['open', 'answered', 'withdrawn']),
    answer: z.string().nullable(),
    settledBy: z.enum(SETTLERS).nullable(),
    source: z.string().nullable(),
    answeredAt: iso.nullable(),
    withdrawnReason: z.string().nullable(),
    worthAsking: z.boolean().nullable(),
    /** the path to the answer: every step tried, in order */
    path: z.array(Step),
    /** the Judge's step (its outcome and reason); null while it has none */
    judge: z.object({ outcome: Step.shape.outcome, detail: z.string().nullable(), at: iso.nullable() }).nullable(),
  })
  .meta({ id: 'DecisionView' })
export type DecisionView = z.infer<typeof DecisionView>

// -- Decisions --------------------------------------------------------------------------------------------------------

export const AskBody = z
  .object({
    attempt: z.number().int().min(1),
    question: z.string().optional(),
    recommendation: z.string().optional(),
    checked: z.string().optional(),
    /** a JSON array of `{label, reversible, cost}` */
    options: z.array(OptionInput).optional(),
    /** a JSON object `{consequence, default, waitMinutes}` */
    noAnswer: NoAnswerInput.optional(),
  })
  .meta({ id: 'AskBody' })
export type AskBody = z.infer<typeof AskBody>

export const AskReply = z
  .object({ result: z.enum(['applied', 'replayed', 'amended']), decision: DecisionView, issue: IssueMove })
  .meta({ id: 'AskReply' })
export type AskReply = z.infer<typeof AskReply>

export const AnswerBody = z.object({ answer: z.string().optional() }).meta({ id: 'AnswerBody' })

/** `issue` is null when the Decision was withdrawn: the Issue no longer waited for it. */
export const DecisionReply = z
  .object({ decision: DecisionView, issue: IssueMove.nullable() })
  .meta({ id: 'DecisionReply' })
export type DecisionReply = z.infer<typeof DecisionReply>

export const WorthBody = z.object({ worth: z.boolean() }).meta({ id: 'WorthBody' })

export const DecisionList = z.object({ decisions: z.array(DecisionView) }).meta({ id: 'DecisionList' })
export type DecisionList = z.infer<typeof DecisionList>

// -- Artifacts --------------------------------------------------------------------------------------------------------

export const RevisionView = z.object({
  n: z.number().int(),
  sha256: z.string(),
  bytes: z.number().int(),
  note: z.string().nullable(),
  createdAt: iso,
})

export const ArtifactSummary = z.object({
  id: z.string(),
  issueId: z.string(),
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string(),
  format: z.enum(['markdown', 'html']),
  author: z.enum(['lead', 'factory']),
  createdAt: iso,
  revisions: z.array(RevisionView),
})

export const SubmitBody = z
  .object({
    attempt: z.number().int().min(1),
    kind: z.enum(ARTIFACT_KINDS).optional(),
    title: z.string().optional(),
    /** `markdown` (the default) or `html`; not `format`, which is the CLI's own flag */
    contentFormat: z.enum(['markdown', 'html']).optional(),
    content: z.string().optional(),
  })
  .meta({ id: 'SubmitBody' })

export const ReviseBody = z
  .object({
    attempt: z.number().int().min(1).optional(),
    content: z.string().optional(),
    note: z.string().optional(),
  })
  .meta({ id: 'ReviseBody' })

export const AnnotateBody = z
  .object({
    revision: z.number().int().min(1).optional(),
    author: z.enum(['owner', 'lead']).default('owner'),
    quote: z.string().optional(),
    path: z.string().optional(),
    comment: z.string().optional(),
  })
  .meta({ id: 'AnnotateBody' })

export const VerdictBody = z
  .object({
    verdict: z.enum(VERDICTS).optional(),
    note: z.string().optional(),
    revision: z.number().int().min(1).optional(),
  })
  .meta({ id: 'VerdictBody' })

export const VerdictView = z.object({
  revision: z.number().int(),
  verdict: z.enum(VERDICTS),
  note: z.string().nullable(),
  at: iso,
})

/** A write on an artifact; `issue` is null when no event touched the Issue (a Report, an annotation). */
export const ArtifactReply = z
  .object({
    result: z.enum(['applied', 'replayed']),
    artifact: ArtifactSummary,
    verdict: VerdictView.nullable(),
    issue: IssueMove.nullable(),
  })
  .meta({ id: 'ArtifactReply' })
export type ArtifactReply = z.infer<typeof ArtifactReply>

export const AnnotationView = z.object({
  id: z.string(),
  revision: z.number().int(),
  quote: z.string(),
  path: z.string().nullable(),
  comment: z.string(),
  author: z.enum(['owner', 'lead']),
  at: iso,
})

export const ArtifactDetail = z
  .object({
    artifact: ArtifactSummary,
    /** the revision shown, and its content */
    revision: z.number().int(),
    content: z.string(),
    /** annotations whose quote is still in the revision shown */
    annotations: z.array(AnnotationView),
    /** annotations whose quote is gone from it: the "Unanchored" group */
    unanchored: z.array(AnnotationView),
    verdicts: z.array(VerdictView),
  })
  .meta({ id: 'ArtifactDetail' })
export type ArtifactDetail = z.infer<typeof ArtifactDetail>

export const ArtifactList = z.object({ artifacts: z.array(ArtifactSummary) }).meta({ id: 'ArtifactList' })
export type ArtifactList = z.infer<typeof ArtifactList>

// -- Errands ----------------------------------------------------------------------------------------------------------

export const ErrandBody = z
  .object({
    attempt: z.number().int().min(1),
    summary: z.string().optional(),
    detail: z.string().optional(),
  })
  .meta({ id: 'ErrandBody' })

export const ErrandDoneBody = z.object({ note: z.string().optional() }).meta({ id: 'ErrandDoneBody' })

export const ErrandView = z.object({
  id: z.string(),
  issueId: z.string(),
  attempt: z.number().int(),
  summary: z.string(),
  detail: z.string().nullable(),
  raisedAt: iso,
  doneAt: iso.nullable(),
  doneNote: z.string().nullable(),
  /** false while the screen still holds it, or after it turned it away */
  reachedOwner: z.boolean(),
  turnedAway: z.boolean(),
  /** the screen's reason: why it passed the Errand, or why it turned it away */
  screenNote: z.string().nullable(),
})

/** The Errand a `factory-errand` call is shown: the lead's own words, so data and never instructions. */
export const ErrandScreenRequest = z
  .object({
    errand: z.object({ id: z.string(), summary: z.string().max(200), detail: z.string().max(4000).nullable() }),
    issue: z.object({ id: z.string(), repo: z.string(), title: z.string(), kind: z.string() }),
  })
  .meta({ id: 'ErrandScreenRequest' })
export type ErrandScreenRequest = z.infer<typeof ErrandScreenRequest>

/** What `factory-errand` says: it needs a person's hands (`pass`), or a token or CLI could do it (`turn_away`). */
export const ErrandScreenAnswer = z
  .object({ verdict: z.enum(['pass', 'turn_away']), reason: z.string().trim().min(1).max(300) })
  .meta({ id: 'ErrandScreenAnswer' })
export type ErrandScreenAnswer = z.infer<typeof ErrandScreenAnswer>

export const ErrandReply = z
  .object({ result: z.enum(['applied', 'replayed']), errand: ErrandView, issue: IssueMove.nullable() })
  .meta({ id: 'ErrandReply' })
export type ErrandReply = z.infer<typeof ErrandReply>

export const ErrandList = z.object({ errands: z.array(ErrandView) }).meta({ id: 'ErrandList' })
export type ErrandList = z.infer<typeof ErrandList>

// -- The owner's line -------------------------------------------------------------------------------------------------

export const PageView = z.object({
  key: z.string(),
  kind: z.enum(['decision', 'review', 'errand']),
  checkpoint: z.string(),
  issueId: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string(),
  plannedAt: iso,
  attempts: z.number().int(),
  sentAt: iso.nullable(),
  error: z.string().nullable(),
  status: z.enum(['pending', 'sent', 'failing', 'cancelled']),
})

export const PageList = z.object({ pages: z.array(PageView) }).meta({ id: 'PageList' })
export type PageList = z.infer<typeof PageList>

/** One settle-and-page pass: what it looked at and what it sent. */
export const PassReply = z
  .object({
    decisions: z.array(
      z.object({
        decision: z.string(),
        status: z.enum(['open', 'answered', 'withdrawn']),
        settledBy: z.enum(SETTLERS).nullable(),
      }),
    ),
    errands: z.array(
      z.object({ errand: z.string(), outcome: z.enum(['held', 'reached_owner', 'turned_away', 'dropped']) }),
    ),
    pages: z.object({
      sent: z.array(z.string()),
      failed: z.array(z.object({ key: z.string(), error: z.string() })),
    }),
  })
  .meta({ id: 'PassReply' })
export type PassReply = z.infer<typeof PassReply>
