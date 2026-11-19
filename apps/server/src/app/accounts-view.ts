import type { AccountMode, AccountModeBody, AccountsView } from '@software-factory/contract'
import { isFresh } from '../domains/capacity/accounts.ts'
import { ok, type PortError, type Result } from '../kernel/result.ts'
import { type CapacityDeps, refreshAccounts } from './capacity-admit.ts'

/**
 * `GET /v1/accounts`: the package's status of every account, plus the factory's own: the seats each carries, how many are
 * taken and free, the Issues whose leads run there, and the card fields as the newest poll stored them. The account set and
 * every verdict (state, lane, closure, forecast) are the package's; the factory adds only what it alone knows.
 */
export async function accountsView(deps: CapacityDeps): Promise<Result<AccountsView, PortError>> {
  const now = deps.clock.now()
  const status = deps.desk.status(now)
  if (!status.ok) return status
  const seen = await deps.uow.run(async ({ capacity }) =>
    ok({ readings: await capacity.latestReadings(), claims: await capacity.claims() }),
  )
  if (!seen.ok) return seen
  const accounts = status.value.accounts.map((row) => {
    const reading = seen.value.readings.find((r) => r.account === row.id)
    const claims = seen.value.claims.filter((claim) => claim.account === row.id)
    const cap = deps.limits.accountLeads?.get(row.id) ?? deps.limits.leadsPerAccount
    const fresh = reading ? isFresh(reading, now) : false
    const iso = (at: Date | null | undefined) => at?.toISOString() ?? null
    return {
      ...row,
      seats: { cap, taken: claims.length, free: Math.max(0, cap - claims.length) },
      leads: claims.map((claim) => claim.issue),
      account: row.id,
      fiveHourUsed: reading?.fiveHourUsed ?? null,
      weeklyUsed: reading?.weeklyUsed ?? null,
      fiveHourResetsAt: iso(reading?.fiveHourResetsAt),
      weeklyResetsAt: iso(reading?.weeklyResetsAt),
      exhaustedUntil: iso(reading?.exhaustedUntil),
      fresh,
      rank: fresh && reading?.open ? reading.position : null,
      rankReason: fresh && reading?.open ? reading.reason : null,
    }
  })
  return ok({ ...status.value, accounts })
}

/**
 * Sets the mode override of one account through the package, so `claude-account` sees it; the answer is the mode now in force.
 * The poll runs again at once, so the stored verdict admission reads follows the override and a claim in the next minute
 * cannot start a lead on an account just paused.
 */
export async function setAccountMode(
  deps: CapacityDeps,
  account: string,
  body: AccountModeBody,
): Promise<Result<AccountMode, PortError>> {
  const set = deps.desk.setMode(account, body, deps.clock.now())
  if (set.ok) await refreshAccounts(deps)
  return set
}

/** Clears the override of one account; the registry's mode applies again, and the poll runs again at once. */
export async function clearAccountMode(deps: CapacityDeps, account: string): Promise<Result<AccountMode, PortError>> {
  const cleared = deps.desk.clearMode(account, deps.clock.now())
  if (cleared.ok) await refreshAccounts(deps)
  return cleared
}
