import { z } from 'zod'
import type { SQL } from 'bun'
import { type NamedQuota, recordReadings } from './capacity.ts'
import type { Clock } from './clock.ts'
import { CannotExecute, DEFAULT_PROCESS_TIMEOUT_MS, EXIT_TIMEOUT, runProcess } from './exec.ts'
import { AccountName } from './schemas.ts'

/** Reads the quota of every account of the registry. Implementations carry their own process timeout. */
export interface QuotaSource {
  read(): Promise<NamedQuota[]>
}

/** The source could not be read: the message says why, the poller tries again at the next poll. */
export class QuotaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaError'
  }
}

const epoch = z.number().nullable()

/**
 * One account of `claude-account usage --json`: the picker prints a row for every account of the registry
 * (`dotfiles/config/claude-accounts.json`), so the accounts are never listed here. Times are epoch seconds. Fields the
 * factory does not use are ignored; one it needs that is missing or of another type is an error, not a guess.
 */
const UsageRow = z.looseObject({
  id: AccountName,
  enabled: z.boolean(),
  auth_ok: z.boolean(),
  five_hour: z.number().nullable(),
  seven_day: z.number().nullable(),
  five_hour_resets_at: epoch,
  seven_day_resets_at: epoch,
  age_s: z.number().nullable(),
  exhausted_until: epoch,
})
const Usage = z.looseObject({ accounts: z.array(UsageRow) })

const at = (seconds: number | null): Date | null => (seconds === null ? null : new Date(seconds * 1000))

/** The account picker in dotfiles, called through its CLI (`claude-account usage --json`: a pure read of its cache). */
export class ClaudeAccountSource implements QuotaSource {
  constructor(private readonly options: { bin: string; timeoutMs?: number }) {}

  async read(): Promise<NamedQuota[]> {
    const { bin, timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS } = this.options
    let result: Awaited<ReturnType<typeof runProcess>>
    try {
      result = await runProcess([bin, 'usage', '--json'], timeoutMs)
    } catch (error) {
      throw new QuotaError(error instanceof CannotExecute ? error.message : String(error))
    }
    if (result.exitCode === EXIT_TIMEOUT) throw new QuotaError(`${bin} usage did not answer within ${timeoutMs} ms`)
    if (result.exitCode !== 0) throw new QuotaError(`${bin} usage exited ${result.exitCode}`)
    let usage: z.infer<typeof Usage>
    try {
      usage = Usage.parse(JSON.parse(result.stdout))
    } catch (cause) {
      throw new QuotaError(`${bin} usage --json did not print the expected shape: ${String(cause).slice(0, 300)}`)
    }
    return usage.accounts.map((a) => ({
      account: a.id,
      enabled: a.enabled,
      authOk: a.auth_ok,
      fiveHourUsed: a.five_hour,
      weeklyUsed: a.seven_day,
      fiveHourResetsAt: at(a.five_hour_resets_at),
      weeklyResetsAt: at(a.seven_day_resets_at),
      exhaustedUntil: at(a.exhausted_until),
      ageS: a.age_s,
    }))
  }
}

/** One poll a minute: the cadence of the picker's own cache is finer than that, and a spawn can wait a minute. */
export const POLL_EVERY_MS = 60_000

/**
 * Reads the source and stores every reading as a fact. `pollIfDue` is the tick's call: at most once per interval, and
 * a failed attempt counts, so a broken picker is retried a minute later, not every pass. `poll` is on demand.
 */
export class QuotaPoller {
  private lastAttemptAt = Number.NEGATIVE_INFINITY
  private inFlight: Promise<NamedQuota[]> | undefined

  constructor(private readonly deps: { sql: SQL; source: QuotaSource; clock: Clock; everyMs?: number }) {}

  async pollIfDue(): Promise<void> {
    const now = this.deps.clock.now().getTime()
    if (now - this.lastAttemptAt < (this.deps.everyMs ?? POLL_EVERY_MS)) return
    await this.poll()
  }

  /**
   * Reads and stores now; returns the readings. Throws what the source throws. A poll already running is joined, not
   * repeated: two overlapping polls could store an older sample after a newer one, and the newest row wins.
   */
  poll(): Promise<NamedQuota[]> {
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  private async read(): Promise<NamedQuota[]> {
    this.lastAttemptAt = this.deps.clock.now().getTime()
    const readings = await this.deps.source.read()
    await recordReadings(this.deps.sql, readings, this.deps.clock.now())
    return readings
  }
}
