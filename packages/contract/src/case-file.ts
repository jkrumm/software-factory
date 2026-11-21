import * as z from 'zod'

const IssueId = z.string().regex(/^issue_[1-9][0-9]*$/, 'an Issue id is issue_<n>')

// The case file: what the factory holds about a judgment beyond the request. agw's twin is
// `packages/capabilities/src/capabilities/factory-case.ts` in agent-workflows.

/** What became of an earlier answer of the same judge; `unknown` until the judge ledger reads it from what followed. */
export const CASE_OUTCOMES = ['stood', 'overruled', 'raised_again', 'unknown'] as const

/** The most characters of text a case the factory sends carries; agw accepts more, and refuses a longer one, never cuts it. */
export const CASE_MAX_CHARS = 60_000

const CaseText = z.string().max(CASE_MAX_CHARS)

const textsOf = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(textsOf)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(textsOf)
  return []
}

/** The characters a case carries: the sum of its texts, as agw counts them. */
export const caseChars = (value: unknown): number => textsOf(value).reduce((sum, text) => sum + text.length, 0)

/**
 * The case file every factory judge takes as `case` (the Judge, the steward, triage, the queue, the screen and both Errand
 * screens): the Issue as filed, the owner's notes on it, the repo's brief, its open Issues with their summaries and edges,
 * the plan rows around the Issue, and this judge's earlier answers in the repo. Every part is optional and every text is
 * untrusted data, scrubbed by the factory; `pane` (the lead's last words) is the steward's only.
 */
export const JudgeCase = z
  .object({
    issue: z.object({ text: CaseText, facts: CaseText }).optional(),
    ownerNotes: z
      .array(z.object({ at: z.string().max(40), text: CaseText }))
      .max(200)
      .optional(),
    repo: z.object({ project: CaseText, agents: CaseText }).optional(),
    open: z
      .array(
        z.object({
          id: IssueId,
          title: z.string().max(2_000),
          summary: CaseText,
          state: z.string().max(40),
          after: z.array(IssueId).max(200),
          before: z.array(IssueId).max(200),
        }),
      )
      .max(200)
      .optional(),
    plan: CaseText.optional(),
    precedents: z
      .array(z.object({ at: z.string().max(40), subject: CaseText, answer: CaseText, outcome: z.enum(CASE_OUTCOMES) }))
      .max(200)
      .optional(),
    pane: CaseText.optional(),
  })
  .refine((value) => caseChars(value) <= CASE_MAX_CHARS, `a case carries at most ${CASE_MAX_CHARS} characters`)
export type JudgeCase = z.infer<typeof JudgeCase>
