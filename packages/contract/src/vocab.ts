/**
 * The Issue's closed vocabularies, each written once (`docs/language.md`). Every other list of these words derives from a
 * tuple here: a zod enum, a SQL list built from it, a `Record` keyed by it so a missing key fails tsc. No imports, so the
 * plan subpath and the hook can load it. A database CHECK in `apps/server/migrations/` repeats a list by necessity; the
 * schema test pins it to these.
 */

/** The states of an open Issue (`docs/architecture.md` §The Issue state machine): all of them but `closed`. */
export const OPEN_ISSUE_STATES = ['settling', 'queued', 'working', 'waiting', 'watching'] as const
export type OpenIssueState = (typeof OPEN_ISSUE_STATES)[number]

/** The Issue's states, and no others. */
export const ISSUE_STATES = [...OPEN_ISSUE_STATES, 'closed'] as const
export type IssueState = (typeof ISSUE_STATES)[number]

/** Before a lead has it: triage or the queue still holds the Issue back (`WORK_GROUPS.notStarted` counts these as words). */
export const UNSTARTED_ISSUE_STATES = ['settling', 'queued'] as const satisfies readonly OpenIssueState[]

/** A lead is running it, or the watch after the ship is on. */
export const LEAD_ACTIVE_ISSUE_STATES = ['working', 'watching'] as const satisfies readonly OpenIssueState[]

/** What an Issue is (`docs/language.md`, Kind). */
export const ISSUE_KINDS = ['feature', 'bug', 'chore', 'docs', 'incident'] as const
export type IssueKind = (typeof ISSUE_KINDS)[number]

/** The kinds a triage or a person may refine an Issue to: `incident` is the factory's own judgment, never refined to. */
export const REFINED_KINDS = ['feature', 'bug', 'chore', 'docs'] as const satisfies readonly IssueKind[]
export type RefinedKind = (typeof REFINED_KINDS)[number]

/** Triage's judgment of how much work an Issue is (`docs/language.md`, Size). */
export const ISSUE_SIZES = ['small', 'medium', 'large'] as const
export type IssueSize = (typeof ISSUE_SIZES)[number]

/**
 * How a closed Issue ended: `done` (shipped and verified, or closed by its lead with the work done), `dropped` (its lead
 * gave it up with a reason), `healed` (an incident that went away before a lead started), `cancelled` (the owner's stop).
 */
export const ISSUE_OUTCOMES = ['done', 'dropped', 'healed', 'cancelled'] as const
export type IssueOutcome = (typeof ISSUE_OUTCOMES)[number]

/** Where an Issue or a signal came from, in the words a person uses (`docs/language.md`, Origin). */
export const ISSUE_ORIGINS = ['you', 'application', 'infrastructure', 'github', 'feedback', 'factory'] as const
export type IssueOrigin = (typeof ISSUE_ORIGINS)[number]
