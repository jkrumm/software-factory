import * as z from 'zod'
import { type AccountRank, type AccountReading, RANK_LANE } from '../../domains/capacity/accounts.ts'
import type { AccountRanker, AccountSource } from '../../domains/capacity/ports.ts'
import { err, ok, type PortError, portError, type Result } from '../../kernel/result.ts'
import { CannotStart, runProcess } from './process.ts'

const MAX_EPOCH_S = 4_102_444_800 // 2100-01-01
const MAX_AGE_S = 7 * 24 * 3600
const epoch = z.number().int().positive().max(MAX_EPOCH_S).nullable()
// utilisation in percent; the source does not document a clamp at 100, so only nonsense is refused
const percent = z.number().min(0).max(1000).nullable()

/**
 * One account of `claude-account usage --json`: the picker prints a row for every account of the registry
 * (`dotfiles/config/claude-accounts.json`), so accounts are never listed here. Times are epoch seconds. Fields the
 * factory does not use are ignored; one it needs that is missing or of another type is an error, not a guess.
 */
const UsageRow = z.looseObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  enabled: z.boolean(),
  auth_ok: z.boolean(),
  five_hour: percent,
  seven_day: percent,
  five_hour_resets_at: epoch,
  seven_day_resets_at: epoch,
  age_s: z.number().min(0).max(MAX_AGE_S).nullable(),
  exhausted_until: epoch,
})
const Usage = z.looseObject({ accounts: z.array(z.unknown()) })

/** Runs `claude-account <args> --json` and returns its stdout; a failure to start, a timeout or an exit code is a port error. */
async function runPicker(bin: string, args: string[], timeoutMs: number): Promise<Result<string, PortError>> {
  const name = args[0]
  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await runProcess([bin, ...args, '--json'], { timeoutMs })
  } catch (error) {
    if (error instanceof CannotStart) return err(portError('gone', error.message))
    throw error
  }
  if (result.timedOut) return err(portError('timeout', `${bin} ${name} did not answer within ${timeoutMs} ms`))
  if (result.code !== 0) return err(portError('gone', `${bin} ${name} exited ${result.code}`))
  return ok(result.stdout)
}

const at = (seconds: number | null): Date | null => (seconds === null ? null : new Date(seconds * 1000))

/** The account picker in dotfiles, called through its CLI (`claude-account usage --json`: a pure read of its cache). */
export function claudeAccountSource(options: { bin: string; timeoutMs?: number }): AccountSource {
  const timeoutMs = options.timeoutMs ?? 15_000
  return {
    async read(now) {
      const printed = await runPicker(options.bin, ['usage'], timeoutMs)
      if (!printed.ok) return printed
      let rows: unknown[]
      try {
        rows = Usage.parse(JSON.parse(printed.value)).accounts
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

/**
 * `claude-account rank --lane <lane> --json`: the accounts that may take work in the lane, best first. Ineligible
 * accounts are absent; `weight` is optional. A reply for another lane or of another shape is an error, not a guess.
 */
const RankRow = z.looseObject({
  account: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  reason: z.string(),
  weight: z.number().nullish(),
})
const Rank = z.looseObject({
  lane: z.string(),
  order: z.array(RankRow),
  at: z.iso.datetime({ offset: true }),
})

/** The account picker's rank for a lane, called through its CLI (a pure read of the picker's cache). */
export function claudeAccountRanker(options: { bin: string; timeoutMs?: number; lane?: string }): AccountRanker {
  const timeoutMs = options.timeoutMs ?? 15_000
  const lane = options.lane ?? RANK_LANE
  return {
    async read(now) {
      const printed = await runPicker(options.bin, ['rank', '--lane', lane], timeoutMs)
      if (!printed.ok) return printed
      let rank: z.infer<typeof Rank>
      try {
        rank = Rank.parse(JSON.parse(printed.value))
      } catch (cause) {
        return err(
          portError(
            'unreadable',
            `${options.bin} rank --json did not print the expected shape: ${String(cause).slice(0, 300)}`,
          ),
        )
      }
      if (rank.lane !== lane) {
        return err(portError('unreadable', `${options.bin} rank answered for lane ${rank.lane}, not ${lane}`))
      }
      return ok<AccountRank>({
        lane,
        order: rank.order.map((r) => ({ account: r.account, reason: r.reason, weight: r.weight ?? null })),
        at: new Date(rank.at),
        readAt: now,
      })
    },
  }
}
