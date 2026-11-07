import type {
  IssueAnswerBody,
  IssueEvidenceInput,
  IssueNoteBody,
  IssuePrioBody,
  IssueState,
  IssueVerb,
  IssueVerbBody,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import type { Commits } from './commits.ts'
import type { Review } from './review.ts'
import { derive, storeEvidence } from './evidence.ts'
import { enqueue } from './inbox.ts'
import { leadKey } from './names.ts'

/** The verbs that count as a report: a lead that stopped after one of them said where the Issue stands. `phase` does not. */
export const REPORT_VERBS: readonly IssueVerb[] = ['ship', 'close', 'block', 'ask', 'wait', 'drop']

export type VerbBody = {
  [V in IssueVerb]: (typeof IssueVerbBody)[V]['_output']
}[IssueVerb]

type Unheard = { ok: false; problem: 'unknown_issue' | 'foreign_session' }

export type Filed = { ok: true; key: string; duplicate: boolean; state: IssueState } | Unheard

/** The verbs the evidence decides: their commits are derived before the row is filed, and the call waits for its answer. */
export const GATED_VERBS: readonly IssueVerb[] = ['ship', 'close']

/** Whether this caller may report on this Issue. On the socket, which has no token, a caller is a session: one that names itself, and works this Issue. */
async function heard(
  sql: SQL,
  issueId: number,
  attempt: number,
  session: string | undefined,
  requireSession: boolean | undefined,
): Promise<boolean> {
  if (requireSession && session === undefined) return false
  if (session === undefined) return true
  // Only the Issue's current lead reports: an earlier attempt's lead, still open, is not heard.
  if (session !== leadKey(issueId, attempt)) return false
  const [works] = await sql`SELECT 1 FROM factory.sessions WHERE id = ${session} AND issue_id = ${issueId}`
  return works !== undefined
}

/**
 * Files one verb of a lead as an inbox row keyed `<issue>:<attempt>:<verb>:<call id>`: the same call twice is one event, unless a gated
 * verb was refused, when the call counts again (`:retry:<n>`). The session, when
 * given, must be one that works this Issue, so a lead reports on its own Issue and no other. `ship` and `close` carry what `derive` found
 * from their commits, read here and outside any transaction; the handling (and any refusal, a line in the Issue's events) is the lifecycle's.
 */
export async function fileVerb(
  sql: SQL,
  input: {
    issueId: number
    verb: IssueVerb
    body: VerbBody
    now: Date
    requireSession?: boolean
    commits: Commits
    review?: Review
  },
): Promise<Filed> {
  const { issueId, verb, now } = input
  const { id, session, ...fields } = input.body
  const [issue]: { state: IssueState; attempt: number; repo: string }[] =
    await sql`SELECT state, attempt, repo FROM factory.issues WHERE id = ${issueId}`
  if (!issue) return { ok: false, problem: 'unknown_issue' }
  if (!(await heard(sql, issueId, issue.attempt, session, input.requireSession)))
    return { ok: false, problem: 'foreign_session' }
  // The attempt is in the key: a second attempt's `--id 1 ship` is its own event, not a duplicate of the first attempt's.
  const first = `${issueId}:${issue.attempt}:${verb}:${id ?? crypto.randomUUID()}`
  const gated = GATED_VERBS.includes(verb)
  // A repeated call finds its row and the answer it got, and git has nothing to add. But a refusal says how things stood then, a git
  // that failed among them: it does not pin the answer, and the call is derived again as a row of its own.
  const earlier: { key: string; result: string | null }[] = gated
    ? await sql`
        SELECT key, result FROM factory.issue_inbox
        WHERE key = ${first} OR starts_with(key, ${`${first}:retry:`}) ORDER BY id DESC`
    : []
  const [latest] = earlier
  const known = latest !== undefined && latest.result !== 'refused'
  const key = latest ? (known ? latest.key : `${first}:retry:${earlier.length}`) : first
  const reported = 'commits' in fields ? (fields.commits ?? []) : []
  const derived =
    gated && !known
      ? await derive(sql, input.commits, {
          issueId,
          repo: issue.repo,
          attempt: issue.attempt,
          reported,
          merged: verb === 'ship',
          review: input.review,
        })
      : undefined
  // The attempt the call was filed for: a verb that reaches the Issue after a new attempt began is refused, not applied to it.
  const payload = { ...fields, attempt: issue.attempt, ...(derived ? { derived } : {}) }
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

export type Recorded =
  | { ok: true; key: string; duplicate: boolean; at: Date }
  | Unheard
  | { ok: false; problem: 'closed' }

/**
 * One piece of evidence, keyed `evidence:<issue>:<attempt>:<call id>`, by the Issue's lead or the owner. Its time is the server's, which
 * is what freshness is measured by. Not an inbox row: it moves nothing, and `ship` reads it where it is.
 */
export async function fileEvidence(
  sql: SQL,
  input: { issueId: number; body: IssueEvidenceInput; now: Date; requireSession?: boolean },
): Promise<Recorded> {
  const { issueId, body, now } = input
  const [issue]: { state: IssueState; attempt: number }[] =
    await sql`SELECT state, attempt FROM factory.issues WHERE id = ${issueId}`
  if (!issue) return { ok: false, problem: 'unknown_issue' }
  if (!(await heard(sql, issueId, issue.attempt, body.session, input.requireSession)))
    return { ok: false, problem: 'foreign_session' }
  const key = `evidence:${issueId}:${issue.attempt}:${body.id ?? crypto.randomUUID()}`
  const [known]: { at: Date }[] = await sql`SELECT at FROM factory.evidence WHERE key = ${key}`
  if (known) return { ok: true, key, duplicate: true, at: known.at }
  if (issue.state === 'closed') return { ok: false, problem: 'closed' }
  const { duplicate } = await storeEvidence(sql, {
    issueId,
    key,
    attempt: issue.attempt,
    kind: body.kind,
    link: body.link,
    payload: body.text === undefined ? null : { text: body.text },
    at: now,
    author: body.session ?? 'owner',
  })
  return { ok: true, key, duplicate, at: now }
}

/**
 * `factory issue prio`: the owner's order among an Issue's project-mates, one inbox row keyed `<issue>:prio:<call id>`. The lifecycle
 * records it as a `prio` event; admission reads the latest value (none = 0), higher first. Answered as `fileNote` is: a call made
 * before as it was, a closed Issue refused.
 */
export async function filePrio(
  sql: SQL,
  input: { issueId: number; body: IssuePrioBody; now: Date },
): Promise<
  { ok: true; key: string; duplicate: boolean; state: IssueState } | { ok: false; problem: 'unknown_issue' | 'closed' }
> {
  const { issueId, now } = input
  const [issue]: { state: IssueState }[] = await sql`SELECT state FROM factory.issues WHERE id = ${issueId}`
  if (!issue) return { ok: false, problem: 'unknown_issue' }
  const call = input.body.id ?? crypto.randomUUID()
  const key = `${issueId}:prio:${call}`
  const [filedBefore] = await sql`SELECT 1 FROM factory.issue_inbox WHERE key = ${key}`
  if (filedBefore) return { ok: true, key, duplicate: true, state: issue.state }
  if (issue.state === 'closed') return { ok: false, problem: 'closed' }
  const { duplicate } = await enqueue(sql, {
    issueId,
    key,
    kind: 'prio',
    at: now,
    payload: { value: input.body.value, call, who: 'owner' },
  })
  return { ok: true, key, duplicate, state: issue.state }
}

/**
 * `factory issue note`: the owner's text for the Issue's lead, one inbox row keyed `<issue>:note:<call id>`. The lifecycle takes it from
 * there: a lead in its pane is typed it through the session notes of §3 under the prompt id `issue:<issue>:note:<call id>` (`note_lead`),
 * so a repeated id is one note; an Issue with no lead running keeps the row, and the next brief carries it. A call made before is
 * answered as it was, whatever became of the Issue since; a closed Issue takes none (the owner reopens it first).
 */
export async function fileNote(
  sql: SQL,
  input: { issueId: number; body: IssueNoteBody; now: Date },
): Promise<
  { ok: true; key: string; duplicate: boolean; state: IssueState } | { ok: false; problem: 'unknown_issue' | 'closed' }
> {
  const { issueId, now } = input
  const [issue]: { state: IssueState }[] = await sql`SELECT state FROM factory.issues WHERE id = ${issueId}`
  if (!issue) return { ok: false, problem: 'unknown_issue' }
  const call = input.body.id ?? crypto.randomUUID()
  const key = `${issueId}:note:${call}`
  const [filedBefore] = await sql`SELECT 1 FROM factory.issue_inbox WHERE key = ${key}`
  if (filedBefore) return { ok: true, key, duplicate: true, state: issue.state }
  if (issue.state === 'closed') return { ok: false, problem: 'closed' }
  const { duplicate } = await enqueue(sql, {
    issueId,
    key,
    kind: 'note',
    at: now,
    payload: { text: input.body.text, call, who: 'owner', ...(input.body.wake ? { wake: true } : {}) },
  })
  return { ok: true, key, duplicate, state: issue.state }
}
