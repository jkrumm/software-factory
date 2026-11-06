import type { Effort, HoldReason, Placement, Spawn, SpawnStatus, Tier } from '@software-factory/contract'
import type { SQL } from 'bun'
import { type AdmissionLimits, admit, HOLD_RECHECK_MS } from './admission.ts'
import { lockCapacity } from './capacity.ts'
import { issueIsClosed, releaseIdleClaim } from './projects/claims.ts'
import { TERMINAL_ADDRESS } from './runner.ts'
import { loadByIds } from './sessions.ts'

export type SpawnView = Spawn

/** A spawn for an Issue that is closed (or gone) has nothing to do: nothing is stored. */
export class IssueClosed extends Error {}

interface SpawnRow {
  key: string
  status: SpawnStatus
  repo: string
  space: string
  role: string
  tier: Tier
  effort: Effort
  hold: HoldReason | null
  account: string | null
  resume_at: Date | null
  attempts: number
  session: string | null
  tab: string | null
  workspace: string | null
  error: string | null
  parent: string | null
  placement: Placement | null
}

export const toView = (row: SpawnRow): SpawnView => ({
  key: row.key,
  status: row.status,
  repo: row.repo,
  space: row.space,
  role: row.role,
  tier: row.tier,
  effort: row.effort,
  hold: row.hold,
  account: row.account,
  resumeAt: row.resume_at?.toISOString() ?? null,
  attempts: row.attempts,
  session: row.session,
  pane: row.session,
  tab: row.tab,
  workspace: row.workspace,
  error: row.error,
  parent: row.parent,
  placement: row.placement,
})

/**
 * A `started` spawn whose agent is gone reads as `ended`; nothing stores it. The agent is gone when its session is `dead`
 * (a pane the witness lost, a session that ended), or when its pane is no terminal of the current core: a classic-herdr
 * pane (`w4V:p3J`) of the time before herdr-core, or none recorded. A spawn that is still `starting` in the session
 * sense (no hook event yet) in a pane of this core is live.
 */
export async function withEnded(sql: SQL, spawns: readonly SpawnView[], now: Date): Promise<SpawnView[]> {
  const started = spawns.filter((s) => s.status === 'started')
  if (started.length === 0) return [...spawns]
  const sessions = new Map(
    (
      await loadByIds(
        sql,
        started.map((s) => s.key),
        now,
      )
    ).map((l) => [l.view.id, l.view]),
  )
  return spawns.map((spawn) => {
    if (spawn.status !== 'started') return spawn
    const session = sessions.get(spawn.key)
    const pane = session?.pane ?? spawn.pane
    const ended = session?.state === 'dead' || pane === null || !TERMINAL_ADDRESS.test(pane)
    return ended ? { ...spawn, status: 'ended' } : spawn
  })
}

export async function getSpawn(sql: SQL, key: string, now: Date): Promise<SpawnView | undefined> {
  const [row]: SpawnRow[] = await sql`
    SELECT key, status, repo, COALESCE(space, repo) AS space, role, tier, effort, hold, account, resume_at, attempts, session, tab, workspace, error, parent, placement FROM factory.spawns WHERE key = ${key}`
  return row && (await withEnded(sql, [toView(row)], now))[0]
}

export async function listSpawns(sql: SQL, now: Date, limit = 200): Promise<SpawnView[]> {
  const rows: SpawnRow[] = await sql`
    SELECT key, status, repo, COALESCE(space, repo) AS space, role, tier, effort, hold, account, resume_at, attempts, session, tab, workspace, error, parent, placement FROM factory.spawns
    ORDER BY created_at DESC, key LIMIT ${limit}`
  return withEnded(sql, rows.map(toView), now)
}

/** A spawn as it is stored: the role has been looked up, so its tier and effort are the table's of that moment. */
export interface NewSpawn {
  key: string
  repo: string
  prompt: string
  role: string
  tier: Tier
  effort: Effort
  /** the session that asked for it */
  parent?: string | null
  /** the path whose space the tab goes into; the repo when absent */
  space?: string
  /** a space of its own, even if the path already has one */
  newSpace?: boolean
  /** the terminal the caller asked for; absent is the role's default */
  placement?: Placement
  /** the Issue this spawn works: it waits on the Issue's claim on the project. A spawn without one takes no claim. */
  issueId?: number
  /** a fork of an archived session (`factory issue resume`) */
  fork?: { session: string; archive: string }
  /** rows that go with a spawn that is made, in its transaction: they are written with it or not at all */
  withSpawn?: (tx: SQL) => Promise<void>
}

/**
 * Stores a spawn, always `queued` or `waiting`, never dropped. Admission decides in the same transaction as the insert,
 * behind the capacity lock: with room it is `queued` on an account and the next tick starts it; held by the queue state
 * or its Issue's claim it is `queued` with its reason and no account; without capacity it is `waiting` with
 * `resume_at` at the first opening (none if no reading names one: a new reading wakes it). A repeated key returns the
 * existing row untouched, `ended` included: the caller refuses a spent key (`key_spent`), a row is never revived.
 */
export async function createSpawn(
  sql: SQL,
  input: NewSpawn,
  now: Date,
  limits: AdmissionLimits = {},
): Promise<{ spawn: SpawnView; created: boolean }> {
  return sql.begin(async (tx) => {
    await lockCapacity(tx)
    const existing = await getSpawn(tx, input.key, now)
    if (existing) return { spawn: existing, created: false }

    if (input.issueId != null && (await issueIsClosed(tx, input.issueId))) {
      throw new IssueClosed(`Issue ${input.issueId} is closed`)
    }
    const decision = await admit(
      tx,
      { key: input.key, repo: input.repo, role: input.role, issueId: input.issueId },
      now,
      undefined,
      limits,
    )
    const status: SpawnStatus = decision.kind === 'wait' ? 'waiting' : 'queued'
    const account = decision.kind === 'start' ? decision.account : null
    const hold = decision.kind === 'hold' ? decision.reason : null
    const resumeAt =
      decision.kind === 'wait'
        ? decision.resumeAt
        : decision.kind === 'hold'
          ? new Date(now.getTime() + HOLD_RECHECK_MS)
          : null

    const [row]: SpawnRow[] = await tx`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, account, assigned_at, hold, resume_at, created_at, parent, space, new_space, placement, issue_id, fork_session, fork_archive)
      VALUES (${input.key}, ${input.repo}, ${input.prompt}, ${input.role}, ${input.tier}, ${input.effort}, ${status},
              ${account}, ${account ? now : null}, ${hold}, ${resumeAt}, ${now}, ${input.parent ?? null}, ${input.space ?? input.repo}, ${input.newSpace ?? false}, ${input.placement ?? null}, ${input.issueId ?? null}, ${input.fork?.session ?? null}, ${input.fork?.archive ?? null})
      RETURNING key, status, repo, COALESCE(space, repo) AS space, role, tier, effort, hold, account, resume_at, attempts, session, tab, workspace, error, parent, placement`
    if (!row) throw new Error(`spawn ${input.key} was not stored`)
    await input.withSpawn?.(tx)
    return { spawn: toView(row), created: true }
  })
}

/**
 * Ends a spawn that was never claimed: `queued` (whatever its hold) or `waiting` becomes `cancelled`, so no agent ever starts for it. Idempotent: a
 * cancelled spawn answers as it is. A `starting`, `started`, `failed` or `ended` one is not cancelled (`claimed`, naming its state): its agent may
 * already run, and closing it is the Runner's and the owner's business. Takes the capacity lock, so a claim in the same moment either wins or loses
 * cleanly.
 */
export async function cancelSpawn(
  sql: SQL,
  key: string,
  now: Date,
): Promise<{ spawn: SpawnView } | { problem: 'unknown' } | { problem: 'claimed'; current: SpawnView }> {
  const row = await sql.begin(async (tx) => {
    await lockCapacity(tx)
    const [issue]: { issue_id: number | null }[] = await tx`
      SELECT issue_id FROM factory.spawns WHERE key = ${key} AND status IN ('queued', 'waiting')`
    if (issue?.issue_id != null) await releaseIdleClaim(tx, issue.issue_id)
    const [cancelled]: SpawnRow[] = await tx`
      UPDATE factory.spawns
      SET status = 'cancelled', hold = NULL, account = NULL, assigned_at = NULL, resume_at = NULL, claimed_at = NULL
      WHERE key = ${key} AND status IN ('queued', 'waiting')
      RETURNING key, status, repo, COALESCE(space, repo) AS space, role, tier, effort, hold, account, resume_at, attempts, session, tab, workspace, error, parent, placement`
    return cancelled
  })
  if (row) return { spawn: toView(row) }
  const current = await getSpawn(sql, key, now)
  if (!current) return { problem: 'unknown' }
  return current.status === 'cancelled' ? { spawn: current } : { problem: 'claimed', current }
}

/**
 * Puts a `failed` spawn back in the queue with a fresh retry budget: the next tick picks an account and starts it.
 * Anything else is left alone (`not_failed`), so a double click or a replay changes nothing.
 */
export async function requeueSpawn(
  sql: SQL,
  key: string,
  now: Date,
): Promise<{ spawn: SpawnView } | { problem: 'unknown' | 'not_failed'; status?: SpawnStatus }> {
  const row = await sql.begin(async (tx) => {
    await lockCapacity(tx)
    // A lead that never ran gives its place back and asks again, behind the Issues that waited meanwhile.
    const [issue]: { issue_id: number | null }[] = await tx`
      SELECT issue_id FROM factory.spawns WHERE key = ${key} AND status = 'failed'`
    if (issue?.issue_id != null) await releaseIdleClaim(tx, issue.issue_id)
    const [requeued]: SpawnRow[] = await tx`
      UPDATE factory.spawns
      SET status = 'queued', attempts = 0, error = NULL, claimed_at = NULL, resume_at = NULL, first_claimed_at = NULL,
          hold = NULL, assigned_at = NULL
      WHERE key = ${key} AND status = 'failed'
      RETURNING key, status, repo, COALESCE(space, repo) AS space, role, tier, effort, hold, account, resume_at, attempts, session, tab, workspace, error, parent, placement`
    return requeued
  })
  if (row) return { spawn: toView(row) }
  const current = await getSpawn(sql, key, now)
  return current ? { problem: 'not_failed', status: current.status } : { problem: 'unknown' }
}
