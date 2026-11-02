import type { IssueState, IssueVerb, IssueVerbBody } from '@software-factory/contract'
import type { SQL } from 'bun'
import { enqueue } from './inbox.ts'
import { leadKey } from './names.ts'

/** The verbs that count as a report: a lead that stopped after one of them said where the Issue stands. `phase` does not. */
export const REPORT_VERBS: readonly IssueVerb[] = ['ship', 'close', 'block', 'ask', 'wait', 'drop']

export type VerbBody = {
  [V in IssueVerb]: (typeof IssueVerbBody)[V]['_output']
}[IssueVerb]

export type Filed =
  | { ok: true; key: string; duplicate: boolean; state: IssueState }
  | { ok: false; problem: 'unknown_issue' | 'foreign_session' }

/**
 * Files one verb of a lead as an inbox row keyed `<issue>:<attempt>:<verb>:<call id>`: the same call twice is one event. The session, when
 * given, must be one that works this Issue, so a lead reports on its own Issue and no other. The handling (and any refusal, a line
 * in the Issue's events) is the next tick's; Wave 4 puts the evidence check there, where `ship` and `close` are decided.
 */
export async function fileVerb(
  sql: SQL,
  input: { issueId: number; verb: IssueVerb; body: VerbBody; now: Date; requireSession?: boolean },
): Promise<Filed> {
  const { issueId, verb, now } = input
  const { id, session, ...fields } = input.body
  const [issue]: { state: IssueState; attempt: number }[] =
    await sql`SELECT state, attempt FROM factory.issues WHERE id = ${issueId}`
  if (!issue) return { ok: false, problem: 'unknown_issue' }
  // On the socket, which has no token, a caller is a session: one that names itself, and works this Issue.
  if (input.requireSession && session === undefined) return { ok: false, problem: 'foreign_session' }
  // Only the Issue's current lead reports: an earlier attempt's lead, still open, is not heard.
  if (session !== undefined && session !== leadKey(issueId, issue.attempt))
    return { ok: false, problem: 'foreign_session' }
  if (session !== undefined) {
    const [works] = await sql`SELECT 1 FROM factory.sessions WHERE id = ${session} AND issue_id = ${issueId}`
    if (!works) return { ok: false, problem: 'foreign_session' }
  }
  // The attempt is in the key: a second attempt's `--id 1 ship` is its own event, not a duplicate of the first attempt's.
  const key = `${issueId}:${issue.attempt}:${verb}:${id ?? crypto.randomUUID()}`
  // The attempt the call was filed for: a verb that reaches the Issue after a new attempt began is refused, not applied to it.
  const payload = { ...fields, attempt: issue.attempt }
  const { duplicate } = await enqueue(sql, { issueId, key, kind: verb, at: now, payload, session })
  return { ok: true, key, duplicate, state: issue.state }
}
