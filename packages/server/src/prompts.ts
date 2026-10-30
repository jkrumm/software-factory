import type { Effort, Prompt, PromptStatus, Tier } from '@software-factory/contract'
import type { SQL } from 'bun'
import type { Clock } from './clock.ts'
import { DEFAULT_START_BUDGET_MS, type Runner, UncertainTyping } from './runner.ts'
import { getSession } from './sessions.ts'

/** A typed prompt is proven by the next `turn_started`; none within this long and it is typed once more. */
export const CONFIRM_MS = 60_000
/** The first typing and one retry; after the second the prompt is `failed` and shows in status. */
export const MAX_SENDS = 2
/** A Runner call that failed (herdr down, the agent unreadable) is tried again after this, up to `MAX_FAILURES` times. */
export const FAILURE_RETRY_MS = 30_000
export const MAX_FAILURES = 5
/**
 * A claim older than this is a crashed tick's: the prompt may have been typed, so it counts as sent and is checked. It
 * outlasts the longest Runner call (a start's budget), so a call in flight is never taken for a crashed one.
 */
export const TYPING_LEASE_MS = DEFAULT_START_BUDGET_MS + 60_000
/** A failed prompt stays in `factory status` this long. */
export const FAILED_SHOWN_MS = 24 * 3_600_000
/** Most prompts one tick types; prompts that cannot be typed yet (their session is working) do not count. */
export const DELIVER_BATCH = 10
/**
 * A prompt still `pending` after this has missed its moment (a `continue` for a wall that ended hours ago, a note to a
 * session that never came back) and fails with that reason instead of being typed days later. Rules' prompts are
 * time-sensitive; a note may wait for a long turn to end.
 */
export const PENDING_TTL_MS = { note: 24 * 3_600_000, rule: 6 * 3_600_000 }

interface PromptRow {
  id: string
  session: string
  source: string
  via: 'type' | 'resume'
  text: string
  status: PromptStatus
  created_at: Date
  next_at: Date
  claimed_at: Date | null
  sent_at: Date | null
  sent_count: number
  failures: number
  delivered_at: Date | null
  failed_at: Date | null
  error: string | null
}

export const toPrompt = (r: PromptRow): Prompt => ({
  id: r.id,
  session: r.session,
  source: r.source,
  via: r.via,
  text: r.text,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  sentCount: r.sent_count,
  sentAt: r.sent_at?.toISOString() ?? null,
  deliveredAt: r.delivered_at?.toISOString() ?? null,
  error: r.error,
})

export interface NewPrompt {
  /** the idempotency key: recording the same id again stores nothing and answers with the first */
  id: string
  session: string
  /** `note` for `factory session note`, else the rule that asked */
  source: string
  via?: 'type' | 'resume'
  text: string
  /** `failed` records a prompt that cannot be delivered at all, so it shows in status and is not retried */
  failed?: string
}

/** Records a prompt under its id, before anything is typed. A repeated id returns the stored prompt untouched. */
export async function recordPrompt(
  sql: SQL,
  input: NewPrompt,
  now: Date,
): Promise<{ prompt: Prompt; created: boolean }> {
  const [row]: PromptRow[] = await sql`
    INSERT INTO factory.prompts (id, session, source, via, text, status, created_at, next_at, error, failed_at)
    VALUES (${input.id}, ${input.session}, ${input.source}, ${input.via ?? 'type'}, ${input.text},
            ${input.failed ? 'failed' : 'pending'}, ${now}, ${now}, ${input.failed ?? null},
            ${input.failed ? now : null})
    ON CONFLICT (id) DO NOTHING
    RETURNING *`
  if (row) return { prompt: toPrompt(row), created: true }
  const [existing]: PromptRow[] = await sql`SELECT * FROM factory.prompts WHERE id = ${input.id}`
  if (!existing) throw new Error(`prompt ${input.id} was not stored`)
  return { prompt: toPrompt(existing), created: false }
}

/** What owner and program lead look at: prompts still on their way, and those that gave up in the last day. */
export async function listOpenPrompts(sql: SQL, now: Date): Promise<Prompt[]> {
  const since = new Date(now.getTime() - FAILED_SHOWN_MS)
  const rows: PromptRow[] = await sql`
    SELECT * FROM factory.prompts
    WHERE status IN ('pending', 'typing', 'sent') OR (status = 'failed' AND failed_at > ${since})
    ORDER BY (status = 'failed'), created_at, id LIMIT 100`
  return rows.map(toPrompt)
}

/**
 * The bookkeeping that needs no port: a `typing` claim that outlived its tick counts as sent; a `sent` prompt is
 * `delivered` once the session started a turn after the claim; one with no turn after a minute is typed once more, and
 * after the retry it is `failed` (a line in status, nothing more).
 */
export async function settlePrompts(sql: SQL, now: Date): Promise<void> {
  const leaseEnd = new Date(now.getTime() - TYPING_LEASE_MS)
  await sql`
    UPDATE factory.prompts SET status = 'sent', sent_at = ${now}, sent_count = sent_count + 1
    WHERE status = 'typing' AND claimed_at <= ${leaseEnd}`
  await sql`
    UPDATE factory.prompts p SET status = 'delivered', delivered_at = ${now}, error = NULL
    WHERE p.status = 'sent' AND EXISTS (
      SELECT 1 FROM factory.events e WHERE e.session = p.session AND e.kind = 'turn_started' AND e.at >= p.claimed_at)`
  const stale = new Date(now.getTime() - CONFIRM_MS)
  await sql`
    UPDATE factory.prompts
    SET status = CASE WHEN sent_count < ${MAX_SENDS} THEN 'pending' ELSE 'failed' END, next_at = ${now},
        failed_at = CASE WHEN sent_count < ${MAX_SENDS} THEN NULL ELSE ${now}::timestamptz END,
        error = CASE WHEN sent_count < ${MAX_SENDS} THEN 'no turn started within a minute of typing it: typed again'
                     ELSE 'no turn started within a minute of the retry: not delivered' END
    WHERE status = 'sent' AND sent_at <= ${stale}`
  await sql`
    UPDATE factory.prompts
    SET status = 'failed', failed_at = ${now}, error = 'expired: the session never took it'
    WHERE status = 'pending'
      AND created_at <= CASE WHEN source = 'note' THEN ${new Date(now.getTime() - PENDING_TTL_MS.note)}::timestamptz
                             ELSE ${new Date(now.getTime() - PENDING_TTL_MS.rule)}::timestamptz END`
}

interface Target {
  pane: string | null
  state: string
  claudeSessionId: string | null
  spawn: { key: string; repo: string; account: string | null; tier: Tier; effort: Effort } | null
  ended: boolean
  /** the session shows life after `since`: a hook event, or herdr showing its agent */
  alive(since: Date): Promise<boolean>
}

async function targetOf(sql: SQL, id: string, now: Date): Promise<Target | undefined> {
  const session = await getSession(sql, id, now)
  if (!session) return undefined
  const [spawn] = session.spawn
    ? await sql`SELECT key, repo, account, tier, effort FROM factory.spawns WHERE key = ${session.spawn}`
    : []
  const [life] = await sql`
    SELECT kind FROM factory.events
    WHERE session = ${id} AND kind IN ('session_started', 'session_ended', 'pane_gone') ORDER BY at DESC, id DESC LIMIT 1`
  return {
    pane: session.pane,
    state: session.state,
    claudeSessionId: session.claudeSessionId,
    spawn: spawn ?? null,
    ended: life?.kind === 'session_ended',
    alive: async (since) => {
      const [row] = await sql`
        SELECT (EXISTS (
                  SELECT 1 FROM factory.events
                  WHERE session = ${id} AND at > ${since}
                    AND kind IN ('session_started', 'turn_started', 'turn_ended', 'limit_stop', 'quota_resume'))
                OR (SELECT herdr_seen_at > ${since} FROM factory.sessions WHERE id = ${id})) AS alive`
      return row?.alive === true
    },
  }
}

/** States in which a prompt typed now starts a turn at once: the session is at its prompt, or walled and waiting for a nudge. */
const READY_STATES = new Set(['idle', 'waiting', 'walled'])

export interface DeliverDeps {
  sql: SQL
  runner: Runner
  clock: Clock
}

export interface DeliverResult {
  /** typed this pass */
  sent: string[]
  /** gave up this pass */
  failed: string[]
}

/** One line per prompt that gives up for good, so the reason is in the log whatever else is read. */
const logGaveUp = (id: string, reason: string) => console.error('prompt failed', { id, reason })

async function giveUp(sql: SQL, id: string, reason: string, now: Date): Promise<void> {
  await sql`
    UPDATE factory.prompts SET status = 'failed', failed_at = ${now}, error = ${reason}
    WHERE id = ${id} AND status = 'pending'`
  logGaveUp(id, reason)
}

/**
 * One pass over the prompts: settle what is on its way, then type what is due. A prompt waits while its session is
 * `working` (a prompt typed into a busy session only queues), is typed once the session is at its prompt, and is
 * proven by the next `turn_started`. The claim is committed before the Runner is called and the result is recorded in
 * a statement of its own: no port call sits inside a transaction.
 */
export async function deliverPrompts(deps: DeliverDeps): Promise<DeliverResult> {
  const { sql, clock } = deps
  const result: DeliverResult = { sent: [], failed: [] }
  await settlePrompts(sql, clock.now())

  // Every due prompt is looked at, but only those that reach the Runner count against the batch: ten notes held for one
  // working session must not keep a ready session's prompt waiting.
  const due: PromptRow[] = await sql`
    SELECT * FROM factory.prompts WHERE status = 'pending' AND next_at <= ${clock.now()}
    ORDER BY created_at, id LIMIT 500`
  let attempts = 0
  for (const prompt of due) {
    if (attempts >= DELIVER_BATCH) break
    const target = await targetOf(sql, prompt.session, clock.now())
    const refusal = !target
      ? `unknown session ${prompt.session}`
      : prompt.via === 'resume' && target.ended
        ? 'the session ended; nothing to resume'
        : prompt.via === 'resume' && (await target.alive(prompt.created_at))
          ? 'the session came back by itself; not resumed'
          : undefined
    if (refusal || !target) {
      await giveUp(sql, prompt.id, refusal ?? 'unknown session', clock.now())
      result.failed.push(prompt.id)
      continue
    }
    if (prompt.via === 'type' && !(target.pane && READY_STATES.has(target.state))) continue

    const claimedAt = clock.now()
    const claimed = await sql`
      UPDATE factory.prompts SET status = 'typing', claimed_at = ${claimedAt}
      WHERE id = ${prompt.id} AND status = 'pending' RETURNING id`
    if (claimed.length === 0) continue
    attempts++

    let outcome: 'typed' | 'busy'
    try {
      outcome = await attempt(deps, prompt, target)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof UncertainTyping) {
        // The text may have reached the agent: it is not typed blindly again. The next turn_started proves it, or the
        // minute passes and the one retry decides.
        await sql`
          UPDATE factory.prompts
          SET status = 'sent', sent_at = ${clock.now()}, sent_count = sent_count + 1, error = ${message}
          WHERE id = ${prompt.id} AND status = 'typing'`
        result.sent.push(prompt.id)
        continue
      }
      const spent = prompt.failures + 1 >= MAX_FAILURES
      await sql`
        UPDATE factory.prompts
        SET status = ${spent ? 'failed' : 'pending'}, failed_at = ${spent ? clock.now() : null}, failures = failures + 1,
            error = ${message}, next_at = ${new Date(clock.now().getTime() + FAILURE_RETRY_MS)}
        WHERE id = ${prompt.id} AND status = 'typing'`
      if (spent) {
        logGaveUp(prompt.id, message)
        result.failed.push(prompt.id)
      }
      continue
    }
    if (outcome === 'busy') {
      await sql`UPDATE factory.prompts SET status = 'pending' WHERE id = ${prompt.id} AND status = 'typing'`
      continue
    }
    await sql`
      UPDATE factory.prompts
      SET status = 'sent', sent_at = ${clock.now()}, sent_count = sent_count + 1, failures = 0
      WHERE id = ${prompt.id} AND status = 'typing'`
    result.sent.push(prompt.id)
  }
  return result
}

/** The port call for one prompt: typed into the pane, or the session started again by id with the text as its first prompt. */
async function attempt(deps: DeliverDeps, prompt: PromptRow, target: Target): Promise<'typed' | 'busy'> {
  if (prompt.via === 'type') {
    return deps.runner.type({ pane: target.pane as string, text: prompt.text })
  }
  const { spawn, claudeSessionId } = target
  if (!spawn?.account || !claudeSessionId) {
    throw new Error('cannot resume: the session has no spawn, account or Claude session id')
  }
  const { session: pane } = await deps.runner.start({
    key: spawn.key,
    repo: spawn.repo,
    prompt: prompt.text,
    account: spawn.account,
    tier: spawn.tier,
    effort: spawn.effort,
    resume: claudeSessionId,
  })
  await deps.sql`UPDATE factory.sessions SET pane = ${pane}, pane_misses = 0 WHERE id = ${prompt.session}`
  await deps.sql`UPDATE factory.spawns SET session = ${pane} WHERE key = ${spawn.key}`
  return 'typed'
}
