import type { Session, SessionState, Status } from '@software-factory/contract'
import type { SQL } from 'bun'
import { latestReadings, toQuota } from './capacity.ts'
import { listOpenPrompts } from './prompts.ts'
import { getQueue } from './queue.ts'
import { BLOCKED_AFTER_MS } from './rules.ts'
import { type Fact, loadSessions } from './sessions.ts'
import { listSpawns } from './spawns.ts'

/** Sessions in the order the owner needs them: what is stopped first, what is running last. */
const ORDER: readonly SessionState[] = ['walled', 'blocked', 'stuck', 'working', 'waiting', 'starting', 'idle']

const minutesSince = (since: string | null, now: Date): number =>
  since ? Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 60_000)) : 0

/** What needs a look, one line each. A blocked session shows only once it has waited the two minutes. */
function attention(
  sessions: readonly { view: Session; facts: readonly Fact[] }[],
  notes: Status['notes'],
  spawns: Status['queue']['spawns'],
  now: Date,
): string[] {
  const lines: string[] = []
  for (const { view, facts } of sessions) {
    const age = minutesSince(view.since, now)
    if (view.state === 'blocked' && now.getTime() - Date.parse(view.since ?? '') >= BLOCKED_AFTER_MS) {
      const why = facts.findLast((f) => f.kind === 'prompt_blocked')?.detail
      lines.push(`blocked ${view.id} for ${age} min${why ? `: ${why}` : ''}`)
    }
    if (view.state === 'stuck') lines.push(`stuck ${view.id}: nothing moved for ${age} min`)
    if (view.state === 'walled') {
      lines.push(
        `walled ${view.id} for ${age} min${view.account ? ` on ${view.account}` : ': account unknown, the watchdog cannot act'}`,
      )
    }
  }
  for (const note of notes) {
    if (note.status === 'failed') lines.push(`note ${note.id} to ${note.session} failed: ${note.error ?? 'unknown'}`)
    else if (note.sentCount > 0 && note.error) lines.push(`note ${note.id} to ${note.session}: ${note.error}`)
  }
  for (const spawn of spawns) {
    if (spawn.status === 'failed') lines.push(`spawn ${spawn.key} failed: ${spawn.error ?? 'unknown'}`)
  }
  return lines
}

/** `GET /status`: sessions by derived state, the queue with its hold reasons, accounts with their readings, pending notes. */
export async function buildStatus(sql: SQL, now: Date): Promise<Status> {
  const loaded = (await loadSessions(sql, now)).filter((s) => s.view.state !== 'dead')
  loaded.sort(
    (a, b) =>
      ORDER.indexOf(a.view.state) - ORDER.indexOf(b.view.state) ||
      Date.parse(a.view.since ?? a.view.lastEventAt) - Date.parse(b.view.since ?? b.view.lastEventAt) ||
      a.view.id.localeCompare(b.view.id),
  )
  const notes = await listOpenPrompts(sql, now)
  // What is still waiting to run comes first, then what gave up.
  const spawns = (await listSpawns(sql))
    .filter((s) => s.status !== 'started')
    .sort((a, b) => Number(a.status === 'failed') - Number(b.status === 'failed'))
  return {
    now: now.toISOString(),
    attention: attention(loaded, notes, spawns, now),
    sessions: loaded.map((s) => s.view),
    queue: { effective: (await getQueue(sql, null)).effective, spawns },
    accounts: (await latestReadings(sql)).map((r) => toQuota(r, now)),
    notes,
  }
}
