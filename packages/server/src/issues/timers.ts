import type { SQL } from 'bun'
import { enqueue } from './inbox.ts'
import type { IssueRow } from './read.ts'

/**
 * Turns every passed `wake_at` into its inbox row and clears it, in one transaction, so a timer fires once: `hold_over` for
 * a `watching` Issue, `wake` for a `waiting` one. Each names what it ends, so one that comes late ends nothing else.
 */
export async function fireTimers(sql: SQL, now: Date, batch = 50): Promise<number> {
  return sql.begin(async (tx) => {
    const due: Pick<IssueRow, 'id' | 'state' | 'attempt' | 'hold' | 'waits'>[] = await tx`
      SELECT id, state, attempt, hold, waits FROM factory.issues
      WHERE wake_at <= ${now}
      ORDER BY wake_at, id LIMIT ${batch}
      FOR NO KEY UPDATE SKIP LOCKED`
    for (const issue of due) {
      if (issue.state === 'watching') {
        const key = `hold:${issue.id}:${issue.attempt}:${issue.hold}`
        await enqueue(tx, { issueId: issue.id, key, kind: 'hold_over', at: now, payload: { hold: issue.hold } })
      } else if (issue.state === 'waiting') {
        const key = `wake:${issue.id}:${issue.waits}`
        await enqueue(tx, {
          issueId: issue.id,
          key,
          kind: 'wake',
          at: now,
          payload: { for: 'wait', wait: issue.waits },
        })
      }
      await tx`UPDATE factory.issues SET wake_at = NULL WHERE id = ${issue.id}`
    }
    return due.length
  })
}
