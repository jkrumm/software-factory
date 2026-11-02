import type { IssueAnswerBody, IssueState, IssueVerb, IssueVerbBody } from '@software-factory/contract'
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

/**
 * The owner's answer, filed as an `answer` inbox row keyed `<issue>:answer:<call id>`: the same call twice is one answer. It is for no
 * attempt in particular (a question outlives the lead that asked it), and it is always the owner's: the route is on the token API
 * only, so a pane cannot reach it. The lifecycle decides whether there is an open question for it (a refusal is a line in the
 * Issue's events).
 */
export async function fileAnswer(
  sql: SQL,
  input: { issueId: number; body: IssueAnswerBody; now: Date },
): Promise<
  | { ok: true; key: string; duplicate: boolean; state: IssueState }
  | { ok: false; problem: 'unknown_issue' | 'no_open_question' }
> {
  const { issueId, now } = input
  const [issue]: { state: IssueState }[] = await sql`SELECT state FROM factory.issues WHERE id = ${issueId}`
  if (!issue) return { ok: false, problem: 'unknown_issue' }
  const { id, answer } = input.body
  const key = `${issueId}:answer:${id ?? crypto.randomUUID()}`
  // A call made before is answered as it was, whatever became of the question since.
  const [filedBefore] = await sql`SELECT 1 FROM factory.issue_inbox WHERE key = ${key}`
  if (filedBefore) return { ok: true, key, duplicate: true, state: issue.state }
  // An answer is for the question open when it was given: one that names none is bound to it now, so a question asked later
  // cannot take it while it waits for the tick. With none open there is nothing to answer.
  const [open]: { id: string }[] = await sql`
    SELECT id FROM factory.decisions WHERE issue_id = ${issueId} AND answered_at IS NULL ORDER BY id DESC LIMIT 1`
  const decision = input.body.decision ?? (open ? Number(open.id) : undefined)
  if (decision === undefined) return { ok: false, problem: 'no_open_question' }
  const payload = { answer, who: 'owner', decision }
  const { duplicate } = await enqueue(sql, { issueId, key, kind: 'answer', at: now, payload })
  return { ok: true, key, duplicate, state: issue.state }
}
