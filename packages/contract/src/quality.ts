import * as z from 'zod'
import { EFFORTS, TIERS } from './roles.ts'

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
  /** the commit CI is read for (the one that merged the change); absent on evidence recorded before it existed */
  mergedSha: z.string().nullable().optional(),
  mergedAt: z.iso.datetime({ offset: true }).nullable(),
  /** whether any path is one a deploy carries: docs, text and tests are not */
  deploys: z.boolean(),
  paths: z.array(z.string()),
})

/**
 * One review of a range, a thread of agw's ledger from its first round to the one that covered the commits: what it
 * found, what the lead did with it, and the seat it ran on. `seat` is the seat the factory assigned (the brief told the
 * lead to run the reviewer agent on it; a deep review stays on `reviewer`), `routed` what agw's own route table named.
 */
const ReviewThread = z.object({
  thread: z.string(),
  key: z.string(),
  /** the round that covered the commits */
  job: z.string(),
  tier: z.string(),
  rounds: z.number().int(),
  outcome: z.string().nullable(),
  seat: z.object({ role: z.string(), tier: z.enum(TIERS), effort: z.enum(EFFORTS) }),
  routed: z.object({ model: z.string(), effort: z.string() }).nullable(),
  /** the covering round's creation to its submit; null when agw did not say */
  wallMs: z.number().nullable(),
  findings: z.object({
    total: z.number().int(),
    important: z.number().int(),
    /** disposed `fixed` */
    applied: z.number().int(),
    /** disposed `wrong`, `intentional` or `irrelevant` */
    declined: z.number().int(),
    /** still open at the ship */
    open: z.number().int(),
  }),
})
export type ReviewThread = z.infer<typeof ReviewThread>

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
  /** the reviewer row the factory assigned the Issue's lead at its start (`reviewer` or `reviewer-cheap`); absent before Issue 2027 */
  reviewer: z.string().optional(),
  /** each covering review with its seat; absent on a ship recorded before Issue 2027, empty when agw could not say */
  threads: z.array(ReviewThread).optional(),
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

/** `ship`: the lead lands and deploys, then ships; the server finds the merged commits unless the lead names them. The same `call` twice is one ship. */
export const ShipBody = z
  .object({
    attempt: z.number().int().min(1),
    call: z.string().min(1),
    /** omitted or empty: the commits of the Issue's branches that are on the default branch, as git finds them */
    commits: z.array(z.string().min(1)).max(50).optional(),
    /** the flag form `--commit <sha>` (repeatable), joined with `commits` */
    commit: z.array(z.string().min(1)).max(50).optional(),
    /** one line per acceptance criterion, `met: <what shows it>` or `not met: <why>`; a record, never a gate. A line over 500 characters is cut when recorded, not refused. */
    acceptance: z.array(z.string().min(1).max(4000)).max(20).optional(),
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
            checks: z.array(
              z.object({ name: z.string(), ok: z.boolean(), detail: z.string(), inherited: z.boolean().optional() }),
            ),
          }),
        ),
      }),
    ),
  })
  .meta({ id: 'QualityView' })
export type QualityView = z.infer<typeof QualityView>
