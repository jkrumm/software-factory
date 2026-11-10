import * as z from 'zod'
import { EFFORTS, type Effort, RoleName, TIERS, type Tier } from './roles.ts'

/** What an Issue or a plan row asks for: the lead's tier and effort, or a role of the table that names both. */
export type Seat = { tier: Tier; effort: Effort } | { role: string }

/** The seat as it is stored and read: tier and effort always, the role it was resolved from when it named one. */
export const ResolvedSeat = z
  .object({ tier: z.enum(TIERS), effort: z.enum(EFFORTS), role: z.string().optional() })
  .meta({ id: 'ResolvedSeat' })
export type ResolvedSeat = z.infer<typeof ResolvedSeat>

/** The wire shape of a seat: any object, so a bad one is the server's 422 naming the field, not a bare 400. */
export const SeatInput = z.record(z.string(), z.unknown())

export type SeatParse = { ok: true; seat: Seat } | { ok: false; field: string; detail: string }

const KEYS = ['tier', 'effort', 'role']
const words = (values: readonly string[]) => values.join(', ')

/**
 * Checks the shape of a seat: exactly `{ tier, effort }` or `{ role }`, tiers and efforts from the lists (never model
 * ids). Whether a role exists is the role table's to say, at filing. A refusal names the field (`seat.tier`).
 */
export function parseSeat(raw: unknown): SeatParse {
  const refuse = (field: string, detail: string): SeatParse => ({ ok: false, field, detail })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return refuse('seat', 'must be an object')
  const given = raw as Record<string, unknown>
  const unknown = Object.keys(given).find((name) => !KEYS.includes(name))
  if (unknown !== undefined) return refuse(`seat.${unknown}`, `unknown key; a seat has role, or tier and effort`)
  const { tier, effort, role } = given
  if (role !== undefined) {
    if (tier !== undefined || effort !== undefined)
      return refuse('seat', 'give either role, or tier and effort, not both')
    const named = RoleName.safeParse(role)
    return named.success ? { ok: true, seat: { role: named.data } } : refuse('seat.role', 'not a valid role name')
  }
  if (tier === undefined && effort === undefined) return refuse('seat', 'give a role, or tier and effort')
  if (tier === undefined) return refuse('seat.tier', 'required with effort')
  if (!TIERS.includes(tier as Tier)) return refuse('seat.tier', `must be one of ${words(TIERS)}`)
  if (effort === undefined) return refuse('seat.effort', 'required with tier')
  if (!EFFORTS.includes(effort as Effort)) return refuse('seat.effort', `must be one of ${words(EFFORTS)}`)
  return { ok: true, seat: { tier: tier as Tier, effort: effort as Effort } }
}

/** A plan row's seat: parsed at the plan's parse, so a bad one keeps the last valid plan. */
export const PlanSeat = SeatInput.transform((raw, ctx): Seat => {
  const parsed = parseSeat(raw)
  if (parsed.ok) return parsed.seat
  ctx.addIssue({ code: 'custom', message: `${parsed.field}: ${parsed.detail}` })
  return z.NEVER
})
