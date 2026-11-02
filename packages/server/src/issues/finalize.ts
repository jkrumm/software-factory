import type { SQL } from 'bun'
import { lockCapacity } from '../capacity.ts'
import type { Clock } from '../clock.ts'
import { releaseClaim } from '../projects/claims.ts'
import type { Runner } from '../runner.ts'
import { dropEmptySession } from '../sessions.ts'
import { archiveAttempt, type TranscriptStore } from './archive.ts'
import { type Effect, type EffectPorts, Waiting } from './effects.ts'
import { leadBranch, leadKey } from './names.ts'
import type { OffTick } from './offtick.ts'
import type { Worktrees } from './worktree.ts'

export interface FinalizeDeps {
  sql: SQL
  clock: Clock
  runner: Pick<Runner, 'close'>
  worktrees: Pick<Worktrees, 'remove'>
  transcripts: TranscriptStore
  /** `FACTORY_ARCHIVE_DIR` */
  archiveDir: string
  /** whether a worktree of the Issue is being made right now: it is removed when that is over */
  making: (issueId: number) => boolean
  offTick: OffTick
}

/**
 * The claim goes back, a lead that never started never will, and whoever waits for the place is looked at now rather than at its next
 * recheck. Under the capacity lock like every admission. Each statement finds its work done on a replay.
 */
async function giveBack({ sql, clock }: FinalizeDeps, issueId: number, attempt: number): Promise<void> {
  const now = clock.now()
  await sql.begin(async (tx) => {
    await lockCapacity(tx)
    const keys = await releaseClaim(tx, issueId)
    const key = leadKey(issueId, attempt)
    const stopped = await tx`
      UPDATE factory.spawns SET status = 'failed', claimed_at = NULL, error = ${`Issue ${issueId} closed before the spawn started`}
      WHERE key = ${key} AND status IN ('queued', 'waiting')
      RETURNING key`
    if (stopped.length > 0) await dropEmptySession(tx, key)
    if (keys.length === 0) return
    await tx`
      UPDATE factory.spawns SET resume_at = ${now}
      WHERE status = 'queued' AND hold = 'claim'
        AND issue_id IN (SELECT issue_id FROM factory.claims WHERE key IN ${tx(keys)} AND held_at IS NULL)`
  })
}

const once = (issueId: number, attempt: number): string => `issue_finalized:${issueId}:${attempt}`

/** A line in the Issue's events, once per key whoever writes it how often. */
async function mark(sql: SQL, issueId: number, key: string, kind: string, at: Date, payload: unknown): Promise<void> {
  await sql`
    INSERT INTO factory.issue_events (issue_id, key, kind, to_state, at, payload)
    VALUES (${issueId}, ${key}, ${kind}, NULL, ${at}, ${payload ?? null})
    ON CONFLICT (key) DO NOTHING`
}

/**
 * What ends an attempt, from every exit path, in this order: the claim given back first, so nothing below can keep the next Issue
 * waiting; the lead's tab closed, so nothing writes after it; its transcripts archived; its worktree removed when clean and on the
 * base, otherwise kept with a line for the owner. `issue_finalized:<issue>:<attempt>` closes it: a second close of an attempt that
 * has it (a reopen that never started a lead) gives the claim back and touches nothing else. Every step finds its own work done, so a
 * crash between any two replays to one of each. Terminal state, and the promotion of the next Issue, are the transition's and admission's.
 */
async function finalize(deps: FinalizeDeps, effect: Effect): Promise<void> {
  const { sql, clock } = deps
  const issueId = effect.issueId
  const attempt = Number(effect.payload?.attempt ?? 0)
  await giveBack(deps, issueId, attempt)

  const [done] = await sql`SELECT 1 FROM factory.issue_events WHERE key = ${once(issueId, attempt)}`
  if (done) return
  if (attempt >= 1) {
    // A worktree in the making comes after this removal otherwise, and stays for good.
    if (deps.making(issueId)) throw new Waiting(`the worktree of Issue ${issueId} is being made`)
    const [issue]: { repo: string }[] = await sql`SELECT repo FROM factory.issues WHERE id = ${issueId}`
    if (!issue) throw new Error(`issue ${issueId} is gone`)
    await deps.runner.close(leadKey(issueId, attempt))
    await archiveAttempt(
      { sql, store: deps.transcripts, dir: deps.archiveDir, now: () => clock.now() },
      issueId,
      attempt,
    )
    const tree = await deps.worktrees.remove({ repo: issue.repo, branch: leadBranch(issueId, attempt) })
    if ('kept' in tree) {
      await mark(sql, issueId, `worktree_kept:${issueId}:${attempt}`, 'worktree_kept', clock.now(), tree)
    }
  }
  await mark(sql, issueId, once(issueId, attempt), 'issue_finalized', clock.now(), { attempt })
}

export function finalizePorts(deps: FinalizeDeps): Pick<EffectPorts, 'finalize'> {
  return { finalize: (effect) => deps.offTick.run(effect.key, () => finalize(deps, effect)) }
}
