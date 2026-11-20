import { LIGHT_ROLE, lightRule } from '../domains/leads/light.ts'
import type { Roles } from '../domains/leads/ports.ts'
import type { SeatTable } from '../read/seats.ts'
import type { LeadDeps } from './leads.ts'

/**
 * What the Console's seat badge reads to plan a seat before a lead starts: the role table's `lead` and `light` rows, the
 * light seat's readers (the same ones the start reads) and the same rule, so the plan is what the start would choose now.
 */
export function plannedSeatTable(input: { roles: Pick<Roles, 'role'>; light: Pick<LeadDeps, 'lightGate'> }): SeatTable {
  const row = (name: string) => async () => {
    const found = await input.roles.role(name)
    return found.ok ? found.value : null
  }
  return {
    lead: row('lead'),
    light: {
      role: LIGHT_ROLE,
      row: row(LIGHT_ROLE),
      gate: async () => (await input.light.lightGate?.()) === true,
      rule: lightRule,
    },
  }
}
