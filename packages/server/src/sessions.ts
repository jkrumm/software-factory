import type { Effort, Session, SessionState, Tier, WaitOn } from '@software-factory/contract'
import type { SQL } from 'bun'
import { ACCOUNT_NAME, ROLE_NAME } from '@software-factory/contract/spool'
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
    UPDATE factory.sessions s SET spawn_key = p.key, pane = COALESCE(s.pane, p.session), tab = COALESCE(s.tab, p.tab)
    FROM factory.spawns p
    WHERE s.id = ${event.session} AND p.key = s.id AND s.spawn_key IS NULL`
  if (event.kind === 'session_started') {
    const text = (name: string): string | null => {
      const value = event.payload?.[name]
      return typeof value === 'string' && value ? value : null
    }
    // The account keys readings and shows in status: a name from the registry's alphabet, or none.
    const account = text('account')
    const accountName = account && ACCOUNT_NAME.test(account) ? account : null
    // What only the pane knows: its role (`FACTORY_ROLE`, the one-wave-per-repo rule counts it) and where herdr put it.
    const role = text('role')
    const roleName = role && ROLE_NAME.test(role) ? role : null
    // A spawn's pane is the Runner's. A name `rd` reuses in a new pane is the new pane (the bound_at guard keeps older starts out).
    await tx`
      UPDATE factory.sessions
      SET claude_session_id = ${text('claudeSessionId')}, transcript_path = ${text('transcriptPath')},
          cwd = COALESCE(${text('cwd')}, cwd), account = COALESCE(${accountName}, account),
          role = COALESCE(${roleName}, role),
          pane = CASE WHEN spawn_key IS NULL THEN COALESCE(${text('pane')}, pane) ELSE COALESCE(pane, ${text('pane')}) END,
          tab = CASE WHEN spawn_key IS NULL THEN COALESCE(${text('tab')}, tab) ELSE COALESCE(tab, ${text('tab')}) END,
          bound_at = ${event.at}
      WHERE id = ${event.session} AND (bound_at IS NULL OR bound_at <= ${event.at})`
  }
  return { duplicate: false }
}

/**
 * The row of a session the factory is starting: made when the tick claims the spawn (state `starting` until the first
 * hook event), and given its pane when the Runner has one.
 */
export async function openSession(
  tx: SQL,
  input: { id: string; spawnKey: string; pane: string | null; tab?: string | null; at: Date },
): Promise<void> {
  await tx`
    INSERT INTO factory.sessions (id, spawn_key, pane, tab, created_at)
    VALUES (${input.id}, ${input.spawnKey}, ${input.pane}, ${input.tab ?? null}, ${input.at})
    ON CONFLICT (id) DO UPDATE SET spawn_key = EXCLUDED.spawn_key, pane = COALESCE(EXCLUDED.pane, factory.sessions.pane),
      tab = COALESCE(EXCLUDED.tab, factory.sessions.tab)`
}

/** A spawn that gave up never became a session: its row, if it never got a pane or an event, goes. True if it went. */
export async function dropEmptySession(tx: SQL, id: string): Promise<boolean> {
  const rows = await tx`
    DELETE FROM factory.sessions s
    WHERE s.id = ${id} AND s.pane IS NULL AND NOT EXISTS (SELECT 1 FROM factory.events e WHERE e.session = s.id)
    RETURNING s.id`
  return rows.length > 0
}

// --- derived state -----------------------------------------------------------------------------------------------

/** One event as the derivation reads it: `detail` is the wait's `on`, or the `state` of a quota_resume. */
export interface Fact {
  kind: EventKind
  at: Date
  /** the event's key: what a rule that answers one event (a blocked prompt) names its effect after */
  key?: string
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
  /** when the session came to be in this state: the event that put it there */
  since: Date | null
}

/** What only a live session produces: an event of one of these kinds after a moment shows the session was there. */
export const HOOK_KINDS: readonly EventKind[] = [
  'session_started',
  'turn_started',
  'turn_ended',
  'limit_stop',
  'quota_resume',
  'prompt_blocked',
  'prompt_idle',
]

/**
 * A `pane_gone` is withdrawn by anything that proves the session is there: a hook event after it, or herdr showing the
 * agent again after it. The witness uses the same rule to decide whether a pane is still reported gone.
 */
export function paneGoneWithdrawn(input: { goneAt: Date; hookAfter: boolean; herdrSeenAt: Date | null }): boolean {
  return input.hookAfter || (input.herdrSeenAt !== null && input.herdrSeenAt > input.goneAt)
}

const lastIndex = (facts: readonly Fact[], ...kinds: EventKind[]): number =>
  facts.findLastIndex((f) => kinds.includes(f.kind))

/**
 * State is a pure function of the ordered events and, for `stuck`, of what the witness saw; it is never stored.
 * First match wins. `turn` counts every turn started, the state reads from the latest `session_started` on: a resumed session starts
 * clean, whatever the one before it left open.
 *
 * - `dead`: the last of session_started / session_ended / pane_gone is not a start (a resume starts again). A
 *   `pane_gone` is withdrawn by anything that proves the session is there: a later hook event, or herdr showing the
 *   agent again after it.
 * - `starting`: nothing yet proves the session is up (no session_started, no turn).
 * - `walled`: a limit_stop or quota_resume with no turn_started after it. A `quota_resume` that says `fired` means
 *   Claude carried on by itself, so the turn that ends after it also ends the wall.
 * - `blocked`: a prompt_blocked with no turn_started or turn_ended after it (answering the prompt does not start a turn).
 * - `working`: the latest turn_started has no turn_ended after it; `stuck` when herdr agrees and neither the worktree
 *   nor the turn has moved for 45 minutes.
 * - `waiting`: a declared wait is open and no turn is. `--done` ends a wait, and so does a delivered wake (`clearAnsweredWait`).
 * - `idle`: everything else.
 */
export function deriveState(input: DeriveInput): Derived | undefined {
  const { facts, now, herdr } = input
  const turn = facts.filter((f) => f.kind === 'turn_started').length

  const iWait = lastIndex(facts, 'wait_declared', 'wait_cleared')
  const open = iWait >= 0 && facts[iWait]?.kind === 'wait_declared'
  const wait = open ? parseWait(facts[iWait]?.detail) : null

  if (facts.length === 0) return input.known ? { state: 'starting', wait: null, turn, since: null } : undefined

  const iLife = lastIndex(facts, 'session_started', 'session_ended', 'pane_gone')
  const life = facts[iLife]
  if (life && life.kind !== 'session_started') {
    const proven =
      life.kind === 'pane_gone' &&
      paneGoneWithdrawn({
        goneAt: life.at,
        hookAfter: facts.slice(iLife + 1).some((f) => HOOK_KINDS.includes(f.kind)),
        herdrSeenAt: herdr?.status != null ? (herdr.seenAt ?? null) : null,
      })
    if (!proven) return { state: 'dead', wait: null, turn, since: life.at }
  }

  // This life only: from the last session_started on.
  const from = lastIndex(facts, 'session_started') + 1
  const here = facts.slice(from)
  const iStart = lastIndex(here, 'turn_started')
  const iEnd = lastIndex(here, 'turn_ended')
  if (from === 0 && iStart < 0 && iEnd < 0) return { state: 'starting', wait: null, turn, since: null }

  const iWall = lastIndex(here, 'limit_stop', 'quota_resume')
  const wall = here[iWall]
  const carriedOn = wall?.kind === 'quota_resume' && wall.detail === 'fired' && iEnd > iWall
  if (iWall > iStart && !carriedOn) {
    // The wall began with the first limit event after the last turn; the ones that follow (a quota_resume) are news about it.
    const first = here.findIndex((f, i) => i > iStart && (f.kind === 'limit_stop' || f.kind === 'quota_resume'))
    return { state: 'walled', wait, turn, since: here[first]?.at ?? null }
  }

  const iBlocked = lastIndex(here, 'prompt_blocked')
  if (iBlocked > Math.max(iStart, iEnd)) return { state: 'blocked', wait, turn, since: here[iBlocked]?.at ?? null }

  if (iStart > iEnd) {
    const startedAt = here[iStart]?.at.getTime() ?? 0
    const quietSince = Math.max(startedAt, herdr?.worktreeChangedAt?.getTime() ?? 0)
    const herdrAgrees =
      herdr?.status === 'working' && herdr.seenAt !== null && now.getTime() - herdr.seenAt.getTime() <= HERDR_FRESH_MS
    const stuck = herdrAgrees && now.getTime() - quietSince >= STUCK_AFTER_MS
    return { state: stuck ? 'stuck' : 'working', wait, turn, since: here[iStart]?.at ?? null }
  }
  const settled = open ? facts[iWait] : (here[iEnd] ?? facts[lastIndex(facts, 'session_started')])
  return { state: open ? 'waiting' : 'idle', wait, turn, since: settled?.at ?? null }
}

function parseWait(detail: string | null | undefined): WaitOn | null {
  return detail === 'workers' || detail === 'deploy' || detail === 'owner' ? detail : null
}

// --- reading ----------------------------------------------------------------------------------------------------

/** A session joined with what its spawn knows: the role, account, repo and parent of the spawn. */
interface SessionRow {
  id: string
  spawn_key: string | null
  pane: string | null
  claude_session_id: string | null
  transcript_path: string | null
  cwd: string | null
  account: string | null
  created_at: Date
  herdr_status: string | null
  herdr_seen_at: Date | null
  worktree_changed_at: Date | null
  spawn_account: string | null
  /** the role of the spawn; `role` is the one the pane reported */
  spawn_role: string | null
  role: string | null
  tab: string | null
  repo: string | null
  tier: Tier | null
  effort: Effort | null
  parent: string | null
}

interface FactRow {
  session: string
  key: string
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
    tab: row.tab,
    claudeSessionId: row.claude_session_id,
    transcriptPath: row.transcript_path,
    cwd: row.cwd,
    herdrStatus: row.herdr_status,
    herdrSeenAt: row.herdr_seen_at?.toISOString() ?? null,
    role: row.spawn_role ?? row.role,
    account: row.spawn_account ?? row.account,
    parent: row.parent,
    since: derived.since?.toISOString() ?? null,
  }
}

/** Event time first, insertion order second: a replay delivers late. */
function factRows(sql: SQL, ids: readonly string[]): Promise<FactRow[]> {
  if (ids.length === 0) return Promise.resolve([])
  return sql`
    SELECT session, key, kind, at, COALESCE(payload->>'on', payload->>'state', payload->>'message') AS detail
    FROM factory.events WHERE session IN ${sql(ids)} ORDER BY session, at, id`
}

function groupFacts(rows: readonly FactRow[]): Map<string, Fact[]> {
  const bySession = new Map<string, Fact[]>()
  for (const row of rows) {
    const list = bySession.get(row.session) ?? []
    list.push({ kind: row.kind, at: row.at, key: row.key, detail: row.detail })
    bySession.set(row.session, list)
  }
  return bySession
}

/** A session whose last life event is `session_ended` is dead whatever else is known: left out in the query. */
const NOT_ENDED = (sql: SQL) => sql`
  NOT EXISTS (
    SELECT 1 FROM (
      SELECT kind FROM factory.events
      WHERE session = s.id AND kind IN ('session_started', 'session_ended', 'pane_gone')
      ORDER BY at DESC, id DESC LIMIT 1) l
    WHERE l.kind = 'session_ended')`

export async function getSession(sql: SQL, id: string, now: Date): Promise<Session | undefined> {
  const [row]: SessionRow[] = await sql`
    SELECT s.*, p.account AS spawn_account, p.role AS spawn_role, p.repo, p.tier, p.effort, p.parent
    FROM factory.sessions s LEFT JOIN factory.spawns p ON p.key = s.spawn_key WHERE s.id = ${id}`
  if (!row) return undefined
  return view(row, groupFacts(await factRows(sql, [id])).get(id) ?? [], now)
}

/** The most sessions one list answers with: the newest. Dead sessions are history, left out unless `all`. */
export const LIST_LIMIT = 200

export async function listSessions(sql: SQL, now: Date, options: { all?: boolean } = {}): Promise<Session[]> {
  // A session that ended is dead whatever else is known, so it is left out before the limit, not after it.
  const rows: SessionRow[] = options.all
    ? await sql`
        SELECT s.*, p.account AS spawn_account, p.role AS spawn_role, p.repo, p.tier, p.effort, p.parent
        FROM factory.sessions s LEFT JOIN factory.spawns p ON p.key = s.spawn_key
        ORDER BY s.created_at DESC, s.id LIMIT ${LIST_LIMIT}`
    : await sql`
        SELECT s.*, p.account AS spawn_account, p.role AS spawn_role, p.repo, p.tier, p.effort, p.parent
        FROM factory.sessions s LEFT JOIN factory.spawns p ON p.key = s.spawn_key
        WHERE ${NOT_ENDED(sql)}
        ORDER BY s.created_at DESC, s.id LIMIT ${LIST_LIMIT}`
  const facts = groupFacts(
    await factRows(
      sql,
      rows.map((r) => r.id),
    ),
  )
  const sessions = rows.flatMap((row) => view(row, facts.get(row.id) ?? [], now) ?? [])
  return options.all ? sessions : sessions.filter((s) => s.state !== 'dead')
}

/** Finished: idle with a turn ended in this life (a resumed session has not worked yet, whatever it did before). */
export const isFinished = (state: SessionState | undefined, facts: readonly Fact[]): boolean =>
  state === 'idle' &&
  facts.slice(facts.findLastIndex((f) => f.kind === 'session_started') + 1).some((f) => f.kind === 'turn_ended')

/** A session the factory started, that is not dead: what the one-wave-per-repo and pace rules count. */
export interface LiveSession {
  id: string
  repo: string
  role: string
  /** idle after a turn that ended in its current life: a chain wave after it spawned its successor */
  finished: boolean
}

/**
 * The sessions of spawns whose derived state is not `dead`, with the repo and role of the spawn. A session whose last
 * life event is `session_ended` is dead whatever else is known and is left out in the query; the rest are derived.
 */
export async function liveSessions(sql: SQL, now: Date): Promise<LiveSession[]> {
  const rows: SessionRow[] = await sql`
    SELECT s.*, p.account AS spawn_account, p.role AS spawn_role, p.repo, p.tier, p.effort, p.parent
    FROM factory.sessions s LEFT JOIN factory.spawns p ON p.key = s.spawn_key
    WHERE ${NOT_ENDED(sql)}`
  const facts = groupFacts(
    await factRows(
      sql,
      rows.map((r) => r.id),
    ),
  )
  return rows.flatMap((row) => {
    const list = facts.get(row.id) ?? []
    const state = view(row, list, now)?.state
    const finished = isFinished(state, list)
    // A session no spawn describes (`rd`'s) is where its hook said it started, with the role its pane reported.
    const repo = row.repo ?? row.cwd
    const role = row.spawn_role ?? row.role
    return state && state !== 'dead' && repo && role ? [{ id: row.id, repo, role, finished }] : []
  })
}

/** A session with its events and what a rule needs to act on it: what its spawn was, and where it runs. */
export interface Loaded {
  view: Session
  facts: readonly Fact[]
  /** the spawn's repo, tier and effort: what resuming it needs; null for an `rd` session */
  repo: string | null
  tier: Tier | null
  effort: Effort | null
  herdrSeenAt: Date | null
}

/** Derives a set of session rows with their events: the shared tail of the loaders below. */
async function derive(sql: SQL, rows: readonly SessionRow[], now: Date): Promise<Loaded[]> {
  const facts = groupFacts(
    await factRows(
      sql,
      rows.map((r) => r.id),
    ),
  )
  return rows.flatMap((row) => {
    const list = facts.get(row.id) ?? []
    const session = view(row, list, now)
    return session
      ? [
          {
            view: session,
            facts: list,
            repo: row.repo,
            tier: row.tier,
            effort: row.effort,
            herdrSeenAt: row.herdr_seen_at,
          },
        ]
      : []
  })
}

/** The sessions of the spawns `parent` started, not ended: the Stop hook's question, answered without reading the rest. */
export async function loadChildren(sql: SQL, parent: string, now: Date): Promise<Loaded[]> {
  const rows: SessionRow[] = await sql`
    SELECT s.*, p.account AS spawn_account, p.role AS spawn_role, p.repo, p.tier, p.effort, p.parent
    FROM factory.sessions s JOIN factory.spawns p ON p.key = s.spawn_key
    WHERE p.parent = ${parent} AND ${NOT_ENDED(sql)}`
  return derive(sql, rows, now)
}

/** The sessions of the spawns any of `parents` started, ended ones included: the wake rule reads who is done, dead or not. */
export async function loadWorkers(sql: SQL, parents: readonly string[], now: Date): Promise<Loaded[]> {
  if (parents.length === 0) return []
  const rows: SessionRow[] = await sql`
    SELECT s.*, p.account AS spawn_account, p.role AS spawn_role, p.repo, p.tier, p.effort, p.parent
    FROM factory.sessions s JOIN factory.spawns p ON p.key = s.spawn_key
    WHERE p.parent IN ${sql(parents)}`
  return derive(sql, rows, now)
}

/** Sessions with an event this recent are the ones a rule looks at: a wall can outlast a weekend, not a month. */
export const RULES_HORIZON_MS = 7 * 24 * 3_600_000

/**
 * Every session that is not ended and had an event within the horizon, derived (dead ones by a gone pane included: a
 * herdr restart makes those, and they are what the restart rule resumes).
 */
export async function loadSessions(sql: SQL, now: Date): Promise<Loaded[]> {
  const since = new Date(now.getTime() - RULES_HORIZON_MS)
  const rows: SessionRow[] = await sql`
    SELECT s.*, p.account AS spawn_account, p.role AS spawn_role, p.repo, p.tier, p.effort, p.parent
    FROM factory.sessions s LEFT JOIN factory.spawns p ON p.key = s.spawn_key
    WHERE ${NOT_ENDED(sql)}
      AND (s.created_at > ${since} OR EXISTS (SELECT 1 FROM factory.events e WHERE e.session = s.id AND e.at > ${since}))`
  return derive(sql, rows, now)
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

/**
 * A delivered wake ends the wait it answers: `wait_cleared` under the key `<session>:wait_cleared:<prompt id>`, so a replay
 * records nothing. Only while that wait is still the session's latest wait event: a `wait_declared` after it (the woken turn
 * waits again) or a `--done` already there stays as it is. The event is dated 1 ms before the turn that proved the
 * delivery, so a wait the woken turn declares sorts after the clear whatever the event ids say, whenever this runs.
 */
export async function clearAnsweredWait(
  tx: SQL,
  input: { session: string; promptId: string; waitKey: string; provedAt: Date },
): Promise<boolean> {
  const [last] = await tx`
    SELECT key, kind FROM factory.events
    WHERE session = ${input.session} AND kind IN ('wait_declared', 'wait_cleared') ORDER BY at DESC, id DESC LIMIT 1`
  if (last?.kind !== 'wait_declared' || last.key !== input.waitKey) return false
  const { duplicate } = await recordIn(tx, {
    key: `${input.session}:wait_cleared:${input.promptId}`,
    session: input.session,
    kind: 'wait_cleared',
    at: new Date(input.provedAt.getTime() - 1),
  })
  return !duplicate
}
