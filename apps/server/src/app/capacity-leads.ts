import type { Claims, Seats, Windows } from '../domains/leads/ports.ts'
import { accountOf, releaseClaim, resumeClaim, windowOf } from './capacity-admit.ts'
import type { PlanningDeps } from './planning-deps.ts'

/**
 * Capacity's side of the leads' ports: the account an attempt was admitted on (`Seats`), the repo claim taken back when
 * a wait ends and given back when the attempt ends (`Claims`) and the window that can run out (`Windows`).
 *
 * An attempt with no account on file (one imported as already working) runs on `default`: no `CLAUDE_CONFIG_DIR`, whatever account the
 * terminal's launcher picks. Admission by the pass always stores one.
 */
export function capacityForLeads(deps: PlanningDeps): { seats: Seats; claims: Claims; windows: Windows } {
  return {
    seats: {
      seat: async ({ issue, attempt }) => {
        const account = await accountOf(deps, issue, attempt)
        return account.ok ? { ok: true, value: { account: account.value ?? 'default' } } : account
      },
    },
    claims: {
      release: async ({ issue }) => {
        const released = await releaseClaim(deps, issue)
        return released.ok ? { ok: true, value: undefined } : released
      },
      resume: async ({ issue }) => {
        const resumed = await resumeClaim(deps, issue)
        return resumed.ok ? { ok: true, value: undefined } : resumed
      },
    },
    windows: { wall: (account) => windowOf(deps, account) },
  }
}
