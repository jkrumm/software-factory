import type { Effort, Tier } from '@software-factory/contract'
import type { NamedQuota } from '../../src/capacity.ts'
import type { QuotaSource } from '../../src/quota.ts'
import type { QuotaInput } from '../../src/schemas.ts'

/** A reading of one account: both windows reset at `resetsAt`, a fresh sample, enabled, auth fine, unless `extra` says so. */
export const usage = (
  weeklyUsed: number | null,
  fiveHourUsed: number | null,
  resetsAt: Date,
  extra: Partial<QuotaInput> = {},
): QuotaInput => ({
  enabled: true,
  authOk: true,
  fiveHourUsed,
  weeklyUsed,
  fiveHourResetsAt: resetsAt,
  weeklyResetsAt: resetsAt,
  exhaustedUntil: null,
  ageS: 0,
  ...extra,
})

/** What a spawn looks like once the role table has been looked up. */
export const WORKER: { role: string; tier: Tier; effort: Effort } = { role: 'worker', tier: 'sonnet', effort: 'high' }

/** A quota source the test drives: it returns what `readings` holds, or fails with `failure`. */
export class FakeQuotaSource implements QuotaSource {
  readings: NamedQuota[] = []
  failure?: Error
  reads = 0

  async read(): Promise<NamedQuota[]> {
    this.reads++
    if (this.failure) throw this.failure
    return this.readings
  }
}
