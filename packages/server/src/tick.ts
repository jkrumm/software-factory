import type { SQL } from 'bun'
import { currentLoads, latestReadings, lockCapacity, nextReset, pickEligible } from './capacity.ts'
import type { Clock } from './clock.ts'
import {
  backoffMs,
  DEFAULT_PROCESS_TIMEOUT_MS,
  DEFAULT_RETRY,
  RunnerError,
  type Runner,
  type RetryPolicy,
  worstCaseMs,
} from './runner.ts'

/** Claims a spawn may take before it is `failed`: a claim that dies mid-flight counts like one that errors. */
export const MAX_ATTEMPTS = 3
/** Delay before a spawn whose start failed is claimed again: base, 2*base, ... up to cap. */
export const RETRY_DELAY: RetryPolicy = { retries: MAX_ATTEMPTS, baseMs: 30_000, capMs: 300_000 }
/** A claim older than this is a crashed tick's: the longest a `HerdrRunner.start` can run, plus a minute. */
export const DEFAULT_LEASE_MS = worstCaseMs(DEFAULT_RETRY, DEFAULT_PROCESS_TIMEOUT_MS) + 60_000
/** Most spawns one tick claims; the rest wait for the next. */
export const DEFAULT_BATCH = 20

export interface TickDeps {
  sql: SQL
  runner: Runner
  clock: Clock
  leaseMs?: number
  batch?: number
}

export interface TickResult {
  started: string[]
  failed: string[]
  /** start failed, will be claimed again after a delay */
  retrying: string[]
  /** due, but no account had capacity: back to waiting */
  skipped: number
  /** the result could not be recorded; the claim stays and is reclaimed when its lease runs out */
  errors: string[]
}

export interface Claim {
  key: string
  repo: string
  prompt: string
  account: string
  attempts: number
}

interface DueRow {
  key: string
  repo: string
  prompt: string
  status: 'queued' | 'waiting' | 'starting'
  account: string | null
  attempts: number
  error: string | null
}

/**
 * Phase 1: in one short transaction, take the spawns that are due and mark them `starting`. The pane is named after
 * the key, so a claim that dies before its result is recorded is found again by name, not started twice.
 * Due means `resume_at` has passed (a queued spawn has none), or a claim whose lease ran out. Waiting spawns sort
 * after queued ones, and a spawn that cannot start leaves the due set, so it never holds up the rest.
 * Capacity is checked again here against the latest readings: a stored account is only a hint.
 */
export async function claimDue(deps: TickDeps): Promise<{ claims: Claim[]; failed: string[]; skipped: number }> {
  const { sql, clock } = deps
  const now = clock.now()
  const staleBefore = new Date(now.getTime() - (deps.leaseMs ?? DEFAULT_LEASE_MS))

  return sql.begin(async (tx) => {
    await lockCapacity(tx)
    const due: DueRow[] = await tx`
      SELECT key, repo, prompt, status, account, attempts, error FROM factory.spawns
      WHERE (status = 'queued' AND (resume_at IS NULL OR resume_at <= ${now}))
         OR (status = 'waiting' AND resume_at <= ${now})
         OR (status = 'starting' AND claimed_at <= ${staleBefore})
      ORDER BY (status = 'waiting'), created_at, key
      LIMIT ${deps.batch ?? DEFAULT_BATCH}
      FOR UPDATE SKIP LOCKED`

    const readings = await latestReadings(tx)
    const claims: Claim[] = []
    const failed: string[] = []
    let skipped = 0

    for (const row of due) {
      if (row.attempts >= MAX_ATTEMPTS) {
        const reason = `gave up after ${row.attempts} attempts${row.error ? `: ${row.error}` : ''}`
        await tx`UPDATE factory.spawns SET status = 'failed', claimed_at = NULL, error = ${reason} WHERE key = ${row.key}`
        failed.push(row.key)
        continue
      }

      // A reclaimed claim may already have its pane; finish it on the account it has instead of asking again.
      const picked =
        row.status === 'starting' && row.account
          ? (readings.find((r) => r.account === row.account) ?? { account: row.account, id: null })
          : pickEligible(readings, await currentLoads(tx, readings, row.key), row.account)
      if (!picked) {
        const resumeAt = nextReset(readings, now) ?? null
        await tx`
          UPDATE factory.spawns
          SET status = 'waiting', account = NULL, reading_id = NULL, claimed_at = NULL, resume_at = ${resumeAt}
          WHERE key = ${row.key}`
        skipped++
        continue
      }
      await tx`
        UPDATE factory.spawns
        SET status = 'starting', account = ${picked.account}, reading_id = COALESCE(${picked.id}, reading_id), claimed_at = ${now},
            resume_at = NULL, attempts = attempts + 1
        WHERE key = ${row.key}`
      claims.push({
        key: row.key,
        repo: row.repo,
        prompt: row.prompt,
        account: picked.account,
        attempts: row.attempts + 1,
      })
    }
    return { claims, failed, skipped }
  })
}

/** Phase 3: record the outcome in a transaction of its own. Only a row still `starting` is touched. */
async function recordStarted(sql: SQL, key: string, session: string): Promise<boolean> {
  const rows = await sql`
    UPDATE factory.spawns SET status = 'started', session = ${session}, claimed_at = NULL, error = NULL
    WHERE key = ${key} AND status = 'starting'
    RETURNING key`
  return rows.length > 0
}

async function recordFailure(deps: TickDeps, claim: Claim, error: unknown): Promise<'failed' | 'retrying'> {
  const message = error instanceof Error ? error.message : String(error)
  const final = (error instanceof RunnerError && error.permanent) || claim.attempts >= MAX_ATTEMPTS
  if (final) {
    await deps.sql`
      UPDATE factory.spawns SET status = 'failed', claimed_at = NULL, error = ${message}
      WHERE key = ${claim.key} AND status = 'starting'`
    return 'failed'
  }
  const retryAt = new Date(deps.clock.now().getTime() + backoffMs(RETRY_DELAY, claim.attempts))
  await deps.sql`
    UPDATE factory.spawns SET status = 'queued', claimed_at = NULL, resume_at = ${retryAt}, error = ${message}
    WHERE key = ${claim.key} AND status = 'starting'`
  return 'retrying'
}

/** Phase 2 and 3 for one claim. Nothing the Runner does can leave this function throwing; only recording can. */
async function execute(deps: TickDeps, claim: Claim): Promise<'started' | 'failed' | 'retrying' | 'lost'> {
  let session: string
  try {
    ;({ session } = await deps.runner.start({ key: claim.key, repo: claim.repo, prompt: claim.prompt }))
  } catch (error) {
    return recordFailure(deps, claim, error)
  }
  return (await recordStarted(deps.sql, claim.key, session)) ? 'started' : 'lost'
}

/**
 * One pass: claim what is due and commit, call the Runner outside any transaction (its own process timeout bounds
 * it), record each result separately. Safe to run concurrently with itself: a claimed row is not due to anyone else.
 */
export async function tick(deps: TickDeps): Promise<TickResult> {
  const { claims, failed, skipped } = await claimDue(deps)
  const result: TickResult = { started: [], failed, retrying: [], skipped, errors: [] }

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
export function startTicker(deps: TickDeps, intervalMs: number = TICK_INTERVAL_MS): { stop(): Promise<void> } {
  let inFlight: Promise<void> | undefined
  let stopped = false

  const pass = () => {
    if (stopped || inFlight) return
    inFlight = (async () => {
      try {
        const { started, failed, retrying, errors } = await tick(deps)
        if (started.length || failed.length || retrying.length || errors.length) {
          console.log('tick', { started, failed, retrying, errors })
        }
      } catch (error) {
        console.error('tick failed', error)
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
