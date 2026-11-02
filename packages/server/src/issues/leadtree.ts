import type { SQL } from 'bun'
import { leadBranch } from './names.ts'
import type { Worktrees } from './worktree.ts'

/** A failed try is tried again after 30 s, 60 s, ... up to five minutes: the spawn retry's own delays. */
const RETRY_DELAY = { baseMs: 30_000, capMs: 300_000 }
export const worktreeRetryMs = (tries: number): number =>
  Math.min(RETRY_DELAY.capMs, RETRY_DELAY.baseMs * 2 ** Math.max(0, tries - 1))

/** How long a lead's worktree is tried for, counted from the first try, like a spawn's retry budget. */
export const DEFAULT_WORKTREE_BUDGET_MS = 30 * 60_000

export interface WorktreeRow {
  status: 'pending' | 'making' | 'made' | 'failed'
  path: string | null
  tries: number
  error: string | null
}

/**
 * The lead's worktree for an attempt, asked for by `start_lead`: the row is written first (`pending`) and the answer is whatever
 * the maker has done with it. Nothing is made here.
 */
export async function worktreeFor(sql: SQL, issueId: number, attempt: number, now: Date): Promise<WorktreeRow> {
  await sql`
    INSERT INTO factory.lead_worktrees (issue_id, attempt, status, first_at, next_at)
    VALUES (${issueId}, ${attempt}, 'pending', ${now}, ${now})
    ON CONFLICT (issue_id, attempt) DO NOTHING`
  const [row]: WorktreeRow[] = await sql`
    SELECT status, path, tries, error FROM factory.lead_worktrees WHERE issue_id = ${issueId} AND attempt = ${attempt}`
  if (!row) throw new Error(`the worktree row of issue ${issueId} was not stored`)
  return row
}

export interface MakerDeps {
  sql: SQL
  worktrees: Worktrees
  now: () => Date
  retryBudgetMs?: number
  /** most worktrees made at once, one per Issue; the rest wait for a later pass */
  concurrency?: number
}

interface Due {
  issue_id: number
  attempt: number
  repo: string
  tries: number
  first_at: Date
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Makes the lead's worktrees, off the tick: `git fetch` can take 90 s and a repo's `wtp` hooks five minutes, and the tick's health
 * is judged on its passes. The pass starts what is due and returns at once; each one runs on its own, one at a time per Issue, and
 * records its result in a statement of its own. A try that fails backs off and is tried again until the retry budget (counted from
 * the first try) is spent: then the row is `failed` and `start_lead` parks the Issue. A row left `making` by a process that died
 * is no one's in flight, and is tried again at once. Only the Issue's current attempt is made.
 */
export class WorktreeMaker {
  private readonly inflight = new Map<number, Promise<void>>()
  private stopped = false

  constructor(private readonly deps: MakerDeps) {}

  async start(): Promise<void> {
    const room = (this.deps.concurrency ?? 2) - this.inflight.size
    if (room <= 0 || this.stopped) return
    const { sql } = this.deps
    const now = this.deps.now()
    const due: Due[] = await sql`
      SELECT w.issue_id, w.attempt, i.repo, w.tries, w.first_at
      FROM factory.lead_worktrees w JOIN factory.issues i ON i.id = w.issue_id
      WHERE w.status IN ('pending', 'making') AND w.next_at <= ${now} AND i.state <> 'closed'
        AND w.attempt = i.attempt
        AND w.issue_id NOT IN ${sql([0, ...this.inflight.keys()])}
      ORDER BY w.first_at, w.issue_id LIMIT ${room}`
    for (const row of due) {
      // The budget runs from the first try that is started, not from the request: time spent behind busy makers is not a failure.
      const [claimed]: { first_at: Date }[] = await sql`
        UPDATE factory.lead_worktrees
        SET status = 'making', tries = tries + 1, first_at = CASE WHEN tries = 0 THEN ${now} ELSE first_at END
        WHERE issue_id = ${row.issue_id} AND attempt = ${row.attempt}
        RETURNING first_at`
      const running = this.make({ ...row, tries: row.tries + 1, first_at: claimed?.first_at ?? now })
        .catch((error: unknown) => {
          // The result could not be recorded (the database went away): the row stays `making` and is tried again.
          console.error('lead worktree not recorded', { issue: row.issue_id, reason: message(error) })
        })
        .finally(() => this.inflight.delete(row.issue_id))
      this.inflight.set(row.issue_id, running)
    }
  }

  private async make(row: Due): Promise<void> {
    const { sql } = this.deps
    try {
      const made = await this.deps.worktrees.create({ repo: row.repo, branch: leadBranch(row.issue_id, row.attempt) })
      await sql`
        UPDATE factory.lead_worktrees SET status = 'made', path = ${made.path}, base = ${made.base}, sha = ${made.sha}, error = NULL
        WHERE issue_id = ${row.issue_id} AND attempt = ${row.attempt}`
    } catch (error) {
      const now = this.deps.now()
      const spent = now.getTime() - row.first_at.getTime() >= (this.deps.retryBudgetMs ?? DEFAULT_WORKTREE_BUDGET_MS)
      await sql`
        UPDATE factory.lead_worktrees
        SET status = ${spent ? 'failed' : 'pending'}, error = ${message(error)}, next_at = ${new Date(now.getTime() + worktreeRetryMs(row.tries))}
        WHERE issue_id = ${row.issue_id} AND attempt = ${row.attempt}`
    }
  }

  /** Starts nothing more, and waits up to `waitMs` for what is running: a shutdown does not release its lock under a running `git`. */
  async stop(waitMs: number): Promise<void> {
    this.stopped = true
    await Promise.race([Promise.all(this.inflight.values()), Bun.sleep(waitMs)])
  }

  /** Waits for what is running now. The tests use it; the server never waits for a worktree. */
  async settled(): Promise<void> {
    await Promise.all(this.inflight.values())
  }
}
