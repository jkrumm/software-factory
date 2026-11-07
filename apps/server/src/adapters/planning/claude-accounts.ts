import * as z from 'zod'
import type { AccountReading } from '../../domains/capacity/accounts.ts'
import type { AccountSource } from '../../domains/capacity/ports.ts'
import { err, ok, portError } from '../../kernel/result.ts'
import { CannotStart, runProcess } from './process.ts'

const epoch = z.number().nullable()

/**
 * One account of `claude-account usage --json`: the picker prints a row for every account of the registry
 * (`dotfiles/config/claude-accounts.json`), so accounts are never listed here. Times are epoch seconds. Fields the
 * factory does not use are ignored; one it needs that is missing or of another type is an error, not a guess.
 */
const UsageRow = z.looseObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  enabled: z.boolean(),
  auth_ok: z.boolean(),
  five_hour: z.number().nullable(),
  seven_day: z.number().nullable(),
  five_hour_resets_at: epoch,
  seven_day_resets_at: epoch,
  age_s: z.number().nullable(),
  exhausted_until: epoch,
})
const Usage = z.looseObject({ accounts: z.array(z.unknown()) })

const at = (seconds: number | null): Date | null => (seconds === null ? null : new Date(seconds * 1000))

/** The account picker in dotfiles, called through its CLI (`claude-account usage --json`: a pure read of its cache). */
export function claudeAccountSource(options: { bin: string; timeoutMs?: number }): AccountSource {
  const timeoutMs = options.timeoutMs ?? 15_000
  return {
    async read(now) {
      let result: Awaited<ReturnType<typeof runProcess>>
      try {
        result = await runProcess([options.bin, 'usage', '--json'], { timeoutMs })
      } catch (error) {
        if (error instanceof CannotStart) return err(portError('gone', error.message))
        throw error
      }
      if (result.timedOut)
        return err(portError('timeout', `${options.bin} usage did not answer within ${timeoutMs} ms`))
      if (result.code !== 0) return err(portError('gone', `${options.bin} usage exited ${result.code}`))
      let rows: unknown[]
      try {
        rows = Usage.parse(JSON.parse(result.stdout)).accounts
      } catch (cause) {
        return err(
          portError(
            'unreadable',
            `${options.bin} usage --json did not print the expected shape: ${String(cause).slice(0, 300)}`,
          ),
        )
      }
      // One row that does not parse must not freeze the other accounts; all of them failing is a drifted shape.
      const parsed = rows.map((row) => UsageRow.safeParse(row))
      const good = parsed.flatMap((p) => (p.success ? [p.data] : []))
      if (rows.length > 0 && good.length === 0) {
        const first = parsed.find((p) => !p.success)
        const why = first && !first.success ? (first.error.issues[0]?.message ?? 'invalid') : 'invalid'
        return err(portError('unreadable', `${options.bin} usage --json did not print the expected shape: ${why}`))
      }
      return ok(
        good.map((a): AccountReading => ({
          account: a.id,
          readAt: now,
          sampledAt: a.age_s === null ? null : new Date(now.getTime() - a.age_s * 1000),
          enabled: a.enabled,
          authOk: a.auth_ok,
          fiveHourUsed: a.five_hour,
          weeklyUsed: a.seven_day,
          fiveHourResetsAt: at(a.five_hour_resets_at),
          weeklyResetsAt: at(a.seven_day_resets_at),
          exhaustedUntil: at(a.exhausted_until),
        })),
      )
    },
  }
}
