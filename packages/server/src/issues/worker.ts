import type { SQL } from 'bun'
import { type EffectPorts, runEffects } from './effects.ts'
import { applyEvent, fireTimers, type InboxRow } from './lifecycle.ts'
import type { IssueRow } from './read.ts'

/** Most rows of one Issue in one transaction, and most Issues in one pass: the rest wait for the next. */
const ROWS_PER_ISSUE = 50
const ISSUES_PER_PASS = 20

/**
 * Takes the Issue with the oldest unhandled row, those that failed last, and works through its rows in one transaction, oldest
 * first. The Issue's row
 * is the lock, so one Issue has one worker. `FOR NO KEY UPDATE`, the form of `FOR UPDATE` that leaves foreign keys alone: a
 * session event copied in meanwhile only needs `KEY SHARE` on it, and must not wait for this transaction. `taken` names the
 * Issue before any handler runs, so a throw can be laid at its door. False when no Issue is left to take.
 */
async function takeIssue(
  sql: SQL,
  skip: ReadonlySet<number>,
  now: () => Date,
  taken: { id?: number },
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [locked]: IssueRow[] = await tx`
      SELECT i.* FROM factory.issues i
      JOIN (
        SELECT issue_id, min(id) AS oldest, bool_or(error IS NOT NULL) AS failing
        FROM factory.issue_inbox WHERE handled_at IS NULL GROUP BY issue_id
      ) o ON o.issue_id = i.id
      WHERE i.id NOT IN ${tx([0, ...skip])}
      ORDER BY o.failing, o.oldest
      LIMIT 1
      FOR NO KEY UPDATE OF i SKIP LOCKED`
    if (!locked) return false
    taken.id = locked.id
    const rows: InboxRow[] = await tx`
      SELECT id, issue_id, key, kind, session, at, payload FROM factory.issue_inbox
      WHERE issue_id = ${locked.id} AND handled_at IS NULL
      ORDER BY at, id
      LIMIT ${ROWS_PER_ISSUE}
      FOR UPDATE SKIP LOCKED`
    let issue = locked
    for (const row of rows) {
      const handled = await applyEvent(tx, issue, row, now())
      issue = handled.issue
      await tx`
        UPDATE factory.issue_inbox
        SET handled_at = ${now()}, result = ${handled.result}, detail = ${handled.detail}, error = NULL
        WHERE id = ${row.id}`
    }
    return true
  })
}

/** The oldest open row of an Issue whose handler threw says why, and stays: nothing of the transaction happened. */
async function recordFailure(sql: SQL, issueId: number, message: string): Promise<void> {
  await sql`
    UPDATE factory.issue_inbox SET error = ${message}
    WHERE id = (
      SELECT id FROM factory.issue_inbox WHERE issue_id = ${issueId} AND handled_at IS NULL ORDER BY at, id LIMIT 1)`
}

/** Works the inbox until nothing is left or the pass is full. A handler that throws costs only its own Issue this pass. */
export async function processInbox(sql: SQL, now: () => Date): Promise<string[]> {
  const errors: string[] = []
  const skip = new Set<number>()
  let worked = 0
  // A failure counts against nothing: `skip` ends the loop, and every failed Issue gets its try each pass.
  while (worked < ISSUES_PER_PASS) {
    const taken: { id?: number } = {}
    try {
      if (!(await takeIssue(sql, skip, now, taken))) break
      worked++
    } catch (error) {
      if (taken.id === undefined) throw error
      const message = error instanceof Error ? error.message : String(error)
      skip.add(taken.id)
      errors.push(`issue ${taken.id}: ${message}`)
      await recordFailure(sql, taken.id, message)
    }
  }
  return errors
}

/** One tick's work on Issues: passed timers become inbox rows, the inbox moves Issues, the effects they asked for run. */
export async function issuePass(sql: SQL, input: { now: () => Date; ports: EffectPorts }): Promise<string[]> {
  await fireTimers(sql, input.now())
  const errors = await processInbox(sql, input.now)
  return [...errors, ...(await runEffects(sql, input.ports, input.now))]
}
