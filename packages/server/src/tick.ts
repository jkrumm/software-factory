import type { Effort, Tier } from '@software-factory/contract'
import type { SQL } from 'bun'
import { admit, type Decision, HOLD_RECHECK_MS } from './admission.ts'
import { lockCapacity } from './capacity.ts'
import type { Clock } from './clock.ts'
import { DEFAULT_RETRY_BUDGET_MS } from './config.ts'
import type { TickMonitor } from './health.ts'
import { DEFAULT_START_BUDGET_MS, type Runner, RunnerError } from './runner.ts'
import type { QuotaPoller } from './quota.ts'
import { dropEmptySession, type LiveSession, openSession } from './sessions.ts'
import type { SpoolReplayer } from './spool.ts'

/** Delay before a spawn whose start failed is claimed again: base, 2*base, ... up to cap. */
export const RETRY_DELAY = { baseMs: 30_000, capMs: 300_000 }
export const retryDelayMs = (attempt: number): number =>
  Math.min(RETRY_DELAY.capMs, RETRY_DELAY.baseMs * 2 ** (attempt - 1))
/** A claim older than this is a crashed tick's: the longest a `HerdrRunner.start` can run, plus a minute. */
export const DEFAULT_LEASE_MS = DEFAULT_START_BUDGET_MS + 60_000
/** Most spawns one tick claims; the rest wait for the next. */
export const DEFAULT_BATCH = 20

export interface TickDeps {
  sql: SQL
  runner: Runner
  clock: Clock
  leaseMs?: number
  batch?: number
  retryBudgetMs?: number
  /** the hooks' spool, read at the start of every pass */
  spool?: SpoolReplayer
  /** the account picker's readings, polled once a minute at the start of a pass */
  quota?: QuotaPoller
}

export interface TickResult {
  started: string[]
  failed: string[]
  /** start failed, will be claimed again after a delay */
  retrying: string[]
  /** due, but not started: no account had capacity (back to waiting) or a rule holds it (queued, rechecked later) */
  skipped: number
  /** the result could not be recorded; the claim stays and is reclaimed when its lease runs out */
  errors: string[]
  /** spool lines read this pass */
  replayed: number
}

export interface Claim {
  key: string
  repo: string
  prompt: string
  account: string
  /** the role table's tier and effort for the spawn's role, as stored when it was queued */
  tier: Tier
  effort: Effort
  attempts: number
  /** when this spawn's retry budget started */
  firstClaimedAt: Date
}

interface DueRow {
  key: string
  repo: string
  prompt: string
  role: string
  tier: Tier
  effort: Effort
  status: 'queued' | 'waiting' | 'starting'
  account: string | null
  attempts: number
  error: string | null
  first_claimed_at: Date | null
}

/** One line per spawn that leaves the queue for good, so the reason is in the log whatever else is read. */
function logFailed(key: string, reason: string): void {
  console.error('spawn failed', { key, reason })
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`

/**
 * Phase 1: in one short transaction, take the spawns that are due and mark them `starting`. The pane is named after
 * the key, so a claim that dies before its result is recorded is found again by name, not started twice.
 * Due means `resume_at` has passed (a queued spawn has none), or a claim whose lease ran out. Waiting spawns sort
 * after queued ones and held ones last of all, and a spawn that cannot start leaves the due set (a held one for 30 s), so
 * it does not hold up the rest.
 * Admission (queue state, one wave per repo, capacity) is decided again here: a stored account is only a hint.
 */
export async function claimDue(deps: TickDeps): Promise<{ claims: Claim[]; failed: string[]; skipped: number }> {
  const { sql, clock } = deps
  const now = clock.now()
  const staleBefore = new Date(now.getTime() - (deps.leaseMs ?? DEFAULT_LEASE_MS))

  const outcome = await sql.begin(async (tx) => {
    await lockCapacity(tx)
    const due: DueRow[] = await tx`
      SELECT key, repo, prompt, role, tier, effort, status, account, attempts, error, first_claimed_at FROM factory.spawns
      WHERE (status = 'queued' AND (resume_at IS NULL OR resume_at <= ${now}))
         OR (status = 'waiting' AND resume_at <= ${now})
         OR (status = 'starting' AND claimed_at <= ${staleBefore})
      ORDER BY (hold IS NOT NULL), (status = 'waiting'), created_at, key
      LIMIT ${deps.batch ?? DEFAULT_BATCH}
      FOR UPDATE SKIP LOCKED`

    const live: { sessions?: LiveSession[] } = {}
    // A session row that goes away is no longer alive for the rows after it in this pass.
    const forget = (id: string) => {
      if (live.sessions) live.sessions = live.sessions.filter((s) => s.id !== id)
    }
    const claims: Claim[] = []
    const failed: { key: string; reason: string }[] = []
    let skipped = 0
    const budgetMs = deps.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS

    for (const row of due) {
      if (row.first_claimed_at && now.getTime() - row.first_claimed_at.getTime() >= budgetMs) {
        const reason = `gave up: the ${minutes(budgetMs)} retry budget is spent after ${row.attempts} attempts${row.error ? `: ${row.error}` : ''}`
        await tx`UPDATE factory.spawns SET status = 'failed', claimed_at = NULL, error = ${reason} WHERE key = ${row.key}`
        if (await dropEmptySession(tx, row.key)) forget(row.key)
        failed.push({ key: row.key, reason })
        continue
      }

      // A reclaimed claim may already have its pane; finish it on the account it has instead of asking again.
      const reclaimed = row.status === 'starting' && row.account !== null
      const decision: Decision =
        reclaimed && row.account
          ? { kind: 'start', account: row.account }
          : await admit(tx, { key: row.key, repo: row.repo, role: row.role, prefer: row.account }, now, live)
      if (decision.kind !== 'start') {
        // Waiting is not failing: the retry clock starts over when the spawn is claimed again.
        const status = decision.kind === 'wait' ? 'waiting' : 'queued'
        const resumeAt = decision.kind === 'wait' ? decision.resumeAt : new Date(now.getTime() + HOLD_RECHECK_MS)
        await tx`
          UPDATE factory.spawns
          SET status = ${status}, account = NULL, assigned_at = NULL, hold = ${decision.kind === 'hold' ? decision.reason : null},
              claimed_at = NULL, resume_at = ${resumeAt}, first_claimed_at = NULL
          WHERE key = ${row.key}`
        if (await dropEmptySession(tx, row.key)) forget(row.key)
        skipped++
        continue
      }
      await tx`
        UPDATE factory.spawns
        SET status = 'starting', account = ${decision.account},
            assigned_at = CASE WHEN ${reclaimed} THEN COALESCE(assigned_at, ${now}) ELSE ${now} END, hold = NULL,
            claimed_at = ${now}, resume_at = NULL, attempts = attempts + 1,
            first_claimed_at = COALESCE(first_claimed_at, ${now})
        WHERE key = ${row.key}`
      // From the claim on it is a session that is starting; the hooks' first event ends that.
      await openSession(tx, { id: row.key, spawnKey: row.key, pane: null, at: now })
      live.sessions?.push({ id: row.key, repo: row.repo, role: row.role })
      claims.push({
        key: row.key,
        repo: row.repo,
        prompt: row.prompt,
        account: decision.account,
        tier: row.tier,
        effort: row.effort,
        attempts: row.attempts + 1,
        firstClaimedAt: row.first_claimed_at ?? now,
      })
    }
    return { claims, failed, skipped }
  })
  for (const { key, reason } of outcome.failed) logFailed(key, reason)
  return { claims: outcome.claims, failed: outcome.failed.map((f) => f.key), skipped: outcome.skipped }
}

/** Phase 3: record the outcome in a transaction of its own. Only a row still `starting` is touched. */
async function recordStarted(sql: SQL, key: string, session: string, at: Date): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE factory.spawns SET status = 'started', session = ${session}, claimed_at = NULL, error = NULL, assigned_at = ${at}
      WHERE key = ${key} AND status = 'starting'
      RETURNING key`
    // The spawn is a session from here on: `starting` until its first hook event says otherwise.
    if (rows.length > 0) await openSession(tx, { id: key, spawnKey: key, pane: session, at })
    return rows.length > 0
  })
}

async function recordFailure(deps: TickDeps, claim: Claim, error: unknown): Promise<'failed' | 'retrying'> {
  const message = error instanceof Error ? error.message : String(error)
  const now = deps.clock.now()
  const budgetMs = deps.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS
  const permanent = error instanceof RunnerError && error.permanent
  const spent = now.getTime() - claim.firstClaimedAt.getTime() >= budgetMs
  if (permanent || spent) {
    const reason = permanent
      ? message
      : `gave up: the ${minutes(budgetMs)} retry budget is spent after ${claim.attempts} attempts: ${message}`
    const failed = await deps.sql.begin(async (tx) => {
      const rows = await tx`
        UPDATE factory.spawns SET status = 'failed', claimed_at = NULL, error = ${reason}
        WHERE key = ${claim.key} AND status = 'starting'
        RETURNING key`
      if (rows.length > 0) await dropEmptySession(tx, claim.key)
      return rows.length > 0
    })
    if (failed) logFailed(claim.key, reason)
    return 'failed'
  }
  const retryAt = new Date(now.getTime() + retryDelayMs(claim.attempts))
  await deps.sql`
    UPDATE factory.spawns SET status = 'queued', claimed_at = NULL, resume_at = ${retryAt}, error = ${message}
    WHERE key = ${claim.key} AND status = 'starting'`
  return 'retrying'
}

/** Phase 2 and 3 for one claim. Nothing the Runner does can leave this function throwing; only recording can. */
async function execute(deps: TickDeps, claim: Claim): Promise<'started' | 'failed' | 'retrying' | 'lost'> {
  let session: string
  try {
    ;({ session } = await deps.runner.start({
      key: claim.key,
      repo: claim.repo,
      prompt: claim.prompt,
      account: claim.account,
      tier: claim.tier,
      effort: claim.effort,
    }))
  } catch (error) {
    return recordFailure(deps, claim, error)
  }
  return (await recordStarted(deps.sql, claim.key, session, deps.clock.now())) ? 'started' : 'lost'
}

/**
 * One pass: claim what is due and commit, call the Runner outside any transaction (its own process timeout bounds
 * it), record each result separately. Safe to run concurrently with itself: a claimed row is not due to anyone else.
 */
export async function tick(deps: TickDeps): Promise<TickResult> {
  // Facts first: what the hooks spooled while nobody was listening is in the database before anything is decided.
  let replayed = 0
  let replayError: string | undefined
  try {
    replayed = (await deps.spool?.replay())?.lines ?? 0
  } catch (error) {
    replayError = `spool replay: ${error instanceof Error ? error.message : String(error)}`
  }
  // Then the quota, so a spawn is admitted on a reading at most a minute old.
  let quotaError: string | undefined
  try {
    await deps.quota?.pollIfDue()
  } catch (error) {
    quotaError = `quota poll: ${error instanceof Error ? error.message : String(error)}`
  }
  const { claims, failed, skipped } = await claimDue(deps)
  const result: TickResult = { started: [], failed, retrying: [], skipped, errors: [], replayed }
  if (replayError) result.errors.push(replayError)
  if (quotaError) result.errors.push(quotaError)

  await Promise.all(
    claims.map(async (claim) => {
      try {
        const outcome = await execute(deps, claim)
        if (outcome === 'started') result.started.push(claim.key)
        else if (outcome === 'failed') result.failed.push(claim.key)
        else if (outcome === 'retrying') result.retrying.push(claim.key)
        else result.errors.push(`${claim.key}: the claim was lost before the result was recorded`)
      } catch (error) {
        result.errors.push(`${claim.key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }),
  )
  return result
}

export const TICK_INTERVAL_MS = 5_000

/**
 * Ticks once now and then every interval. A pass still running makes the next one skip, and any failure in a pass
 * is logged, never fatal. `stop` waits for the pass in flight, so a shutdown cannot cut a start between the Runner
 * call and its record.
 */
export function startTicker(
  deps: TickDeps,
  intervalMs: number = TICK_INTERVAL_MS,
  monitor?: TickMonitor,
): { stop(): Promise<void> } {
  let inFlight: Promise<void> | undefined
  let stopped = false

  const pass = () => {
    if (stopped || inFlight) return
    monitor?.passStarted()
    inFlight = (async () => {
      try {
        const { started, failed, retrying, errors } = await tick(deps)
        if (started.length || failed.length || retrying.length || errors.length) {
          console.log('tick', { started, failed, retrying, errors })
        }
        if (errors.length) monitor?.noteError(errors.join('; '))
        monitor?.passSucceeded()
      } catch (error) {
        console.error('tick failed', error)
        monitor?.passFailed(error instanceof Error ? error.message : String(error))
      } finally {
        inFlight = undefined
      }
    })()
  }

  pass()
  const timer = setInterval(pass, intervalMs)
  return {
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await inFlight
    },
  }
}
