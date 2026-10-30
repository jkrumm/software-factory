import type { StopCheck } from '@software-factory/contract'
import type { SQL } from 'bun'
import { isFresh, latestReadings, type Reading } from './capacity.ts'
import { type NewPrompt, recordPrompt } from './prompts.ts'
import {
  type Fact,
  HERDR_SESSION,
  HOOK_KINDS,
  getSession,
  isFinished,
  type Loaded,
  loadChildren,
  loadSessions,
  loadWorkers,
} from './sessions.ts'

/** The rules that act (`docs/design.md` §3). Each one reads facts and records effects under a deterministic key. */

/** FL2: a walled session whose account's reset has passed, and that has not started a turn for this long, gets a nudge. */
export const RESUME_GRACE_MS = 5 * 60_000
/** ... and only while the reset is this recent: after it a wall is history (a deploy must not wake sessions walled days ago). */
export const RESUME_WINDOW_MS = 6 * 3_600_000
/** A window at this use or more is the one that walled the session. */
const WALL_USE = 95
/** Rotation: a long-lived session's account at this share of its week. One point below admission's 95 %. */
export const ROTATE_AT = 94
/** The roles that live long enough to need a handoff. */
export const ROTATING_ROLES: readonly string[] = ['mother', 'lead']
/** A session that sits on a confirmation this long is reported, and its parent told. */
export const BLOCKED_AFTER_MS = 2 * 60_000
/** A herdr restart is acted on after the witness has had two passes at it and only while it is recent. */
export const RESTART_SETTLE_MS = 3 * 60_000
export const RESTART_WINDOW_MS = 2 * 3_600_000

const iso = (d: Date) => d.toISOString()

/** The sentence a session is given when its turn was cut off by a herdr restart. */
export const RESTART_NOTE =
  'The herdr server restarted while a turn was running, so that turn was cut off. Check where you stopped and carry on.'

/** The current life of a session: its facts from the latest `session_started` on. */
const thisLife = (facts: readonly Fact[]): readonly Fact[] => {
  const from = facts.findLastIndex((f) => f.kind === 'session_started')
  return from < 0 ? facts : facts.slice(from)
}

/** When the wall began and when the latest word about it came (a `quota_resume` after the `limit_stop`). */
function wallOf(facts: readonly Fact[]): { start: Date; last: Date } | undefined {
  const life = thisLife(facts)
  const afterTurn = life.slice(life.findLastIndex((f) => f.kind === 'turn_started') + 1)
  const walls = afterTurn.filter((f) => f.kind === 'limit_stop' || f.kind === 'quota_resume')
  const first = walls[0]
  const last = walls[walls.length - 1]
  return first && last ? { start: first.at, last: last.at } : undefined
}

interface ResetFields {
  five_hour_used: number | null
  weekly_used: number | null
  five_hour_resets_at: Date | null
  weekly_resets_at: Date | null
  exhausted_until: Date | null
}

/** The wall's end as one reading names it: the picker's `exhausted_until`, else the reset of every full window (the later), else the 5-hour window's. */
function resetOf(r: ResetFields, wallStart: Date): Date | undefined {
  const after = (d: Date | null): Date[] => (d && d > wallStart ? [d] : [])
  const full: Date[] = [
    ...(Number(r.five_hour_used ?? 0) >= WALL_USE ? after(r.five_hour_resets_at) : []),
    ...(Number(r.weekly_used ?? 0) >= WALL_USE ? after(r.weekly_resets_at) : []),
  ]
  const candidates = [...after(r.exhausted_until), ...full]
  const picked = candidates.length ? candidates : after(r.five_hour_resets_at)
  return picked.length ? new Date(Math.max(...picked.map((d) => d.getTime()))) : undefined
}

/** How many readings after a wall are looked through for one that names its end. */
const WALL_READINGS = 100

/**
 * The time the wall that stopped a session lifts, from the first reading of its account at or after the wall that names
 * one (`resetOf`): a reading without a usable reset is skipped, not the end of the search. Undefined when none does.
 */
export async function wallReset(sql: SQL, account: string, wallStart: Date): Promise<Date | undefined> {
  const readings: ResetFields[] = await sql`
    SELECT five_hour_used, weekly_used, five_hour_resets_at, weekly_resets_at, exhausted_until
    FROM factory.quota_readings WHERE account = ${account} AND read_at >= ${wallStart} ORDER BY id LIMIT ${WALL_READINGS}`
  for (const reading of readings) {
    const reset = resetOf(reading, wallStart)
    if (reset) return reset
  }
  return undefined
}

type Candidate = NewPrompt

/** Resume watchdog (FL2): `resume:<session>:<reset_at>`, one "continue" per wall. */
async function resumeWatchdog(sql: SQL, sessions: readonly Loaded[], now: Date): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (const { view, facts } of sessions) {
    if (view.state !== 'walled' || !view.account) continue
    const wall = wallOf(facts)
    if (!wall) continue
    const reset = await wallReset(sql, view.account, wall.start)
    // A wall whose end is long past is not this rule's to nudge: whatever stopped the session since, a "continue" now is stale.
    if (!reset || now.getTime() - reset.getTime() > RESUME_WINDOW_MS) continue
    const quietSince = Math.max(reset.getTime(), wall.last.getTime())
    if (now.getTime() < quietSince + RESUME_GRACE_MS) continue
    out.push({ id: `resume:${view.id}:${iso(reset)}`, session: view.id, source: 'resume', text: 'continue' })
  }
  return out
}

/** Rotation: `rotate:<session>:<week>` (the week is named by its reset), one note per session and week. */
function rotation(sessions: readonly Loaded[], readings: readonly Reading[], now: Date): Candidate[] {
  const byAccount = new Map(readings.map((r) => [r.account, r]))
  return sessions.flatMap(({ view }) => {
    if (view.state === 'dead' || !view.role || !ROTATING_ROLES.includes(view.role) || !view.account) return []
    const reading = byAccount.get(view.account)
    if (!reading || !isFresh(reading, now) || !reading.weeklyResetsAt) return []
    if ((reading.weeklyUsed ?? 0) < ROTATE_AT) return []
    return [
      {
        id: `rotate:${view.id}:${iso(reading.weeklyResetsAt)}`,
        session: view.id,
        source: 'rotate',
        text: `Your account is at ${Math.floor(reading.weeklyUsed ?? 0)} % of its week. Write the handoff and rotate.`,
      },
    ]
  })
}

/** Blocked: a note to the parent for each confirmation that has waited 2 minutes, `blocked:<event key>`. */
function blockedParents(sessions: readonly Loaded[], now: Date): Candidate[] {
  const live = new Set(sessions.filter((s) => s.view.state !== 'dead').map((s) => s.view.id))
  return sessions.flatMap(({ view, facts }) => {
    const parent = view.parent
    if (view.state !== 'blocked' || !parent || !live.has(parent) || !view.since) return []
    if (now.getTime() - Date.parse(view.since) < BLOCKED_AFTER_MS) return []
    const event = facts.findLast((f) => f.kind === 'prompt_blocked')
    if (!event?.key) return []
    return [
      {
        id: `blocked:${event.key}`,
        session: parent,
        source: 'blocked',
        // What the worker's prompt says is agent-produced text and stays out of a note that is typed into another agent;
        // `factory status` shows it to the owner.
        text: `${view.id} has waited on a confirmation since ${view.since}. Look at its pane and answer it.`,
      },
    ]
  })
}

/**
 * Wake: `wake:<session>:<wait event key>`, one note per declared wait. A session that is `waiting` on its workers, has
 * at least one child session and no child unfinished is told which are done. Unfinished is a child that is not `dead` and
 * not `idle` after a turn of its life (the `finished` of `liveSessions`), or a spawn of the session's that has not become
 * a session yet (queued, held, waiting for capacity, starting). A spawn that failed will not become one: status shows it.
 */
async function wake(sql: SQL, sessions: readonly Loaded[], now: Date): Promise<Candidate[]> {
  const waiting = sessions.flatMap(({ view, facts }) => {
    const declared = facts.findLast((f) => f.kind === 'wait_declared')
    return view.state === 'waiting' && view.wait === 'workers' && declared ? [{ id: view.id, event: declared.key }] : []
  })
  if (waiting.length === 0) return []
  const ids = waiting.map((w) => w.id)
  const workers = await loadWorkers(sql, ids, now)
  const unstarted: { parent: string }[] = await sql`
    SELECT DISTINCT p.parent FROM factory.spawns p
    WHERE p.parent IN ${sql(ids)}
      AND (p.status IN ('queued', 'waiting', 'starting')
        OR (p.status = 'started' AND NOT EXISTS (SELECT 1 FROM factory.sessions s WHERE s.spawn_key = p.key)))`
  const pending = new Set(unstarted.map((u) => u.parent))
  return waiting.flatMap(({ id, event }) => {
    const children = workers.filter((c) => c.view.parent === id)
    const finished = (c: Loaded) => c.view.state === 'dead' || isFinished(c.view.state, c.facts)
    if (children.length === 0 || pending.has(id) || !children.every(finished)) return []
    const done = children.map((c) => `${c.view.id} ${c.view.state}`).sort()
    return [{ id: `wake:${id}:${event}`, session: id, source: 'wake', text: `workers done: ${done.join(', ')}` }]
  })
}

/** Whether a turn was open at `at`: the latest turn event of this life up to then is a start. */
const openTurnAt = (facts: readonly Fact[], at: Date): boolean => {
  const turns = thisLife(facts).filter((f) => f.at <= at && (f.kind === 'turn_started' || f.kind === 'turn_ended'))
  return turns[turns.length - 1]?.kind === 'turn_started'
}

/**
 * herdr restart: `restart:<server>:<session>`, where the server is the new one's identity (pid and start time). A session
 * that had a turn open when herdr restarted, has said nothing since and that herdr has not shown again is cut off: it is
 * resumed by id with a note. One that cannot be resumed (not started by the factory, no Claude session id) gets a failed
 * prompt, which is the line in status.
 */
async function restarts(sql: SQL, sessions: readonly Loaded[], now: Date): Promise<Candidate[]> {
  const since = new Date(now.getTime() - RESTART_WINDOW_MS)
  const settled = new Date(now.getTime() - RESTART_SETTLE_MS)
  const events: { at: Date; payload: { to?: string } | null }[] = await sql`
    SELECT at, payload FROM factory.events
    WHERE session = ${HERDR_SESSION} AND kind = 'herdr_restarted' AND at > ${since} AND at <= ${settled} ORDER BY at`
  const out: Candidate[] = []
  for (const event of events) {
    const server = event.payload?.to
    if (!server) continue
    for (const { view, facts, herdrSeenAt, repo } of sessions) {
      if (!openTurnAt(facts, event.at)) continue
      if (facts.some((f) => f.at > event.at && HOOK_KINDS.includes(f.kind))) continue
      if (herdrSeenAt && herdrSeenAt > event.at) continue
      const base = { id: `restart:${server}:${view.id}`, session: view.id, source: 'restart', via: 'resume' as const }
      const reason =
        !view.spawn || !repo || !view.account
          ? 'was not started by the factory'
          : !view.claudeSessionId
            ? 'never reported its Claude session id'
            : undefined
      out.push(
        reason
          ? { ...base, text: RESTART_NOTE, failed: `cut off by a herdr restart, cannot be resumed: it ${reason}` }
          : { ...base, text: RESTART_NOTE },
      )
    }
  }
  return out
}

export interface RulesResult {
  /** prompts recorded by this pass: a replay of the same facts records none */
  created: string[]
}

/**
 * Evaluates the rules that type into sessions (watchdog, rotation, blocked, wake, restart) over the facts as they are now and
 * records each effect under its key. Idempotent: the same facts record nothing the second time.
 */
export async function evaluateRules(sql: SQL, now: Date): Promise<RulesResult> {
  const sessions = await loadSessions(sql, now)
  const readings = await latestReadings(sql)
  const candidates = [
    ...(await resumeWatchdog(sql, sessions, now)),
    ...rotation(sessions, readings, now),
    ...blockedParents(sessions, now),
    ...(await wake(sql, sessions, now)),
    ...(await restarts(sql, sessions, now)),
  ]
  const created: string[] = []
  for (const candidate of candidates) {
    const { created: isNew } = await recordPrompt(sql, candidate, now, { rearm: candidate.source !== 'restart' })
    if (isNew) created.push(candidate.id)
  }
  return { created }
}

// --- send-back (FL5) --------------------------------------------------------------------------------------------

/**
 * The `Stop` hook asks: may this session end its turn? Not when it has live child sessions the factory knows (workers it
 * started, as their spawns' parent), no open wait, and the stop is not already a send-back (`stop_hook_active`) or a
 * limit (a walled session has nothing to do about it). Answered once per turn: the effect `sendback:<session>:<turn>` is
 * recorded with the answer, so a second ask in the same turn is let through.
 */
export async function stopCheck(
  sql: SQL,
  id: string,
  input: { stopHookActive: boolean },
  now: Date,
): Promise<StopCheck> {
  const letThrough: StopCheck = { sendBack: false, message: null }
  if (input.stopHookActive) return letThrough
  const session = await getSession(sql, id, now)
  if (!session || session.state === 'walled' || session.state === 'dead' || session.wait !== null) return letThrough

  const children = (await loadChildren(sql, id, now)).filter((c) => c.view.state !== 'dead')
  if (children.length === 0) return letThrough

  const rows = await sql`
    INSERT INTO factory.effects (key, rule, session, at, detail)
    VALUES (${`sendback:${id}:${session.turn}`}, 'sendback', ${id}, ${now}, ${{ workers: children.map((c) => c.view.id) }})
    ON CONFLICT (key) DO NOTHING RETURNING key`
  if (rows.length === 0) return letThrough
  const n = children.length
  return {
    sendBack: true,
    message: `${n} worker${n === 1 ? '' : 's'} still running: wait for ${n === 1 ? 'it' : 'them'} (\`factory session wait --on workers\`) or collect ${n === 1 ? 'it' : 'them'}`,
  }
}
