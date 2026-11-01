import { z } from 'zod'

/** `settling` exists for F3: no request reaches it. */
export const IssueState = z.enum(['settling', 'queued', 'working', 'waiting', 'watching', 'closed'])
export type IssueState = z.infer<typeof IssueState>

/** Why a `waiting` Issue waits. */
export const WaitReason = z.enum(['wait', 'blocked', 'decision', 'wall', 'dependency', 'parked'])
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
