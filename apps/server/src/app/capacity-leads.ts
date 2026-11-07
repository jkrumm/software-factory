import type { Claims, Seats, Windows } from '../domains/leads/ports.ts'
import { accountOf, releaseClaim, windowOf } from './capacity-admit.ts'
import type { PlanningDeps } from './planning-deps.ts'

/**
 * Capacity's side of the leads' ports: the account an attempt was admitted on (`Seats`), the repo claim given back when
 * the attempt ends (`Claims`) and the window that can run out (`Windows`).
 *
 * An attempt that was admitted outside capacity (the scenarios record `admitted` themselves) has no account on file and
 * runs on `default`: no `CLAUDE_CONFIG_DIR`, whatever account the terminal's launcher picks. Admission by the pass always
 * stores one.
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
    },
    windows: { wall: (account) => windowOf(deps, account) },
  }
}
