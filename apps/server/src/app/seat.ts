import type { ResolvedSeat, Seat } from '@software-factory/contract'
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

/**
 * A seat as it is stored: tier and effort given are kept, a role is looked up in the table now and kept beside what it
 * said, so the Issue starts on what was asked for even if the table changes later.
 */
export async function resolveSeat(
  roles: SeatRoles,
  seat: Seat,
): Promise<Result<ResolvedSeat, SeatRefused | PortError>> {
  if (!('role' in seat)) return ok({ tier: seat.tier, effort: seat.effort })
  const found = await roles.role(seat.role)
  if (found.ok) return ok({ ...found.value, role: seat.role })
  return err(
    found.error.kind === 'refused'
      ? { kind: 'seat_refused', field: 'seat.role', detail: found.error.detail }
      : found.error,
  )
}
