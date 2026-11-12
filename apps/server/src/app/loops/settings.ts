import * as z from 'zod'
import { LOOP_NAMES, type LoopName } from '@software-factory/contract'
import { DEFAULT_WAIT_GRACE_MS } from '../../domains/loops/selfwatch.ts'
import { DEFAULT_STEWARD_RULES } from '../../domains/loops/stall.ts'

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
  FACTORY_LOOP_QUEUE_MS: ms.optional(),
  FACTORY_LOOP_FRICTION_MS: ms.optional(),
  FACTORY_LOOP_HYGIENE_MS: ms.optional(),
  FACTORY_LOOP_SCREEN_MS: ms.optional(),
  FACTORY_LOOP_FIX_CLASSES_MS: ms.optional(),
  FACTORY_LOOP_SELFWATCH_MS: ms.optional(),
  FACTORY_LOOP_HOST_MS: ms.optional(),
  FACTORY_LOOP_REAPER_MS: ms.optional(),
  FACTORY_LOOP_DIGEST_MS: ms.optional(),
  /** a closed attempt's processes are left this long (at least 1 minute) before the reaper ends them */
  FACTORY_REAPER_GRACE_MS: z.coerce.number().int().min(60_000).optional(),
  /** 1: the reaper decides and records with signal `dry`, and sends nothing */
  FACTORY_REAPER_DRY: z.enum(['0', '1']).optional(),
  /** a timer or dependency wait is overdue this long after its exit */
  FACTORY_SELFWATCH_GRACE_MS: ms.optional(),
  /** the age that makes the leads tick stale, in place of three intervals and a minute: a scenario's way to a stale heartbeat */
  FACTORY_HEARTBEAT_STALE_MS: ms.optional(),
  /** the branch whose CI the self-watch reads; unset is the repo's default branch */
  FACTORY_SELFWATCH_BRANCH: z.string().trim().min(1).optional(),
  /** only these projects (a comma list of names) are swept; unset is every project with a `project.yaml` */
  FACTORY_HYGIENE_REPOS: z.string().optional(),
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
  /** the steward asks `factory-steward` again after a failed or refused answer this long on */
  FACTORY_STEWARD_RETRY_MS: ms.optional(),
  /** an Issue still settling this long after it was filed is settled with no edges by the steward */
  FACTORY_SETTLE_TIMEOUT_MS: ms.optional(),
  /** a watch whose last N checks were all blocked is told to its lead */
  FACTORY_BLOCKED_CHECKS: z.coerce.number().int().min(1).optional(),
  FACTORY_CLAIM_STALL_MS: z.coerce.number().int().min(1).optional(),
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
  hygieneRepos: string[] | null
  hygieneEveryMs: number
  hygieneRetryMs: number
  selfwatchGraceMs: number
  selfwatchBranch: string | null
  heartbeatStaleMs: number | null
  reaperGraceMs: number
  reaperDry: boolean
}

export const DEFAULT_TICK_MS = 10_000

/** A checkpoint in front of the owner this long is checked once more. */
export const DEFAULT_RECHECK_MS = 6 * 3_600_000

/** One sweep runs `make check` over a project: at most one in this long, unless the tick is off (0). */
const HYGIENE_MIN_TICK_MS = 15 * 60_000
const hygieneTickMs = (tickMs: number): number => (tickMs === 0 ? 0 : Math.max(tickMs, HYGIENE_MIN_TICK_MS))

/** The Judge screens held signals: at most one pass in this long, unless the tick is off (0). */
const SCREEN_MIN_TICK_MS = 10 * 60_000
const screenTickMs = (tickMs: number): number => (tickMs === 0 ? 0 : Math.max(tickMs, SCREEN_MIN_TICK_MS))

/** Fix commits are sorted once a day, unless the tick is off (0). */
const FIX_CLASSES_TICK_MS = 6 * 3_600_000
const fixClassesTickMs = (tickMs: number): number => (tickMs === 0 ? 0 : FIX_CLASSES_TICK_MS)

/** The host is sampled once a minute, unless the tick is off (0). */
const HOST_TICK_MS = 60_000
const hostTickMs = (tickMs: number): number => (tickMs === 0 ? 0 : HOST_TICK_MS)

/** The project digests are asked for every 3 hours, unless the tick is off (0). */
export const DIGEST_TICK_MS = 3 * 3_600_000
const digestTickMs = (tickMs: number): number => (tickMs === 0 ? 0 : DIGEST_TICK_MS)

/** The reaper looks at the process table every 5 minutes, unless the tick is off (0). */
const REAPER_TICK_MS = 5 * 60_000
const reaperTickMs = (tickMs: number): number => (tickMs === 0 ? 0 : REAPER_TICK_MS)

/** A closed attempt's processes are left this long before they are ended. */
export const DEFAULT_REAPER_GRACE_MS = 5 * 60_000

/** The self-watch reads GitHub and git: at most one pass in this long, unless the tick is off (0). */
const SELFWATCH_MIN_TICK_MS = 5 * 60_000
const selfwatchTickMs = (tickMs: number): number => (tickMs === 0 ? 0 : Math.max(tickMs, SELFWATCH_MIN_TICK_MS))

/** The loops' settings: one interval per loop, `FACTORY_TICK_MS` the default (hygiene: at least 15 minutes, screen: at least 10, fix-classes: every 6 hours, so a restart never skips a day, selfwatch: at least 5). Throws one message naming every bad key. */
export function loadLoopSettings(env: Record<string, string | undefined>): LoopSettings {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  const e = parsed.data
  const tickMs = e.FACTORY_TICK_MS ?? DEFAULT_TICK_MS
  const repos = (e.FACTORY_HYGIENE_REPOS ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
  const own: Record<LoopName, number | undefined> = {
    leads: e.FACTORY_LOOP_LEADS_MS,
    planning: e.FACTORY_LOOP_PLANNING_MS,
    watch: e.FACTORY_LOOP_WATCH_MS,
    settle: e.FACTORY_LOOP_SETTLE_MS,
    send: e.FACTORY_LOOP_SEND_MS,
    steward: e.FACTORY_LOOP_STEWARD_MS,
    triage: e.FACTORY_LOOP_TRIAGE_MS,
    queue: e.FACTORY_LOOP_QUEUE_MS,
    friction: e.FACTORY_LOOP_FRICTION_MS,
    hygiene: e.FACTORY_LOOP_HYGIENE_MS,
    screen: e.FACTORY_LOOP_SCREEN_MS,
    'fix-classes': e.FACTORY_LOOP_FIX_CLASSES_MS,
    selfwatch: e.FACTORY_LOOP_SELFWATCH_MS,
    host: e.FACTORY_LOOP_HOST_MS,
    reaper: e.FACTORY_LOOP_REAPER_MS,
    digest: e.FACTORY_LOOP_DIGEST_MS,
  }
  return {
    intervalMs: Object.fromEntries(
      LOOP_NAMES.map((name) => [
        name,
        own[name] ??
          (name === 'hygiene'
            ? hygieneTickMs(tickMs)
            : name === 'screen'
              ? screenTickMs(tickMs)
              : name === 'fix-classes'
                ? fixClassesTickMs(tickMs)
                : name === 'selfwatch'
                  ? selfwatchTickMs(tickMs)
                  : name === 'host'
                    ? hostTickMs(tickMs)
                    : name === 'reaper'
                      ? reaperTickMs(tickMs)
                      : name === 'digest'
                        ? digestTickMs(tickMs)
                        : tickMs),
      ]),
    ) as Record<LoopName, number>,
    tickMs,
    minStallMs: e.FACTORY_STEWARD_MIN_STALL_MS ?? 2 * 60_000,
    idleLeadMs: e.FACTORY_STEWARD_IDLE_MS ?? DEFAULT_STEWARD_RULES.idleLeadMs,
    idleBackgroundMs: e.FACTORY_STEWARD_IDLE_BACKGROUND_MS ?? DEFAULT_STEWARD_RULES.idleBackgroundMs,
    retryMs: e.FACTORY_STEWARD_RETRY_MS ?? 10 * 60_000,
    queueGapMs: e.FACTORY_QUEUE_GAP_MS ?? 30 * 60_000,
    settleTimeoutMs: e.FACTORY_SETTLE_TIMEOUT_MS ?? 15 * 60_000,
    blockedChecks: e.FACTORY_BLOCKED_CHECKS ?? 6,
    claimStallMs: e.FACTORY_CLAIM_STALL_MS ?? 15 * 60_000,
    recheckAfterMs: e.FACTORY_CHECKPOINT_RECHECK_MS ?? DEFAULT_RECHECK_MS,
    hygieneRepos: repos.length > 0 ? repos : null,
    hygieneEveryMs: e.FACTORY_HYGIENE_EVERY_MS ?? 7 * 24 * 3_600_000,
    hygieneRetryMs: e.FACTORY_HYGIENE_RETRY_MS ?? 6 * 3_600_000,
    selfwatchGraceMs: e.FACTORY_SELFWATCH_GRACE_MS ?? DEFAULT_WAIT_GRACE_MS,
    selfwatchBranch: e.FACTORY_SELFWATCH_BRANCH ?? null,
    heartbeatStaleMs: e.FACTORY_HEARTBEAT_STALE_MS ?? null,
    reaperGraceMs: e.FACTORY_REAPER_GRACE_MS ?? DEFAULT_REAPER_GRACE_MS,
    reaperDry: e.FACTORY_REAPER_DRY === '1',
  }
}
