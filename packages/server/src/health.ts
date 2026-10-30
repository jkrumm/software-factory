import type { Health } from '@software-factory/contract'
import type { Clock } from './clock.ts'

/** Unhealthy once no pass has succeeded for this many intervals. */
export const STALE_INTERVALS = 3

/**
 * What the ticker tells `/health`: when a pass last succeeded and what last went wrong. A pass that runs a start can
 * legitimately outlast three intervals, so while one is in flight only `passLimitMs` counts; between passes the age
 * of the last success does. A server that has not yet had a successful pass is unhealthy once no pass is running, so a
 * deploy whose ticker is broken never counts as up.
 */
export class TickMonitor {
  private lastSuccess: Date | null = null
  private lastError: { at: Date; message: string } | null = null
  private passStartedAt: Date | null = null

  constructor(
    private readonly clock: Clock,
    private readonly intervalMs: number,
    private readonly passLimitMs: number,
  ) {}

  passStarted(): void {
    this.passStartedAt = this.clock.now()
  }

  passSucceeded(): void {
    this.lastSuccess = this.clock.now()
    this.passStartedAt = null
  }

  /** A pass that threw. */
  passFailed(message: string): void {
    this.noteError(message)
    this.passStartedAt = null
  }

  /** A failure inside a pass that otherwise completed (a result that could not be recorded). */
  noteError(message: string): void {
    this.lastError = { at: this.clock.now(), message }
  }

  snapshot(): Pick<Health, 'status' | 'reason' | 'tick'> {
    const now = this.clock.now().getTime()
    const tick = {
      lastSuccessAt: this.lastSuccess?.toISOString() ?? null,
      lastError: this.lastError && { at: this.lastError.at.toISOString(), message: this.lastError.message },
    }
    const reason = this.staleReason(now)
    return { status: reason ? 'unhealthy' : 'ok', reason, tick }
  }

  private staleReason(now: number): string | null {
    if (this.passStartedAt) {
      const running = now - this.passStartedAt.getTime()
      return running > this.passLimitMs
        ? `a tick pass has run for ${Math.round(running / 1000)}s (limit ${Math.round(this.passLimitMs / 1000)}s)`
        : null
    }
    if (!this.lastSuccess) return 'no tick has succeeded yet'
    const limit = STALE_INTERVALS * this.intervalMs
    const age = now - this.lastSuccess.getTime()
    if (age <= limit) return null
    return `no successful tick for ${Math.round(age / 1000)}s (limit ${Math.round(limit / 1000)}s)`
  }
}
