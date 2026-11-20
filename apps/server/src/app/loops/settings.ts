import * as z from 'zod'
import { parseEnv, type Environment } from '../../kernel/env.ts'
import { LOOP_NAMES, type LoopName } from '@software-factory/contract'
import { REVIEW_POLL_MS } from '../../domains/loops/reviews.ts'
import { DEFAULT_WAIT_GRACE_MS } from '../../domains/loops/selfwatch.ts'
import { DEFAULT_STEWARD_RULES } from '../../domains/loops/stall.ts'

const ms = z.coerce.number().int().min(0)

const Env = z.object({
  /** the interval of every loop that has no setting of its own; 0 turns them all off (the scenarios drive them) */
  FACTORY_TICK_MS: ms.optional(),
  /** a loop's own interval, set where a scenario drives that loop; 0 is off */
  FACTORY_LOOP_LEADS_MS: ms.optional(),
  FACTORY_LOOP_PLANNING_MS: ms.optional(),
  FACTORY_LOOP_STEWARD_MS: ms.optional(),
  FACTORY_LOOP_TRIAGE_MS: ms.optional(),
  FACTORY_LOOP_HYGIENE_MS: ms.optional(),
  FACTORY_LOOP_SELFWATCH_MS: ms.optional(),
  FACTORY_LOOP_CI_LEDGER_MS: ms.optional(),
  FACTORY_LOOP_HOST_MS: ms.optional(),
  FACTORY_LOOP_THROUGHPUT_MS: ms.optional(),
  /** the `gh` config directory the review poll uses in a work repo, whose account is not the owner's */
  FACTORY_GH_CONFIG_DIR_WORK: z.string().trim().min(1).optional(),
  /** the script the desk pass pushes a MacBook command through; unset, the dotfiles' own copy */
  FACTORY_ASK_HUMAN_BIN: z.string().trim().min(1).optional(),
  /** the ssh alias of the MacBook, for the probe whose answer counts as the owner's return; unset, no probe runs */
  FACTORY_ASK_HUMAN_HOST: z.string().trim().min(1).optional(),
  /** a timer or dependency wait is overdue this long after its exit */
  FACTORY_SELFWATCH_GRACE_MS: ms.optional(),
  /** the age that makes the leads tick stale, in place of three intervals and a minute: a scenario's way to a stale heartbeat */
  FACTORY_HEARTBEAT_STALE_MS: ms.optional(),
  /** the branch whose CI the self-watch reads; unset is the repo's default branch */
  FACTORY_SELFWATCH_BRANCH: z.string().trim().min(1).optional(),
  /** a project is swept again after this long */
  FACTORY_HYGIENE_EVERY_MS: ms.optional(),
  /** a failed hygiene judgment is asked again after this long */
  FACTORY_HYGIENE_RETRY_MS: ms.optional(),
  /** a repo is asked about a new queue shape at most once in this long */
  FACTORY_QUEUE_GAP_MS: ms.optional(),
  /** a stall younger than this is left to end by itself */
  FACTORY_STEWARD_MIN_STALL_MS: ms.optional(),
  /** a working Issue whose lead session has been quiet this long with nothing reported is nudged by the steward */
  FACTORY_STEWARD_IDLE_MS: ms.optional(),
  /** the same, for a lead whose last turn ended with background work in flight (a subagent, a check): it waits, so it is nudged much later */
  FACTORY_STEWARD_IDLE_BACKGROUND_MS: ms.optional(),
  /** an Issue still settling this long after it was filed is settled with no edges by the steward */
  FACTORY_SETTLE_TIMEOUT_MS: ms.optional(),
  /** a checkpoint in front of the owner this long is checked once more (and again after this long, once the Issue has a new event); 0 is off */
  FACTORY_CHECKPOINT_RECHECK_MS: ms.optional(),
})

export interface LoopSettings {
  /** the interval of each loop in ms; 0 is off */
  intervalMs: Record<LoopName, number>
  tickMs: number
  minStallMs: number
  idleLeadMs: number
  idleBackgroundMs: number
  retryMs: number
  queueGapMs: number
  settleTimeoutMs: number
  blockedChecks: number
  /** a note refused for a claim this long while a claim would be granted to that lead is a stall */
  claimStallMs: number
  /** a checkpoint at the owner this long is looked at again; 0 is off */
  recheckAfterMs: number
  hygieneEveryMs: number
  hygieneDailyMs: number
  hygieneRetryMs: number
  selfwatchGraceMs: number
  selfwatchBranch: string | null
  heartbeatStaleMs: number | null
  reaperGraceMs: number
  /** the `gh` config directory for work repos, null when none is set */
  ghConfigDirWork: string | null
  /** the ask-human script's path, null for the dotfiles' own copy */
  askHumanBin: string | null
  askHumanHost: string | null
}

const DEFAULT_TICK_MS = 10_000

/** A checkpoint in front of the owner this long is checked once more. */
const DEFAULT_RECHECK_MS = 6 * 3_600_000

/** A closed attempt's processes are left this long before they are ended. */
const REAPER_GRACE_MS = 5 * 60_000

/**
 * Each loop's cadence, `[fixed, least]`: a loop with a `fixed` interval runs on it whatever the tick is; one with only a
 * `least` runs on the tick but never more often (a sweep runs `make check`, the Judge and GitHub are asked for). A loop
 * not named runs on the tick. A tick of 0 turns every loop off, the scenarios' way to drive them by hand.
 */
const CADENCE: Partial<Record<LoopName, readonly [fixed: number | null, least: number]>> = {
  hygiene: [null, 15 * 60_000],
  friction: [15 * 60_000, 0],
  screen: [null, 10 * 60_000],
  selfwatch: [null, 5 * 60_000],
  'fix-classes': [6 * 3_600_000, 0],
  'ci-ledger': [15 * 60_000, 0],
  host: [60_000, 0],
  reaper: [5 * 60_000, 0],
  digest: [3 * 3_600_000, 0],
  errands: [3_600_000, 0],
  reviews: [REVIEW_POLL_MS, 0],
  desk: [15 * 60_000, 0],
  throughput: [24 * 3_600_000, 0],
}

/** The loops' settings: one interval per loop (`CADENCE`), `FACTORY_TICK_MS` the default. Throws one message naming every bad key. */
export function loadLoopSettings(env: Environment): LoopSettings {
  const e = parseEnv(Env, env)
  const tickMs = e.FACTORY_TICK_MS ?? DEFAULT_TICK_MS
  const own: Partial<Record<LoopName, number | undefined>> = {
    leads: e.FACTORY_LOOP_LEADS_MS,
    planning: e.FACTORY_LOOP_PLANNING_MS,
    steward: e.FACTORY_LOOP_STEWARD_MS,
    triage: e.FACTORY_LOOP_TRIAGE_MS,
    hygiene: e.FACTORY_LOOP_HYGIENE_MS,
    selfwatch: e.FACTORY_LOOP_SELFWATCH_MS,
    'ci-ledger': e.FACTORY_LOOP_CI_LEDGER_MS,
    host: e.FACTORY_LOOP_HOST_MS,
    throughput: e.FACTORY_LOOP_THROUGHPUT_MS,
  }
  const intervalOf = (name: LoopName): number => {
    const set = own[name]
    if (set !== undefined) return set
    if (tickMs === 0) return 0
    const [fixed, least] = CADENCE[name] ?? [null, 0]
    return fixed ?? Math.max(tickMs, least)
  }
  return {
    intervalMs: Object.fromEntries(LOOP_NAMES.map((name) => [name, intervalOf(name)])) as Record<LoopName, number>,
    tickMs,
    minStallMs: e.FACTORY_STEWARD_MIN_STALL_MS ?? 2 * 60_000,
    idleLeadMs: e.FACTORY_STEWARD_IDLE_MS ?? DEFAULT_STEWARD_RULES.idleLeadMs,
    idleBackgroundMs: e.FACTORY_STEWARD_IDLE_BACKGROUND_MS ?? DEFAULT_STEWARD_RULES.idleBackgroundMs,
    retryMs: 10 * 60_000,
    queueGapMs: e.FACTORY_QUEUE_GAP_MS ?? 30 * 60_000,
    settleTimeoutMs: e.FACTORY_SETTLE_TIMEOUT_MS ?? 15 * 60_000,
    blockedChecks: 6,
    claimStallMs: 15 * 60_000,
    recheckAfterMs: e.FACTORY_CHECKPOINT_RECHECK_MS ?? DEFAULT_RECHECK_MS,
    hygieneEveryMs: e.FACTORY_HYGIENE_EVERY_MS ?? 7 * 24 * 3_600_000,
    hygieneDailyMs: 24 * 3_600_000,
    hygieneRetryMs: e.FACTORY_HYGIENE_RETRY_MS ?? 6 * 3_600_000,
    selfwatchGraceMs: e.FACTORY_SELFWATCH_GRACE_MS ?? DEFAULT_WAIT_GRACE_MS,
    selfwatchBranch: e.FACTORY_SELFWATCH_BRANCH ?? null,
    heartbeatStaleMs: e.FACTORY_HEARTBEAT_STALE_MS ?? null,
    reaperGraceMs: REAPER_GRACE_MS,
    ghConfigDirWork: e.FACTORY_GH_CONFIG_DIR_WORK ?? null,
    askHumanBin: e.FACTORY_ASK_HUMAN_BIN ?? null,
    askHumanHost: e.FACTORY_ASK_HUMAN_HOST ?? null,
  }
}
