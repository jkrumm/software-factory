import type { SQL } from 'bun'
import { admitIssues, settleClaims } from './admission.ts'
import type { Classification } from './classify.ts'
import { type EffectPorts, runEffects } from './effects.ts'
import { AskJudgement } from './judge.ts'
import { parkGoneLeads } from './lead.ts'
import type { WorktreeMaker } from './leadtree.ts'
import { applyEvent, supersede } from './lifecycle.ts'
import type { IssueRow } from './read.ts'
import type { InboxRow } from './shared.ts'
import { runSteward, type StewardDeps } from './steward.ts'
import { fireTimers } from './timers.ts'

/** Most rows of one Issue in one transaction, and most Issues in one pass: the rest wait for the next. */
const ROWS_PER_ISSUE = 50
const ISSUES_PER_PASS = 20

/**
 * Takes the Issue with the oldest new row, those with only failed rows last, and works through its rows in one transaction,
 * oldest first and failed rows after the rest. The Issue's row is the lock, so one Issue has one worker. `FOR NO KEY UPDATE`, the
 * form of `FOR UPDATE` that leaves foreign keys alone: a session event copied in meanwhile only needs `KEY SHARE` on it, and must
 * not wait for this transaction. Each row has a savepoint: one that throws is undone alone, keeps its error and stays unhandled,
 * and the rows behind it, an owner's stop among them, still apply; once the Issue has moved past it, it is refused as superseded.
 * Undefined when no Issue is left to take.
 */
async function takeIssue(
  sql: SQL,
  skip: ReadonlySet<number>,
  now: () => Date,
  errors: string[],
  only?: number,
): Promise<{ id: number; failed: boolean } | undefined> {
  return sql.begin(async (tx) => {
    const [locked]: IssueRow[] = await tx`
      SELECT i.* FROM factory.issues i
      JOIN (
        SELECT issue_id, min(id) FILTER (WHERE error IS NULL) AS fresh, min(id) AS oldest
        FROM factory.issue_inbox WHERE handled_at IS NULL GROUP BY issue_id
      ) o ON o.issue_id = i.id
      WHERE i.id NOT IN ${tx([0, ...skip])} AND (${only ?? null}::integer IS NULL OR i.id = ${only ?? null})
      ORDER BY o.fresh NULLS LAST, o.oldest
      LIMIT 1
      FOR NO KEY UPDATE OF i SKIP LOCKED`
    if (!locked) return undefined
    const rows: InboxRow[] = await tx`
      SELECT id, issue_id, key, kind, session, at, payload, failed_revision, error FROM factory.issue_inbox
      WHERE issue_id = ${locked.id} AND handled_at IS NULL
      ORDER BY (error IS NOT NULL), at, id
      LIMIT ${ROWS_PER_ISSUE}
      FOR UPDATE SKIP LOCKED`
    let issue = locked
    let failed = false
    for (const row of rows) {
      try {
        issue = await tx.savepoint(async (point) => {
          // A failed `close` retried after a stop, a reopen and an admission would end the new attempt.
          if (row.failed_revision !== null && row.failed_revision !== issue.revision) {
            const detail = await supersede(point, issue, row, now())
            await point`
              UPDATE factory.issue_inbox SET handled_at = ${now()}, result = 'refused', detail = ${detail}
              WHERE id = ${row.id}`
            return issue
          }
          const handled = await applyEvent(point, issue, row, now())
          await point`
            UPDATE factory.issue_inbox
            SET handled_at = ${now()}, result = ${handled.result}, detail = ${handled.detail}, error = NULL, failed_revision = NULL
            WHERE id = ${row.id}`
          return handled.issue
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failed = true
        errors.push(`issue ${locked.id}: ${row.key}: ${message}`)
        await tx`UPDATE factory.issue_inbox SET error = ${message}, failed_revision = ${issue.revision} WHERE id = ${row.id}`
      }
    }
    return { id: locked.id, failed }
  })
}

/** One take per Issue per pass, until nothing is left or the pass is full; an Issue with a failed row does not count against it. */
export async function processInbox(sql: SQL, now: () => Date): Promise<string[]> {
  const errors: string[] = []
  const skip = new Set<number>()
  let worked = 0
  while (worked < ISSUES_PER_PASS) {
    const taken = await takeIssue(sql, skip, now, errors)
    if (!taken) break
    skip.add(taken.id)
    if (!taken.failed) worked++
  }
  return errors
}

/** How long a caller waits for the worker holding its Issue before it leaves the row to the tick. */
const ANSWER_TRIES = 30
const ANSWER_WAIT_MS = 100

export type Answer = { result: 'applied' | 'refused' | 'ignored'; detail: string | null }

/**
 * Handles an Issue's inbox now, for a call whose answer the caller waits for (`ship`, `close`, `reopen`): the same worker under the same
 * lock as the tick's, so the lifecycle is still what decides. Undefined: the row is not handled yet, a tick has the Issue or it failed.
 */
export async function answerNow(
  sql: SQL,
  input: { issueId: number; key: string; now: () => Date },
): Promise<Answer | undefined> {
  for (let tries = 0; tries < ANSWER_TRIES; tries++) {
    await takeIssue(sql, new Set(), input.now, [], input.issueId)
    const [row]: { result: Answer['result'] | null; detail: string | null; error: string | null }[] =
      await sql`SELECT result, detail, error FROM factory.issue_inbox WHERE key = ${input.key}`
    if (row?.result) return { result: row.result, detail: row.detail }
    if (row?.error) return undefined
    await Bun.sleep(ANSWER_WAIT_MS)
  }
  return undefined
}

/**
 * One tick's work on Issues: Classify is started for the Issues that have none and the leads' worktrees that are due are started (each
 * runs on its own), passed timers become inbox
 * rows, the steward files what a stalled Issue needs (so the inbox handles it in this pass), Issues the claim has room for are admitted, the inbox moves Issues, and the effects they asked for run.
 */
export async function issuePass(
  sql: SQL,
  input: {
    now: () => Date
    ports: EffectPorts
    classification?: Classification
    worktrees?: WorktreeMaker
    alertLeads?: boolean
    /** the steward (`steward.ts`); without it none runs */
    steward?: StewardDeps
    /** judges the open asks and spent escalations (`judge.ts`); without it each is settled in the pass as a failure: the owner hears of it */
    judgement?: AskJudgement
  },
): Promise<string[]> {
  await input.classification?.start()
  await input.worktrees?.start()
  await fireTimers(sql, input.now())
  if (input.steward) await runSteward(sql, input.now(), input.steward)
  await parkGoneLeads(sql, input.now())
  await settleClaims(sql, input.now())
  await admitIssues(sql, { now: input.now(), alertLeads: input.alertLeads ?? false })
  const errors = await processInbox(sql, input.now)
  // After the inbox: an ask or a spent escalation made in this pass is judged (or, with no judge, told to the owner) in it.
  try {
    await (input.judgement ?? new AskJudgement({ sql, now: input.now })).start()
  } catch (error) {
    errors.push(`ask judge: ${error instanceof Error ? error.message : String(error)}`)
  }
  return [...errors, ...(await runEffects(sql, input.ports, input.now))]
}
