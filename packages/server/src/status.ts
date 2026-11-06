import type { Session, SessionState, Status } from '@software-factory/contract'
import type { SQL } from 'bun'
import { latestReadings, toQuota } from './capacity.ts'
import { FINISHED_HEALTH_MS, healthLines } from './health.ts'
import { digestFailures } from './fleet/digest.ts'
import { issueAttention } from './issues/attention.ts'
import { statusIssues } from './issues/follow.ts'
import { stewardStatus } from './issues/steward.ts'
import { notificationAttention } from './notify/outbox.ts'
import { listOpenPrompts } from './prompts.ts'
import { getQueue } from './queue.ts'
import { isLeadSession } from './issues/names.ts'
import { BLOCKED_AFTER_MS, LEAD_PROMPT_LINE_MS } from './rules.ts'
import { type Fact, loadSessions } from './sessions.ts'
import { listSpawns } from './spawns.ts'

/** Sessions in the order the owner needs them: what is stopped first, what is running last. */
const ORDER: readonly SessionState[] = ['walled', 'blocked', 'stuck', 'working', 'waiting', 'starting', 'idle']

const minutesSince = (since: string | null, now: Date): number =>
  since ? Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 60_000)) : 0

/** What needs the owner (`asks`) and what needs a look and no decision (`health`), one line each. */
interface Lines {
  asks: string[]
  health: string[]
}

/** Agent text on the owner's terminal: one line, no control characters, cut short (as in `issues/attention.ts`). */
const oneLine = (text: string, max = 160): string => {
  // oxlint-disable-next-line no-control-regex -- exactly what is removed
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/**
 * A blocked session is an ask, and shows only once it has waited the two minutes; stuck, walled, notes and failed spawns are health.
 * An Issue lead's permission prompt is no ask (the steward's cause, nothing is typed for it): after 15 minutes it is one health line.
 */
function attention(
  sessions: readonly { view: Session; facts: readonly Fact[] }[],
  notes: Status['notes'],
  spawns: Status['queue']['spawns'],
  now: Date,
  over: ReadonlySet<string>,
): Lines {
  const lines: Lines = { asks: [], health: [] }
  for (const { view, facts } of sessions) {
    const age = minutesSince(view.since, now)
    const waited = now.getTime() - Date.parse(view.since ?? '')
    if (view.state === 'blocked' && isLeadSession(view.id)) {
      if (waited >= LEAD_PROMPT_LINE_MS) {
        const command = facts.findLast((f) => f.kind === 'prompt_blocked')?.detail
        lines.health.push(
          `${view.id} waits at a permission prompt for ${age} min${command ? `: ${oneLine(command)}` : ''}`,
        )
      }
    } else if (view.state === 'blocked' && waited >= BLOCKED_AFTER_MS) {
      const why = facts.findLast((f) => f.kind === 'prompt_blocked')?.detail
      lines.asks.push(`blocked ${view.id} for ${age} min${why ? `: ${why}` : ''}`)
    }
    if (view.state === 'stuck') lines.health.push(`stuck ${view.id}: nothing moved for ${age} min`)
    if (view.state === 'walled') {
      lines.health.push(
        `walled ${view.id} for ${age} min${view.account ? ` on ${view.account}` : ': account unknown, the watchdog cannot act'}`,
      )
    }
  }
  for (const note of notes) {
    if (note.status === 'failed')
      lines.health.push(`note ${note.id} to ${note.session} failed: ${note.error ?? 'unknown'}`)
    else if (note.sentCount > 0 && note.error) lines.health.push(`note ${note.id} to ${note.session}: ${note.error}`)
  }
  for (const spawn of spawns) {
    if (spawn.status === 'failed' && !over.has(spawn.key))
      lines.health.push(`spawn ${spawn.key} failed: ${spawn.error ?? 'unknown'}`)
  }
  return lines
}

/**
 * Failed spawns that failed over 72 h ago, whose line has ended. A spawn stores no failure time (`claimed_at` is cleared when it
 * fails), so the closest facts stand for it: the newer of `created_at` and `assigned_at`.
 */
async function staleFailedSpawns(sql: SQL, now: Date): Promise<Set<string>> {
  const rows: { key: string }[] = await sql`
    SELECT key FROM factory.spawns
    WHERE status = 'failed' AND GREATEST(created_at, assigned_at) <= ${new Date(now.getTime() - FINISHED_HEALTH_MS)}`
  return new Set(rows.map((r) => r.key))
}

/** The fleet digest's counter: one line when a pass failed in the last day (the model keeps what it had; this says it is not being refreshed). */
async function digestAttention(sql: SQL, now: Date): Promise<string[]> {
  const failed = await digestFailures(sql, now)
  return failed > 0 ? [`digest: ${failed} failed ${failed === 1 ? 'pass' : 'passes'} in the last 24 h`] : []
}

/** `GET /status`: sessions by derived state, the queue with its hold reasons, accounts with their readings, the open Issues, pending notes. */
export async function buildStatus(sql: SQL, now: Date, options: { alertLeads?: boolean } = {}): Promise<Status> {
  const loaded = (await loadSessions(sql, now)).filter((s) => s.view.state !== 'dead')
  loaded.sort(
    (a, b) =>
      ORDER.indexOf(a.view.state) - ORDER.indexOf(b.view.state) ||
      Date.parse(a.view.since ?? a.view.lastEventAt) - Date.parse(b.view.since ?? b.view.lastEventAt) ||
      a.view.id.localeCompare(b.view.id),
  )
  const { prompts: notes, more: notesMore } = await listOpenPrompts(sql, now)
  // What is still waiting to run comes first, then what gave up.
  const spawns = (await listSpawns(sql, now))
    .filter((s) => s.status !== 'started' && s.status !== 'ended' && s.status !== 'cancelled')
    .sort((a, b) => Number(a.status === 'failed') - Number(b.status === 'failed'))
  const issues = await statusIssues(sql, now)
  const own = attention(loaded, notes, spawns, now, await staleFailedSpawns(sql, now))
  const byIssue = await issueAttention(sql, now, { alertLeads: options.alertLeads ?? false })
  return {
    now: now.toISOString(),
    attention: [...own.asks, ...byIssue.asks],
    health: [
      ...own.health,
      ...byIssue.health,
      ...(await healthLines(sql, now)),
      ...(await notificationAttention(sql, now)),
      ...(await digestAttention(sql, now)),
    ],
    sessions: loaded.map((s) => s.view),
    queue: { effective: (await getQueue(sql, null)).effective, spawns },
    accounts: (await latestReadings(sql)).map((r) => toQuota(r, now)),
    issues: issues.issues,
    issuesMore: issues.more,
    notes,
    notesMore,
    steward: await stewardStatus(sql, now),
  }
}
