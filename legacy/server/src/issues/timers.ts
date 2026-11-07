import type { SQL } from 'bun'
import { enqueue } from './inbox.ts'
import type { IssueRow } from './read.ts'

/**
 * Turns every passed `wake_at` into its inbox row and clears it, in one transaction, so a timer fires once: `hold_over` for
 * a `watching` Issue, `wake` for a `waiting` one. Each names what it ends, so one that comes late ends nothing else.
 */
export async function fireTimers(sql: SQL, now: Date, batch = 50): Promise<number> {
  return sql.begin(async (tx) => {
    const due: Pick<IssueRow, 'id' | 'state' | 'reason' | 'attempt' | 'hold' | 'waits'>[] = await tx`
      SELECT id, state, reason, attempt, hold, waits FROM factory.issues
      WHERE wake_at <= ${now}
      ORDER BY wake_at, id LIMIT ${batch}
      FOR NO KEY UPDATE SKIP LOCKED`
    for (const issue of due) {
      if (issue.state === 'watching') {
        const key = `hold:${issue.id}:${issue.attempt}:${issue.hold}`
        await enqueue(tx, { issueId: issue.id, key, kind: 'hold_over', at: now, payload: { hold: issue.hold } })
      } else if (issue.state === 'waiting' && issue.reason === 'decision') {
        await expireDecision(tx, issue.id, now)
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

/**
 * A question whose expiry passed: with a default, the lead is answered with it (an `answer` from the factory, which wakes the lead
 * and tells it); without, a `lapsed` line for the owner. Keyed by the decision, so a timer that fires twice is one event.
 */
async function expireDecision(tx: SQL, issueId: number, now: Date): Promise<void> {
  // A business question is the owner's: whatever default the lead named, the expiry only tells the owner.
  const [decision]: { id: string; default_option: string | null }[] = await tx`
    SELECT d.id, CASE WHEN i.class = 'business' OR i.classify->>'class' = 'business' THEN NULL ELSE d.default_option END AS default_option
    FROM factory.decisions d JOIN factory.issues i ON i.id = d.issue_id
    WHERE d.issue_id = ${issueId} AND d.answered_at IS NULL AND d.expires_at <= ${now}
    ORDER BY d.id DESC LIMIT 1`
  if (!decision) return
  if (decision.default_option === null) {
    await enqueue(tx, {
      issueId,
      key: `lapse:${issueId}:${decision.id}`,
      kind: 'lapsed',
      at: now,
      payload: { decision: Number(decision.id) },
    })
    return
  }
  await enqueue(tx, {
    issueId,
    key: `answer:${issueId}:expired:${decision.id}`,
    kind: 'answer',
    at: now,
    payload: { answer: decision.default_option, who: 'default', decision: Number(decision.id) },
  })
}
