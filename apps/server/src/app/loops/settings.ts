import * as z from 'zod'
import { LOOP_NAMES, type LoopName } from '@software-factory/contract'

const ms = z.coerce.number().int().min(0)

const Env = z.object({
  /** the interval of every loop that has no setting of its own; 0 turns them all off (the scenarios drive them) */
  FACTORY_TICK_MS: ms.optional(),
  FACTORY_LOOP_LEADS_MS: ms.optional(),
  FACTORY_LOOP_PLANNING_MS: ms.optional(),
  FACTORY_LOOP_WATCH_MS: ms.optional(),
  FACTORY_LOOP_SETTLE_MS: ms.optional(),
  FACTORY_LOOP_SEND_MS: ms.optional(),
  FACTORY_LOOP_STEWARD_MS: ms.optional(),
  FACTORY_LOOP_TRIAGE_MS: ms.optional(),
  /** a stall younger than this is left to end by itself */
  FACTORY_STEWARD_MIN_STALL_MS: ms.optional(),
  /** the steward asks `factory-steward` again after a failed or refused answer this long on */
  FACTORY_STEWARD_RETRY_MS: ms.optional(),
  /** an Issue still settling this long after it was filed is settled with no edges by the steward */
  FACTORY_SETTLE_TIMEOUT_MS: ms.optional(),
  /** a watch whose last N checks were all blocked is told to its lead */
  FACTORY_BLOCKED_CHECKS: z.coerce.number().int().min(1).optional(),
})

export interface LoopSettings {
  /** the interval of each loop in ms; 0 is off */
  intervalMs: Record<LoopName, number>
  tickMs: number
  minStallMs: number
  retryMs: number
  settleTimeoutMs: number
  blockedChecks: number
}

export const DEFAULT_TICK_MS = 10_000

/** The loops' settings: one interval per loop, `FACTORY_TICK_MS` the default. Throws one message naming every bad key. */
export function loadLoopSettings(env: Record<string, string | undefined>): LoopSettings {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  const e = parsed.data
  const tickMs = e.FACTORY_TICK_MS ?? DEFAULT_TICK_MS
  const own: Record<LoopName, number | undefined> = {
    leads: e.FACTORY_LOOP_LEADS_MS,
    planning: e.FACTORY_LOOP_PLANNING_MS,
    watch: e.FACTORY_LOOP_WATCH_MS,
    settle: e.FACTORY_LOOP_SETTLE_MS,
    send: e.FACTORY_LOOP_SEND_MS,
    steward: e.FACTORY_LOOP_STEWARD_MS,
    triage: e.FACTORY_LOOP_TRIAGE_MS,
  }
  return {
    intervalMs: Object.fromEntries(LOOP_NAMES.map((name) => [name, own[name] ?? tickMs])) as Record<LoopName, number>,
    tickMs,
    minStallMs: e.FACTORY_STEWARD_MIN_STALL_MS ?? 2 * 60_000,
    retryMs: e.FACTORY_STEWARD_RETRY_MS ?? 10 * 60_000,
    settleTimeoutMs: e.FACTORY_SETTLE_TIMEOUT_MS ?? 15 * 60_000,
    blockedChecks: e.FACTORY_BLOCKED_CHECKS ?? 6,
  }
}
