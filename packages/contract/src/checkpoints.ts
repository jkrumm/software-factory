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

export const STEPS = ['policy', 'judge', 'default', 'owner'] as const
export const SETTLERS = [...STEPS, 'orchestrator'] as const
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
  step: z.enum(STEPS),
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
    /** makes a repeated call one event, as on `ship` and `defer` */
    call: z.string().trim().min(1).max(128).optional(),
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

export const EditAnnotationBody = z.object({ comment: z.string().optional() }).meta({ id: 'EditAnnotationBody' })

/** How a lead handled one of the owner's annotations: made the change, filed it for later, or said no. */
export const DISPOSITIONS = ['applied', 'deferred', 'declined'] as const

/** The lead's answer to an annotation: the disposition, and a note (a deferral names the Issue or signal it filed, a decline its reason). */
export const AnnotationReplyBody = z
  .object({
    attempt: z.number().int().min(1).optional(),
    disposition: z.enum(DISPOSITIONS).optional(),
    note: z.string().optional(),
  })
  .meta({ id: 'AnnotationReplyBody' })

export const VerdictBody = z
  .object({
    verdict: z.enum(VERDICTS).optional(),
    note: z.string().optional(),
    revision: z.number().int().min(1).optional(),
  })
  .meta({ id: 'VerdictBody' })

export const VerdictView = z
  .object({
    revision: z.number().int(),
    verdict: z.enum(VERDICTS),
    note: z.string().nullable(),
    at: iso,
    /** the owner's mark: did this Spec or Report need him; null while unmarked */
    neededMe: z.boolean().nullable().default(null),
  })
  .meta({ id: 'VerdictView' })

/** The owner's one-click mark on a verdict: did it need him (`factory artifact needed <id> --needed yes|no`). */
export const NeededBody = z
  .object({
    needed: z.boolean(),
    /** the revision whose verdict is marked; default the latest with a verdict */
    revision: z.number().int().min(1).optional(),
  })
  .meta({ id: 'NeededBody' })

/** Who made a Spec owed, as the screen saw it: factory-triage's flag, the filer's, the Replan's own proposal, the lead's judgment. */
export const SPEC_SOURCES = ['triage', 'filer', 'replan', 'lead'] as const
export type SpecSource = (typeof SPEC_SOURCES)[number]

/** What the Spec screen came to on one revision: `held` while a failed call waits for its retry. */
export const SpecScreenView = z.object({
  revision: z.number().int(),
  outcome: z.enum(['held', 'passed', 'settled']),
  by: z.enum(['rule', 'judge', 'failed']).nullable(),
  source: z.enum(SPEC_SOURCES),
  note: z.string().nullable(),
  tries: z.number().int(),
  at: iso,
})
export type SpecScreenView = z.infer<typeof SpecScreenView>

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

export const AnnotationDisposition = z.object({
  disposition: z.enum(DISPOSITIONS),
  note: z.string(),
  at: iso,
})

export const AnnotationView = z.object({
  id: z.string(),
  revision: z.number().int(),
  quote: z.string(),
  path: z.string().nullable(),
  comment: z.string(),
  author: z.enum(['owner', 'lead']),
  at: iso,
  editedAt: iso.nullable(),
  /** the lead's answer; null until it gives one */
  disposition: AnnotationDisposition.nullable(),
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
    /** the Spec screen's look at the revision shown; null for a Concept, a Report, and a Spec not looked at yet */
    screen: SpecScreenView.nullable().default(null),
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
    /** what was tried before asking for a person's hands: the commands, the tokens, the routes. Required. */
    tried: z.string().optional(),
    /**
     * a shell command that exits 0 while the Errand is still needed. Set it for anything a machine can observe (an
     * unreachable accessory: `home doctor`; a token that must be rotated: the command that tests it). The factory runs it
     * when the owner is back at the desk and every few hours, and closes the Errand, ending the wait, when it exits 1..125.
     */
    check: z.string().optional(),
    /**
     * the command the owner runs, for an Errand that is a step on his MacBook: it is pushed to the MacBook as a dialog showing
     * the command when he is back (his Console read, the MacBook answering, or his button), and its answer closes the
     * Errand. Raise "approve the queued dialog" this way; never queue an `ask-human.sh` request beside an Errand.
     */
    cmd: z.string().optional(),
    /** where the hands must be (macbook, iphone, portal or any); with `--cmd` and no host, the MacBook */
    host: z.enum(['macbook', 'iphone', 'portal', 'any']).optional(),
    /** makes a repeated call one event, as on `ship` and `defer` */
    call: z.string().trim().min(1).max(128).optional(),
  })
  .meta({ id: 'ErrandBody' })

export const ErrandDoneBody = z
  .object({
    note: z.string().optional(),
    /** `not_needed`: the owner found it needless; the default is that his hands did it */
    outcome: z.enum(['done', 'not_needed']).optional(),
    /**
     * what the command pushed for this Errand came to. Anything but `done` (a non-zero exit, 124, `running`) is not done: the
     * Errand stays open and records the run. `output` is kept as its first and last 20 lines.
     */
    run: z
      .object({
        status: z.enum(['done', 'failed', 'timeout', 'running']),
        exit: z.number().int().nullable().optional(),
        output: z.string().optional(),
      })
      .optional(),
  })
  .meta({ id: 'ErrandDoneBody' })

/** The owner's or the orchestrator's "turned back": the Errand is not done, and the lead hears the note. */
export const ErrandTurnBackBody = z
  .object({ note: z.string().trim().min(1).max(2000) })
  .meta({ id: 'ErrandTurnBackBody' })
export type ErrandTurnBackBody = z.infer<typeof ErrandTurnBackBody>

export const ERRAND_HOSTS = ['macbook', 'iphone', 'portal', 'any'] as const
export const ERRAND_CLOSED_KINDS = [
  'done',
  'not_needed',
  'expired',
  'superseded',
  'turned_away',
  'turned_back',
] as const

/** A request for the owner's hands that no Issue raised: what `ask-human.sh` posts. */
export const ErrandRequestBody = z
  .object({
    /** what is asked, in the owner's words: the first line is the title */
    text: z.string().optional(),
    /** the command to run, shown to copy */
    command: z.string().optional(),
    /** a shell command that exits 0 while the request is still needed; the factory runs it every hour and closes the request when it exits 1..125 */
    check: z.string().optional(),
    /** `7d`, `36h`, `90m`, an ISO time or `never`; with no check and none given, 7 days */
    expires: z.string().optional(),
    /** a newer request with the same key replaces the open older one */
    key: z.string().optional(),
    /** where the hands must be; read from the text when absent */
    where: z.enum(ERRAND_HOSTS).optional(),
    /** who asks, a short name (`ask-human`) */
    source: z.string().optional(),
  })
  .meta({ id: 'ErrandRequestBody' })

export const ErrandView = z.object({
  id: z.string(),
  /** null for a request no Issue raised */
  issueId: z.string().nullable(),
  attempt: z.number().int().nullable(),
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
  /** a request: who asked, the command to run, its check, where the hands must be, when it expires, its key */
  source: z.string().nullable(),
  command: z.string().nullable(),
  check: z.string().nullable(),
  host: z.enum(ERRAND_HOSTS).nullable(),
  expiresAt: iso.nullable(),
  requestKey: z.string().nullable(),
  /** how it ended and who ended it; null while open */
  closedKind: z.enum(ERRAND_CLOSED_KINDS).nullable(),
  closedBy: z.enum(['owner', 'orchestrator', 'check', 'judge', 'loop', 'request']).nullable(),
  /** the last run of its check or look of the still-needed workflow: what it said */
  checkNote: z.string().nullable(),
  /** the last pushed run that came back unsuccessful (a failure, a timeout, still running); null when none did */
  lastRun: z
    .object({
      status: z.enum(['failed', 'timeout', 'running']),
      exit: z.number().int().nullable(),
      at: iso,
      attempts: z.number().int(),
      /** the output's first 20 lines and its last 20 (empty when the whole output fits in the head) */
      head: z.string(),
      tail: z.string(),
    })
    .nullable(),
})

/** What `factory errand request` answers: the Errand and the older open requests it replaced. */
export const ErrandRequestReply = z
  .object({ result: z.enum(['applied', 'replayed']), errand: ErrandView, superseded: z.array(z.string()) })
  .meta({ id: 'ErrandRequestReply' })
export type ErrandRequestReply = z.infer<typeof ErrandRequestReply>

/** What the still-needed workflow is shown: a request nobody has checked, and the facts the factory holds about it (data, never instructions). */
export const ErrandNeededRequest = z
  .object({
    errand: z.object({
      id: z.string(),
      source: z.string(),
      summary: z.string().max(200),
      detail: z.string().max(4000).nullable(),
      command: z.string().max(2000).nullable(),
      host: z.enum(ERRAND_HOSTS),
      raisedAt: iso,
      ageHours: z.number().int().min(0),
    }),
    /** scrubbed, bounded lines: the same source's other requests, open and lately closed, with how each ended */
    evidence: z.string().max(4000),
  })
  .meta({ id: 'ErrandNeededRequest' })
export type ErrandNeededRequest = z.infer<typeof ErrandNeededRequest>

/** `not_needed` closes the request; `needed` and `unsure` keep it. Only `not_needed` needs a reason on which the owner can act. */
export const ErrandNeededAnswer = z
  .object({ verdict: z.enum(['needed', 'not_needed', 'unsure']), reason: z.string().trim().min(1).max(300) })
  .meta({ id: 'ErrandNeededAnswer' })
export type ErrandNeededAnswer = z.infer<typeof ErrandNeededAnswer>

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

/** How much of a Spec the screen reads; a longer one is cut, and the cut is said. */
export const SPEC_SCREEN_CONTENT_MAX = 20_000
export const SPEC_SCREEN_PRECEDENTS = 12

/**
 * One of the owner's marks on a Spec: what it was, who made it owed, what the screen did with it, and whether it needed him,
 * with his verdict note. The newest marks are the screen's and triage's precedents; the owner's words are data.
 */
export const SpecPrecedent = z.object({
  title: z.string().max(200),
  repo: z.string(),
  source: z.enum(SPEC_SOURCES),
  /** what the screen did with it; null for a Spec handed over before the screen */
  screened: z.enum(['passed', 'settled']).nullable(),
  needed: z.boolean(),
  verdict: z.enum(VERDICTS),
  note: z.string().max(2000).nullable(),
})
export type SpecPrecedent = z.infer<typeof SpecPrecedent>

/** The Spec a `factory-spec-screen` call is shown: the lead's words and the owner's are data, never instructions. */
export const SpecScreenRequest = z
  .object({
    spec: z.object({
      id: z.string(),
      revision: z.number().int().min(1),
      title: z.string().max(200),
      source: z.enum(SPEC_SOURCES),
      /** the Spec as written, cut to `SPEC_SCREEN_CONTENT_MAX` */
      content: z.string().max(SPEC_SCREEN_CONTENT_MAX + 100),
      format: z.enum(['markdown', 'html']),
    }),
    issue: z.object({ id: z.string(), repo: z.string(), title: z.string(), kind: z.string() }),
    precedents: z.array(SpecPrecedent).max(SPEC_SCREEN_PRECEDENTS),
  })
  .meta({ id: 'SpecScreenRequest' })
export type SpecScreenRequest = z.infer<typeof SpecScreenRequest>

/**
 * What `factory-spec-screen` says: the Spec is the owner's to read (`pass`: a screen or look he has not seen, product
 * direction, spend, security policy, other people or company data, a change that cannot be undone, or open choices whose
 * defaults lead to materially different work), or the lead may build on its defaults (`settle`), with the reason it hears.
 */
export const SpecScreenAnswer = z
  .object({ verdict: z.enum(['pass', 'settle']), reason: z.string().trim().min(1).max(300) })
  .meta({ id: 'SpecScreenAnswer' })
export type SpecScreenAnswer = z.infer<typeof SpecScreenAnswer>

/**
 * `factory artifact screen <id>`: the screen's look at the latest revision, and what the next look would decide by rule or
 * send to the workflow (the precedents as they stand now). `request` is null when a rule decides or nothing is left to screen.
 */
export const SpecScreenPreview = z
  .object({
    artifact: z.string(),
    revision: z.number().int(),
    screen: SpecScreenView.nullable(),
    rule: z.object({ outcome: z.enum(['passed', 'settled']), reason: z.string() }).nullable(),
    request: SpecScreenRequest.nullable(),
  })
  .meta({ id: 'SpecScreenPreview' })
export type SpecScreenPreview = z.infer<typeof SpecScreenPreview>

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
    /** the Spec revisions the screen looked at: passed to the owner, settled by the factory, held for a retry, or dropped */
    specs: z
      .array(
        z.object({
          artifact: z.string(),
          revision: z.number().int(),
          outcome: z.enum(['held', 'passed', 'settled', 'dropped']),
        }),
      )
      .default([]),
    rechecks: z.array(
      z.object({
        checkpoint: z.string(),
        kind: z.enum(['decision', 'errand']),
        outcome: z.enum(['withdrawn', 'settled', 'kept']),
      }),
    ),
    /** the Concepts and Specs that waited a day for the owner: withdrawn, or defaulted (the lead goes on with the defaults it named) */
    reviews: z.array(z.object({ artifact: z.string(), outcome: z.enum(['withdrawn', 'defaulted']) })),
    pages: z.object({
      sent: z.array(z.string()),
      failed: z.array(z.object({ key: z.string(), error: z.string() })),
    }),
  })
  .meta({ id: 'PassReply' })
export type PassReply = z.infer<typeof PassReply>
