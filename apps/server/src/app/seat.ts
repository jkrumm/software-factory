import { type ResolvedSeat, type Seat, TIERS } from '@software-factory/contract'
import { LEAD_ROLE } from '../domains/leads/light.ts'
import type { Roles } from '../domains/leads/ports.ts'
import { err, ok, type PortError, type Result } from '../kernel/result.ts'

/** The role table as filing reads it. */
export type SeatRoles = Pick<Roles, 'role'>

/** A seat the request or the plan row names wrongly: `field` is the name to show (`seat.role`). */
export interface SeatRefused {
  kind: 'seat_refused'
  field: string
  detail: string
}

/** The alternative a refusal names: the lead row, moved up when its lead struggles. */
const MOVE_UP_SEAT = '{"role":"lead","moveUp":true}'

/** Whether a tier is above the lead row's: the seats whose filing says why. */
const aboveLead = (tier: ResolvedSeat['tier'], lead: ResolvedSeat['tier']): boolean =>
  TIERS.indexOf(tier) > TIERS.indexOf(lead)

/**
 * A seat as it is stored: tier and effort given are kept, a role is looked up in the table now and kept beside what it
 * said, so the Issue starts on what was asked for even if the table changes later. A seat that asked to move up and is the
 * lead row's tier and effort is stored as the lead row (`role: lead`): that is the seat whose move-up goes to the stronger row.
 * `requireWhy`: the hand verbs (`issue new`, `issue seat`) refuse a tier above the lead row's without `why`; a plan row
 * files without it (`factory plan check` warns), because a refused row would hold its whole plan at the last valid version.
 */
export async function resolveSeat(
  roles: SeatRoles,
  seat: Seat,
  options: { requireWhy: boolean } = { requireWhy: false },
): Promise<Result<ResolvedSeat, SeatRefused | PortError>> {
  const keep = {
    ...(seat.moveUp ? { moveUp: true as const } : {}),
    ...(seat.why ? { why: seat.why } : {}),
  }
  let resolved: ResolvedSeat
  if ('role' in seat) {
    const found = await roles.role(seat.role)
    if (!found.ok) {
      return err(
        found.error.kind === 'refused'
          ? { kind: 'seat_refused', field: 'seat.role', detail: found.error.detail }
          : found.error,
      )
    }
    resolved = { ...found.value, role: seat.role, ...keep }
  } else {
    resolved = { tier: seat.tier, effort: seat.effort, ...keep }
  }
  // The lead row is read only when the seat needs it: a seat above it, or one that asks to move up.
  if (!options.requireWhy && !seat.moveUp) return ok(resolved)
  const lead = await roles.role(LEAD_ROLE)
  if (!lead.ok) return lead.error.kind === 'refused' ? ok(resolved) : err(lead.error)
  if (aboveLead(resolved.tier, lead.value.tier)) {
    if (seat.moveUp) {
      return err({
        kind: 'seat_refused',
        field: 'seat.moveUp',
        detail: `a seat above the lead row has no row to move up to; file ${MOVE_UP_SEAT} to start on the lead row and move up`,
      })
    }
    if (options.requireWhy && !resolved.why) {
      return err({
        kind: 'seat_refused',
        field: 'seat.why',
        detail: `a seat above the lead row says why: one sentence, at most 300 characters, on what the work needs that the lead row cannot do. Unsure? File ${MOVE_UP_SEAT}: it starts on the lead row and moves up if its lead struggles`,
      })
    }
  }
  const asLead =
    seat.moveUp && !resolved.role && resolved.tier === lead.value.tier && resolved.effort === lead.value.effort
  return ok(asLead ? { ...resolved, role: LEAD_ROLE } : resolved)
}
