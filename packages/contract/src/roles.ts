import * as z from 'zod'

/** Tier names, never model ids: the ids live in agw's and dotfiles' route tables, the launcher maps a tier to one. */
export const TIERS = ['haiku', 'sonnet', 'opus'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const Tier = z.enum(TIERS)
export type Tier = z.infer<typeof Tier>
export const Effort = z.enum(EFFORTS)
export type Effort = z.infer<typeof Effort>

/** A role is a word: it ends up in a file name, a CLI argument and a column. */
export const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
export const RoleName = z.string().regex(ROLE_NAME, 'not a valid role name')

/** What `factory role get <role> --format json` prints; `rd --role` reads exactly this. */
export const RoleEntry = z.object({ role: RoleName, tier: Tier, effort: Effort }).meta({ id: 'RoleEntry' })
export type RoleEntry = z.infer<typeof RoleEntry>

export const RoleList = z.object({ roles: z.array(RoleEntry) }).meta({ id: 'RoleList' })
export type RoleList = z.infer<typeof RoleList>

/** `config/roles.json`: role name to tier and effort. */
const RoleFile = z.object({ roles: z.record(RoleName, z.object({ tier: Tier, effort: Effort })) })

export type RoleTable = ReadonlyMap<string, RoleEntry>

/**
 * The seat an Issue's lead runs on, for the badge beside the Issue's number: the tier and effort the current attempt
 * started on, or (`planned`) the ones it will start on (its filed seat, else the `lead` row). `role` is the table row it
 * came from (`lead`, `light`, the filed seat's role), null when unknown. Never a model id.
 */
export const LeadSeat = z
  .strictObject({ tier: Tier, effort: Effort, role: z.string().nullable(), planned: z.boolean() })
  .meta({ id: 'LeadSeat' })
export type LeadSeat = z.infer<typeof LeadSeat>

/**
 * The tripwire for triage's `small` on the light seat (`apps/server/src/domains/leads/light.ts`). The light seat starts
 * with the rule classes; triage's `small` with no design choice joins them unless the light seat is shown worse (NL45): the
 * first verification pass rate of the attempts that finished on it is not shown more than `TRIPWIRE_POINTS` under lead's
 * (the lower bound of the gap at `TRIPWIRE_Z`), and its move-up share is under the bound the cost of a move-up sets
 * (`judgeLightGate`). The window is the last `TRIPWIRE_DAYS` days, reaching back up to `TRIPWIRE_MAX_DAYS` until light has
 * `TRIPWIRE_TARGET_WATCHES` finished first watches. It is read, not switched: a window that breaks either closes it again.
 * Fewer than `TRIPWIRE_MIN_WATCHES` finished first watches on light is no reading, and a closed gate.
 */
export const TRIPWIRE_POINTS = 3
export const TRIPWIRE_DAYS = 3
export const TRIPWIRE_MIN_WATCHES = 10
/** The window reaches back until light has this many finished first watches (a Wilson half-width of about 4 points), at most `TRIPWIRE_MAX_DAYS`. */
export const TRIPWIRE_TARGET_WATCHES = 100
export const TRIPWIRE_MAX_DAYS = 14
/** One-sided 95 %: the z of the interval a gap must clear to be shown. `TRIPWIRE_Z` is its normal quantile: change both together. */
export const TRIPWIRE_CONFIDENCE = 0.95
export const TRIPWIRE_Z = 1.6449

/** Parses the role table's text; throws with zod's message when it is not one. */
export function parseRoleTable(text: string): RoleTable {
  const file = RoleFile.parse(JSON.parse(text))
  return new Map(Object.entries(file.roles).map(([role, entry]) => [role, { role, ...entry }]))
}

/**
 * The reviewer seats (Issue 2027). `reviewer` is the current seat, `reviewer-cheap` the cheap tier at high effort. A
 * review of a light-seat Issue and of half of the others (by Issue number parity) runs on the cheap row; a deep review
 * (the ones that fan out to verifier agents) stays on `reviewer` until the cheap row has the evidence below.
 */
export const REVIEWER_ROLE = 'reviewer'
export const REVIEWER_CHEAP_ROLE = 'reviewer-cheap'
/** The share of the Issues that are not light that start on the cheap row: the even Issue numbers. */
export const REVIEWER_START_SHARE = 0.5
/** The cheap row takes every non-deep review when each seat has this many reviews and the tests below hold. */
export const REVIEWER_TRIPWIRE_REVIEWS = 100
/** The cheap row's first verification pass rate may be this many points under the other seat's, and no more. */
export const REVIEWER_TRIPWIRE_POINTS = 2
/** The window that sends the cheap row back to its starting share, and the fewest Issues with a first watch it must hold to judge. */
export const REVIEWER_TRIPWIRE_DAYS = 3
export const REVIEWER_WINDOW_MIN_ISSUES = 10
