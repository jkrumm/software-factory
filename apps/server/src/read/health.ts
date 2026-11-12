import type { Health, HealthLine, HealthLoop } from '@software-factory/contract'

export interface HealthFacts {
  version: string
  /** null while the database answers, else why it does not (what the probe last saw, never a query of this call) */
  databaseFailure: string | null
  /** the last successful tick; null until the tick exists and has run */
  tickAt: string | null
  /** the last change of the queue; null until there is one */
  queueMovedAt: string | null
  /** why the factory is stopped as far as the tick shows (`judgeTick`), or null; left out, there is no tick to judge */
  tickFailure?: string | null
  /** what is worth saying while the factory is still ok: `starting`, `deploying`, `starved: …` */
  notice?: string | null
  /** the door's health lines; they inform and never change the status */
  lines?: readonly HealthLine[]
  loops?: readonly HealthLoop[]
}

/** How long a server that has not ticked yet is given for its first pass: a restart on a loaded host takes minutes. */
export const FIRST_TICK_GRACE_MS = 5 * 60_000
/** No successful tick for this long is a stopped factory. Shorter than that is a host too loaded to tick, which recovers by itself. */
export const TICK_DEAD_MS = 20 * 60_000
/** A deploy that has held its lock this long is not trusted to be running any more: it is a stopped factory again. */
export const DEPLOY_MAX_MS = 30 * 60_000

export interface TickInput {
  tickMs: number
  now: Date
  startedAt: Date
  tickAt: Date | null
  /** when the running deploy took its lock; null when none runs */
  deployingSince?: Date | null
  /** how the leads tick last failed, or null */
  tickError?: string | null
  /** the host's one-minute load average, for the starved reason */
  load?: number | null
  /** the age that makes a tick dead, in place of `TICK_DEAD_MS`, and the grace of the first tick (`FACTORY_HEARTBEAT_STALE_MS`, for a scenario) */
  limitMs?: number
}

export interface TickJudgement {
  /** set: the factory is stopped, and this is why */
  failure: string | null
  /** set: the factory is ok and this is worth saying */
  notice: string | null
}

const ok = (notice: string | null = null): TickJudgement => ({ failure: null, notice })

/**
 * Whether the leads tick says the factory is stopped, and what is worth saying while it is not. A tick of 0 is off (the
 * scenarios drive it) and is never judged. Only a stopped factory is a failure:
 *
 * - a deploy that holds its lock is `deploying`, ok, for up to `DEPLOY_MAX_MS`;
 * - a server that has not had its first pass is `starting`, ok, for `FIRST_TICK_GRACE_MS`; after that, no tick is a failure;
 * - a tick older than three intervals (and a minute) is ok but says why: starved (the process is alive, the host is
 *   loaded) or failing (its error); only `TICK_DEAD_MS` without a success is a failure.
 */
export function judgeTick(input: TickInput): TickJudgement {
  if (input.tickMs === 0) return ok()
  const { now } = input
  if (input.deployingSince && now.getTime() - input.deployingSince.getTime() <= DEPLOY_MAX_MS) return ok('deploying')

  const dead = input.limitMs ?? TICK_DEAD_MS
  const why = whyStopped(input)
  if (input.tickAt === null) {
    const grace = input.limitMs ?? FIRST_TICK_GRACE_MS
    if (now.getTime() - input.startedAt.getTime() <= grace) return ok('starting')
    return { failure: `no tick has succeeded yet; ${why}`, notice: null }
  }
  const age = now.getTime() - input.tickAt.getTime()
  const seconds = Math.round(age / 1000)
  if (age > dead) return { failure: `the last successful tick was ${seconds} s ago; ${why}`, notice: null }
  if (age > Math.min(Math.max(3 * input.tickMs, 60_000), dead)) {
    return ok(`${input.tickError ? 'failing' : 'starved'}: the last successful tick was ${seconds} s ago; ${why}`)
  }
  return ok()
}

function whyStopped(input: TickInput): string {
  if (input.tickError) return `the tick fails: ${input.tickError}`
  const load = input.load === null || input.load === undefined ? '' : ` (load ${input.load.toFixed(1)})`
  return `the process is alive but starved${load}`
}

/**
 * `/health` from what the server holds in memory: the last probe of the database and the tick. A failure of either is the
 * status and the heartbeat's reason; a notice is the reason of a factory that is still ok.
 */
export function healthOf(facts: HealthFacts): Health {
  const failure = facts.databaseFailure ?? facts.tickFailure ?? null
  const reason = failure ?? facts.notice ?? null
  return {
    status: failure === null ? 'ok' : 'unhealthy',
    version: facts.version,
    reason,
    heartbeat: { ok: failure === null, reason, tickAt: facts.tickAt, queueMovedAt: facts.queueMovedAt },
    lines: [...(facts.lines ?? [])],
    loops: [...(facts.loops ?? [])],
  }
}
