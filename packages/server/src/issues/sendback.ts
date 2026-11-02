import type { StopCheck } from '@software-factory/contract'
import type { SQL } from 'bun'
import { enqueue } from './inbox.ts'
import { REPORT_VERBS } from './verbs.ts'

const MESSAGE = (issueId: number): string =>
  `Issue ${issueId}: you stopped with nothing reported. Report where it stands with \`factory issue ship|close|block|ask|wait|drop ${issueId} …\`, or keep working. Stopping again unreported parks the Issue for the owner.`

/**
 * Whether the latest turn began with a prompt the factory typed: the brief (the lead's first turn), or a prompt of the prompt loop
 * that the turn proves. A turn the owner started by typing is the owner's, and is never sent back.
 */
async function factoryTurn(sql: SQL, session: string, turnAt: Date): Promise<boolean> {
  const [row] = await sql`
    SELECT (
      (EXISTS (SELECT 1 FROM factory.prompts p WHERE p.session = ${session} AND p.source = 'brief')
        AND NOT EXISTS (SELECT 1 FROM factory.events e WHERE e.session = ${session} AND e.kind = 'turn_started' AND e.at < ${turnAt}))
      OR EXISTS (
        SELECT 1 FROM factory.prompts p
        WHERE p.session = ${session} AND p.source <> 'brief' AND p.claimed_at IS NOT NULL AND p.status IN ('sent', 'delivered')
          AND p.claimed_at <= ${turnAt}
          AND ${turnAt} = (SELECT min(e.at) FROM factory.events e
                           WHERE e.session = ${session} AND e.kind = 'turn_started' AND e.at >= p.claimed_at))
    ) AS yes`
  return row?.yes === true
}

/**
 * A lead's stop (§5, "Following a lead"), on top of the workers rule: the Issue is `working`, the turn is one the factory started,
 * and nothing has been reported since it began (a verb in the Issue's inbox from this session, handled or not, so a report made
 * a moment before the stop counts; a refused one says nothing, so a lead that stops on a refused `ship` hears of it). Sent back once, keyed `issue-sendback:<session>:<turn>`; the next stop of that turn, which
 * arrives with `stopHookActive`, parks the Issue (`unreported`, one inbox row keyed by the turn) with a line for the owner in
 * `factory status`. The same stop asked again (a retried hook: no `stopHookActive`) is let through and records nothing.
 * Undefined: this rule has nothing to say.
 */
export async function issueStop(
  sql: SQL,
  session: { id: string; turn: number },
  input: { stopHookActive: boolean },
  now: Date,
): Promise<StopCheck | undefined> {
  const [lead]: { issue_id: number | null; state: string | null }[] = await sql`
    SELECT s.issue_id, i.state FROM factory.sessions s LEFT JOIN factory.issues i ON i.id = s.issue_id WHERE s.id = ${session.id}`
  if (lead?.issue_id == null || lead.state !== 'working') return undefined
  const issueId = lead.issue_id

  const [turn]: { at: Date }[] = await sql`
    SELECT at FROM factory.events WHERE session = ${session.id} AND kind = 'turn_started' ORDER BY at DESC, id DESC LIMIT 1`
  if (!turn || !(await factoryTurn(sql, session.id, turn.at))) return undefined
  const [reported] = await sql`
    SELECT 1 FROM factory.issue_inbox
    WHERE issue_id = ${issueId} AND session = ${session.id} AND kind IN ${sql([...REPORT_VERBS])} AND at >= ${turn.at}
      AND result IS DISTINCT FROM 'refused'
    LIMIT 1`
  if (reported) return undefined

  const key = `issue-sendback:${session.id}:${session.turn}`
  const sent = await sql`
    INSERT INTO factory.effects (key, rule, session, at, detail)
    VALUES (${key}, 'issue-sendback', ${session.id}, ${now}, ${{ issue: issueId }})
    ON CONFLICT (key) DO NOTHING RETURNING key`
  if (sent.length > 0) return { sendBack: true, message: MESSAGE(issueId) }
  if (!input.stopHookActive) return { sendBack: false, message: null }

  await enqueue(sql, {
    issueId,
    key: `unreported:${issueId}:${session.id}:${session.turn}`,
    kind: 'unreported',
    at: now,
    session: session.id,
    payload: { turn: session.turn },
  })
  return { sendBack: false, message: null }
}
