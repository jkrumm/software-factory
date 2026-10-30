import type { Session, SessionState, WaitOn } from '@software-factory/contract'
import type { SQL } from 'bun'
import type { EVENT_KINDS, EventInput } from './schemas.ts'

export type EventKind = (typeof EVENT_KINDS)[number]
export type { SessionState }

/** The pseudo-session herdr's own events (a restart) are filed under: no real name starts with an underscore. */
export const HERDR_SESSION = '_herdr'

/** A `working` session whose worktree has not changed for this long, while herdr also says `working`, is `stuck`. */
export const STUCK_AFTER_MS = 45 * 60_000
/** What herdr said counts as agreeing only while it is this fresh: the witness reads it every minute. */
export const HERDR_FRESH_MS = 5 * 60_000

/**
 * Stores an event and everything it implies in one transaction: the session's row (created by the first event of a
 * name, linked to the spawn it came from), and for `session_started` the binding of Claude's session id and transcript
 * path. A repeated `key` changes nothing and reports `duplicate: true`.
 */
export async function recordEvent(sql: SQL, event: EventInput): Promise<{ duplicate: boolean }> {
  return sql.begin((tx) => recordIn(tx, event))
}

/** The same inside a transaction the caller owns; a batch of replayed lines shares one. */
export async function recordIn(tx: SQL, event: EventInput): Promise<{ duplicate: boolean }> {
  // The object goes in as is: Bun encodes it as jsonb. A pre-stringified value with `::jsonb` is stored as a JSON string.
  const rows = await tx`
    INSERT INTO factory.events (key, session, kind, at, payload)
    VALUES (${event.key}, ${event.session}, ${event.kind}, ${event.at}, ${event.payload ?? null})
    ON CONFLICT (key) DO NOTHING
    RETURNING id`
  if (rows.length === 0) return { duplicate: true }
  if (event.session === HERDR_SESSION) return { duplicate: false }

  await tx`INSERT INTO factory.sessions (id, created_at) VALUES (${event.session}, ${event.at}) ON CONFLICT (id) DO NOTHING`
  // A session of a spawn is the spawn's: its pane is known from the start.
  await tx`
    UPDATE factory.sessions s SET spawn_key = p.key, pane = COALESCE(s.pane, p.session)
    FROM factory.spawns p
    WHERE s.id = ${event.session} AND p.key = s.id AND s.spawn_key IS NULL`
  if (event.kind === 'session_started') {
    const text = (name: string): string | null => {
      const value = event.payload?.[name]
      return typeof value === 'string' && value ? value : null
    }
    await tx`
      UPDATE factory.sessions
      SET claude_session_id = ${text('claudeSessionId')}, transcript_path = ${text('transcriptPath')},
          cwd = COALESCE(${text('cwd')}, cwd), bound_at = ${event.at}
      WHERE id = ${event.session} AND (bound_at IS NULL OR bound_at <= ${event.at})`
  }
  return { duplicate: false }
}

/** The row of a session the factory started, made as soon as the Runner has its pane. */
export async function openSession(
  tx: SQL,
  input: { id: string; spawnKey: string; pane: string; at: Date },
): Promise<void> {
  await tx`
    INSERT INTO factory.sessions (id, spawn_key, pane, created_at)
    VALUES (${input.id}, ${input.spawnKey}, ${input.pane}, ${input.at})
    ON CONFLICT (id) DO UPDATE SET spawn_key = EXCLUDED.spawn_key, pane = EXCLUDED.pane`
}

// --- derived state -----------------------------------------------------------------------------------------------

/** One event as the derivation reads it: `detail` is the wait's `on`, or the `state` of a quota_resume. */
export interface Fact {
  kind: EventKind
  at: Date
  detail?: string | null
}

export interface Witnessed {
  /** herdr's status for the agent: `working`, `idle`, `blocked`, ... */
  status: string | null
  seenAt: Date | null
  worktreeChangedAt: Date | null
}

export interface DeriveInput {
  /** ordered by event time, then arrival: a replay delivers late */
  facts: readonly Fact[]
  /** the factory has a row for the session */
  known: boolean
  now: Date
  herdr?: Witnessed
}

export interface Derived {
  state: SessionState
  wait: WaitOn | null
  turn: number
}

const lastIndex = (facts: readonly Fact[], ...kinds: EventKind[]): number =>
  facts.findLastIndex((f) => kinds.includes(f.kind))

/**
 * State is a pure function of the ordered events and, for `stuck`, of what the witness saw; it is never stored.
 * First match wins:
 *
 * - `dead`: the last of session_started / session_ended / pane_gone is not a start (a resume starts again).
 * - `starting`: nothing yet proves the session is up (no session_started, no turn).
 * - `walled`: a limit_stop or quota_resume with no turn_started after it. A `quota_resume` that says `fired` means
 *   Claude carried on by itself, so the turn that ends after it also ends the wall.
 * - `blocked`: a prompt_blocked with no turn_started or turn_ended after it (answering the prompt does not start a turn).
 * - `working`: the latest turn_started has no turn_ended after it; `stuck` when herdr agrees and neither the worktree
 *   nor the turn has moved for 45 minutes.
 * - `waiting`: a declared wait is open and no turn is.
 * - `idle`: everything else.
 */
export function deriveState(input: DeriveInput): Derived | undefined {
  const { facts, now } = input
  const turn = facts.filter((f) => f.kind === 'turn_started').length
  const iStart = lastIndex(facts, 'turn_started')
  const iEnd = lastIndex(facts, 'turn_ended')

  const iWait = lastIndex(facts, 'wait_declared', 'wait_cleared')
  const open = iWait >= 0 && facts[iWait]?.kind === 'wait_declared'
  const wait = open ? parseWait(facts[iWait]?.detail) : null

  if (facts.length === 0) return input.known ? { state: 'starting', wait: null, turn } : undefined

  const iLife = lastIndex(facts, 'session_started', 'session_ended', 'pane_gone')
  if (iLife >= 0 && facts[iLife]?.kind !== 'session_started') return { state: 'dead', wait: null, turn }
  if (iLife < 0 && iStart < 0 && iEnd < 0) return { state: 'starting', wait: null, turn }

  const iWall = lastIndex(facts, 'limit_stop', 'quota_resume')
  const wall = facts[iWall]
  const carriedOn = wall?.kind === 'quota_resume' && wall.detail === 'fired' && iEnd > iWall
  if (iWall > iStart && !carriedOn) return { state: 'walled', wait, turn }

  if (lastIndex(facts, 'prompt_blocked') > Math.max(iStart, iEnd)) return { state: 'blocked', wait, turn }

  if (iStart > iEnd) {
    const { herdr } = input
    const startedAt = facts[iStart]?.at.getTime() ?? 0
    const quietSince = Math.max(startedAt, herdr?.worktreeChangedAt?.getTime() ?? 0)
    const herdrAgrees =
      herdr?.status === 'working' && herdr.seenAt !== null && now.getTime() - herdr.seenAt.getTime() <= HERDR_FRESH_MS
    const stuck = herdrAgrees && now.getTime() - quietSince >= STUCK_AFTER_MS
    return { state: stuck ? 'stuck' : 'working', wait, turn }
  }
  return { state: open ? 'waiting' : 'idle', wait, turn }
}

function parseWait(detail: string | null | undefined): WaitOn | null {
  return detail === 'workers' || detail === 'deploy' || detail === 'owner' ? detail : null
}

// --- reading ----------------------------------------------------------------------------------------------------

interface SessionRow {
  id: string
  spawn_key: string | null
  pane: string | null
  claude_session_id: string | null
  transcript_path: string | null
  cwd: string | null
  created_at: Date
  herdr_status: string | null
  herdr_seen_at: Date | null
  worktree_changed_at: Date | null
}

interface FactRow {
  session: string
  kind: EventKind
  at: Date
  detail: string | null
}

function view(row: SessionRow, facts: readonly Fact[], now: Date): Session | undefined {
  const derived = deriveState({
    facts,
    known: true,
    now,
    herdr: { status: row.herdr_status, seenAt: row.herdr_seen_at, worktreeChangedAt: row.worktree_changed_at },
  })
  if (!derived) return undefined
  return {
    id: row.id,
    state: derived.state,
    wait: derived.wait,
    turn: derived.turn,
    lastEventAt: (facts[facts.length - 1]?.at ?? row.created_at).toISOString(),
    spawn: row.spawn_key,
    pane: row.pane,
    claudeSessionId: row.claude_session_id,
    transcriptPath: row.transcript_path,
    cwd: row.cwd,
    herdrStatus: row.herdr_status,
    herdrSeenAt: row.herdr_seen_at?.toISOString() ?? null,
  }
}

/** Event time first, insertion order second: a replay delivers late. */
function factRows(sql: SQL, id?: string): Promise<FactRow[]> {
  return id === undefined
    ? sql`
        SELECT session, kind, at, COALESCE(payload->>'on', payload->>'state') AS detail
        FROM factory.events WHERE session <> ${HERDR_SESSION} ORDER BY session, at, id`
    : sql`
        SELECT session, kind, at, COALESCE(payload->>'on', payload->>'state') AS detail
        FROM factory.events WHERE session = ${id} ORDER BY at, id`
}

function groupFacts(rows: readonly FactRow[]): Map<string, Fact[]> {
  const bySession = new Map<string, Fact[]>()
  for (const row of rows) {
    const list = bySession.get(row.session) ?? []
    list.push({ kind: row.kind, at: row.at, detail: row.detail })
    bySession.set(row.session, list)
  }
  return bySession
}

export async function getSession(sql: SQL, id: string, now: Date): Promise<Session | undefined> {
  const [row]: SessionRow[] = await sql`SELECT * FROM factory.sessions WHERE id = ${id}`
  if (!row) return undefined
  return view(row, groupFacts(await factRows(sql, id)).get(id) ?? [], now)
}

/** Newest first. Dead sessions are history: left out unless `all`. */
export async function listSessions(sql: SQL, now: Date, options: { all?: boolean } = {}): Promise<Session[]> {
  const rows: SessionRow[] = await sql`SELECT * FROM factory.sessions ORDER BY created_at DESC, id`
  const facts = groupFacts(await factRows(sql))
  const sessions = rows.flatMap((row) => view(row, facts.get(row.id) ?? [], now) ?? [])
  return options.all ? sessions : sessions.filter((s) => s.state !== 'dead')
}

/**
 * `factory session wait --on …` and `--done`: a fact like any other, with a key of its own (the call is made once, by
 * the session, not replayed from a spool). Undefined when no such session exists.
 */
export async function declareWait(
  sql: SQL,
  id: string,
  wait: { on: WaitOn } | { done: true },
  at: Date,
): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM factory.sessions WHERE id = ${id}`
  if (!row) return false
  const kind = 'on' in wait ? 'wait_declared' : 'wait_cleared'
  await recordEvent(sql, {
    key: `${id}:${kind}:${crypto.randomUUID()}`,
    session: id,
    kind,
    at,
    payload: 'on' in wait ? { on: wait.on } : undefined,
  })
  return true
}
