import * as z from 'zod'

/** The Issue as a quality verb answers: where it stands after the call. */
export const QualityIssue = z
  .object({
    id: z.string(),
    state: z.string(),
    waitReason: z.string().nullable(),
    outcome: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'QualityIssue' })
export type QualityIssue = z.infer<typeof QualityIssue>

const Range = z.object({ base: z.string(), head: z.string() })

const CommitsEvidence = z.object({
  kind: z.literal('commits'),
  commits: z.array(z.string()),
  landedAt: z.string().nullable(),
  mergedAt: z.iso.datetime({ offset: true }).nullable(),
  /** whether any path is one a deploy carries: docs, text and tests are not */
  deploys: z.boolean(),
  paths: z.array(z.string()),
})

const ReviewEvidence = z.object({
  kind: z.literal('review'),
  /** `covered` and `not_required` are a review; `uncovered` and `unknown` are its recorded absence, with the reason */
  status: z.enum(['covered', 'not_required', 'uncovered', 'unknown']),
  tier: z.string().nullable(),
  ranges: z.array(Range),
  uncovered: z.array(
    z.object({ sha: z.string(), subject: z.string(), required: z.string(), reason: z.string().optional() }),
  ),
  reason: z.string().nullable(),
})

const AcceptanceEvidence = z.object({
  kind: z.literal('acceptance'),
  /** the lead's one line per acceptance criterion; empty is the recorded absence: the ship stated nothing */
  statements: z.array(z.object({ status: z.enum(['met', 'not_met']), text: z.string() })),
})

const CiEvidence = z.object({
  kind: z.literal('ci'),
  /** the pull request's CI for the merged head; `red`, `missing` and `unknown` are recorded with the reason, never a refusal */
  status: z.enum(['green', 'red', 'running', 'missing', 'unknown']),
  pr: z.number().int().nullable(),
  headSha: z.string().nullable(),
  url: z.string().nullable(),
  reason: z.string().nullable(),
})

/** What a ship proved: its merged commits, its review or the record that there was none, what it states of the acceptance, and the CI of its pull request. */
export const QualityEvidence = z
  .discriminatedUnion('kind', [CommitsEvidence, ReviewEvidence, AcceptanceEvidence, CiEvidence])
  .meta({ id: 'QualityEvidence' })
export type QualityEvidence = z.infer<typeof QualityEvidence>

/** `ship`: the lead lands and deploys, then names the merged commits. The same `call` twice is one ship. */
export const ShipBody = z
  .object({
    attempt: z.number().int().min(1),
    call: z.string().min(1),
    /** an empty list is refused by the gate with its error named, not by the schema */
    commits: z.array(z.string().min(1)).max(50).optional(),
    /** the flag form `--commit <sha>` (repeatable), joined with `commits` */
    commit: z.array(z.string().min(1)).max(50).optional(),
    /** one line per acceptance criterion, `met: <what shows it>` or `not met: <why>`; a record, never a gate */
    acceptance: z.array(z.string().min(1).max(500)).max(20).optional(),
  })
  .meta({ id: 'ShipBody' })
export type ShipBody = z.infer<typeof ShipBody>

export const ShipAnswer = z
  .object({
    result: z.enum(['applied', 'replayed']),
    issue: QualityIssue,
    evidence: z.array(QualityEvidence),
  })
  .meta({ id: 'ShipAnswer' })
export type ShipAnswer = z.infer<typeof ShipAnswer>

/** `reopen`: the owner's verb, the only way out of `closed`, within 30 days of the close. */
export const ReopenBody = z.object({ call: z.string().min(1), reason: z.string().min(1) }).meta({ id: 'ReopenBody' })
export type ReopenBody = z.infer<typeof ReopenBody>

export const ReopenAnswer = z
  .object({ result: z.enum(['applied', 'replayed']), issue: QualityIssue })
  .meta({ id: 'ReopenAnswer' })
export type ReopenAnswer = z.infer<typeof ReopenAnswer>

/** Every ship the gate looked at for an Issue, with its evidence, and every watch with its checks. */
export const QualityView = z
  .object({
    ships: z.array(
      z.object({
        attempt: z.number().int(),
        call: z.string(),
        at: z.iso.datetime({ offset: true }),
        result: z.enum(['accepted', 'refused']),
        /** the verb's error when refused */
        detail: z.string().nullable(),
        commits: z.array(z.string()),
        evidence: z.array(QualityEvidence),
      }),
    ),
    watches: z.array(
      z.object({
        watch: z.number().int(),
        attempt: z.number().int(),
        startedAt: z.iso.datetime({ offset: true }),
        windowMs: z.number().int(),
        /** how it ended; null while it is open */
        answer: z.enum(['passed', 'regressed', 'ended']).nullable(),
        checks: z.array(
          z.object({
            n: z.number().int(),
            at: z.iso.datetime({ offset: true }),
            outcome: z.enum(['green', 'red', 'blocked']),
            checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
          }),
        ),
      }),
    ),
  })
  .meta({ id: 'QualityView' })
export type QualityView = z.infer<typeof QualityView>
