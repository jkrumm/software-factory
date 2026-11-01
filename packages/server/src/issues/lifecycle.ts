import type { Issue, IssueOutcome, IssueState, WaitReason } from '@software-factory/contract'
import type { SQL } from 'bun'
import { RepoRefused, resolveRepo } from '../repos.ts'
import type { EffectKind } from './effects.ts'
import { enqueue } from './inbox.ts'
import { findIssue, type IssueRow, toIssue } from './read.ts'

/** The hold after `ship`, until a manifest says otherwise (Wave 4). */
export const DEFAULT_HOLD_MS = 30 * 60_000
/** `closed → queued` is for the same fault within this long. */
export const REOPEN_WINDOW_MS = 30 * 24 * 60 * 60_000

/** A create the policy refuses; the message is the 422 body. */
export class IssueRefused extends RepoRefused {}

export interface InboxRow {
  id: string
  issue_id: number
  key: string
  kind: string
  session: string | null
  at: Date
  payload: Record<string, unknown> | null
}

type Context = { tx: SQL; issue: IssueRow; row: InboxRow; now: Date }

interface Step {
  /** the state it moves to; absent, the event is recorded and the state stays */
  to?: IssueState
  /** why it waits, when `to` is `waiting` */
  reason?: WaitReason
  /** how it ended, when `to` is `closed` */
  outcome?: IssueOutcome
  /** applies only to an Issue waiting for this reason */
  only?: WaitReason
  /** a new lead: the next attempt */
  newAttempt?: true
  /** starts the hold */
  hold?: true
  effects?: EffectKind[]
  /** a refusal the table cannot express */
  refuse?: (context: Context) => string | undefined
  /** the rows that go with the event, in its transaction; a string refuses it */
  apply?: (context: Context) => Promise<string | undefined>
}

const text = (payload: InboxRow['payload'], name: string): string | null => {
  const value = payload?.[name]
  return typeof value === 'string' && value ? value : null
}

async function recordDecision({ tx, issue, row, now }: Context): Promise<string | undefined> {
  const question = text(row.payload, 'question')
  if (!question) return 'an ask needs a question'
  const options = Array.isArray(row.payload?.options) ? JSON.stringify(row.payload.options) : null
  const expires = text(row.payload, 'expiresAt')
  await tx`
    INSERT INTO factory.decisions (issue_id, key, question, options, default_option, expires_at, created_at)
    VALUES (${issue.id}, ${row.key}, ${question}, ${options}::text::jsonb, ${text(row.payload, 'default')}, ${expires}, ${now})
    ON CONFLICT (key) DO NOTHING`
  return undefined
}

async function answerDecision({ tx, issue, row, now }: Context): Promise<string | undefined> {
  const answer = text(row.payload, 'answer')
  if (!answer) return 'an answer needs its text'
  await tx`
    UPDATE factory.decisions SET answer = ${answer}, answered_by = ${text(row.payload, 'who') ?? 'owner'}, answered_at = ${now}
    WHERE issue_id = ${issue.id} AND answered_at IS NULL`
  return undefined
}

async function addDependency({ tx, issue, row }: Context): Promise<string | undefined> {
  const on = row.payload?.on
  if (typeof on !== 'number' || on === issue.id) return 'a dep needs another Issue in `on`'
  const stored = await tx`
    INSERT INTO factory.issue_deps (issue_id, on_issue)
    SELECT ${issue.id}, id FROM factory.issues WHERE id = ${on}
    ON CONFLICT DO NOTHING
    RETURNING on_issue`
  const [known] = stored.length ? stored : await tx`SELECT 1 FROM factory.issues WHERE id = ${on}`
  return known ? undefined : `no Issue ${on}`
}

const stopped: Step = { to: 'closed', outcome: 'dropped' }
const recorded: Step = {}
const noted: Step = { effects: ['note_lead'] }

/**
 * §4's transition table, by event and state, and the only thing that decides `issues.state`. An event a state has no entry for
 * changes nothing: a session event is ignored, anything else refused with a line in the Issue's events. Every `to` here is
 * an edge of §4's diagram, and no entry leads to `settling`: an Issue begins there only by F3's incident path, never a request.
 */
export const TABLE: Record<string, Partial<Record<IssueState, Step>>> = {
  // the admission tick
  admitted: { queued: { to: 'working', newAttempt: true, effects: ['start_lead'] } },
  // the lead
  phase: { working: recorded },
  wait: { working: { to: 'waiting', reason: 'wait' } },
  block: { working: { to: 'waiting', reason: 'blocked' } },
  ask: { working: { to: 'waiting', reason: 'decision', apply: recordDecision } },
  ship: { working: { to: 'watching', hold: true } },
  close: { working: { to: 'closed', outcome: 'done' } },
  drop: { working: { to: 'closed', outcome: 'dropped' } },
  // session events
  limit_stop: { working: { to: 'waiting', reason: 'wall' } },
  turn_started: { waiting: { to: 'working', only: 'wall' } },
  // dedup: a repeat is recorded; `regression` is a signal whose payload says so
  signal: {
    settling: recorded,
    queued: recorded,
    working: recorded,
    waiting: recorded,
    watching: recorded,
    closed: recorded,
  },
  regression: { watching: { to: 'working', effects: ['note_lead'] } },
  // the tick and the proof after the hold
  hold_over: { watching: { effects: ['verify'] } },
  verified: { watching: { to: 'closed', outcome: 'done' } },
  wake: { waiting: { to: 'working', effects: ['note_lead'] } },
  // the owner or the orchestrator
  note: { queued: recorded, working: noted, waiting: noted, watching: noted },
  answer: { waiting: { to: 'working', only: 'decision', effects: ['note_lead'], apply: answerDecision } },
  park: { working: { to: 'waiting', reason: 'parked' } },
  stop: { settling: stopped, queued: stopped, working: stopped, waiting: stopped, watching: stopped },
  prio: { queued: recorded, working: recorded, waiting: recorded, watching: recorded },
  retier: { queued: recorded, working: recorded, waiting: recorded, watching: recorded },
  dep: {
    queued: { apply: addDependency },
    working: { to: 'waiting', reason: 'dependency', apply: addDependency },
    waiting: { apply: addDependency },
  },
  reopen: {
    closed: {
      to: 'queued',
      refuse: ({ issue, now }) =>
        issue.closed_at && now.getTime() - issue.closed_at.getTime() > REOPEN_WINDOW_MS
          ? 'closed more than 30 days ago: file a new Issue'
          : undefined,
    },
  },
  // F3's settle
  healed: { settling: { to: 'closed', outcome: 'healed' } },
  settled: { settling: { to: 'queued' } },
}

/** The events a session produces all the time: one with no entry says nothing about the Issue. */
const SILENT = new Set([
  'session_started',
  'turn_started',
  'turn_ended',
  'limit_stop',
  'quota_resume',
  'prompt_blocked',
  'prompt_idle',
  'session_ended',
  'wait_declared',
  'wait_cleared',
  'pane_gone',
])

/** A closed Issue lets go of the Issues waiting on it: each is woken once nothing it depends on is open. */
async function wakeDependents(tx: SQL, issueId: number, now: Date): Promise<void> {
  const freed: { id: number }[] = await tx`
    SELECT i.id FROM factory.issue_deps d
    JOIN factory.issues i ON i.id = d.issue_id
    WHERE d.on_issue = ${issueId} AND i.state = 'waiting' AND i.reason = 'dependency'
      AND NOT EXISTS (
        SELECT 1 FROM factory.issue_deps o JOIN factory.issues b ON b.id = o.on_issue
        WHERE o.issue_id = i.id AND b.state <> 'closed')`
  for (const { id } of freed) {
    await enqueue(tx, { issueId: id, key: `wake:${id}:dep:${issueId}`, kind: 'wake', at: now })
  }
}

async function logEvent(
  tx: SQL,
  input: { issueId: number; key: string; kind: string; from: IssueState | null; to: IssueState | null; at: Date },
  payload: Record<string, unknown> | null,
): Promise<void> {
  await tx`
    INSERT INTO factory.issue_events (issue_id, key, kind, from_state, to_state, at, payload)
    VALUES (${input.issueId}, ${input.key}, ${input.kind}, ${input.from}, ${input.to}, ${input.at}, ${payload})
    ON CONFLICT (key) DO NOTHING`
}

/** The one statement that moves an Issue. `step.to` comes from the table, so an edge the table lacks cannot be written. */
async function move(tx: SQL, issue: IssueRow, step: Step, cause: InboxRow, now: Date): Promise<IssueRow> {
  const to = step.to ?? issue.state
  const attempt = step.newAttempt ? issue.attempt + 1 : issue.attempt
  const until = step.reason === 'wait' ? text(cause.payload, 'until') : null
  const wakeAt = step.hold ? new Date(now.getTime() + DEFAULT_HOLD_MS) : until ? new Date(until) : null
  const [row]: IssueRow[] = await tx`
    UPDATE factory.issues
    SET state = ${to}, reason = ${step.reason ?? null}, outcome = ${step.outcome ?? null}, attempt = ${attempt},
        wake_at = ${wakeAt}, updated_at = ${now}, closed_at = ${to === 'closed' ? now : null}
    WHERE id = ${issue.id}
    RETURNING *`
  if (!row) throw new Error(`issue ${issue.id} is gone`)
  return row
}

async function planEffect(tx: SQL, issue: IssueRow, kind: EffectKind, row: InboxRow, now: Date): Promise<void> {
  const payload = { ...row.payload, attempt: issue.attempt, cause: row.kind }
  await tx`
    INSERT INTO factory.issue_effects (issue_id, key, kind, payload, created_at)
    VALUES (${issue.id}, ${`${kind}:${row.key}`}, ${kind}, ${payload}, ${now})
    ON CONFLICT (key) DO NOTHING`
}

export type Handled = { issue: IssueRow; result: 'applied' | 'refused' | 'ignored'; detail: string | null }

/**
 * One inbox row against one Issue, inside the transaction that holds the Issue's lock: the transition, its `issue_events` row
 * and the effects it asks for commit together, or none of it happens.
 */
export async function applyEvent(tx: SQL, issue: IssueRow, row: InboxRow, now: Date): Promise<Handled> {
  const kind = row.kind === 'signal' && row.payload?.regression === true ? 'regression' : row.kind
  const found = TABLE[kind]?.[issue.state]
  const step = found?.only && found.only !== issue.reason ? undefined : found
  const refused = async (detail: string): Promise<Handled> => {
    await logEvent(
      tx,
      { issueId: issue.id, key: row.key, kind: 'refused', from: issue.state, to: null, at: row.at },
      { event: row.kind, detail },
    )
    return { issue, result: 'refused', detail }
  }
  if (!step) {
    if (SILENT.has(kind)) return { issue, result: 'ignored', detail: null }
    return refused(`${kind} does not apply to a ${issue.state} Issue`)
  }

  const context = { tx, issue, row, now }
  const refusal = step.refuse?.(context) ?? (await step.apply?.(context))
  if (refusal) return refused(refusal)

  const moved = step.to ? await move(tx, issue, step, row, now) : issue
  await logEvent(
    tx,
    { issueId: issue.id, key: row.key, kind, from: issue.state, to: step.to ?? null, at: row.at },
    row.payload,
  )
  for (const effect of [...(step.effects ?? []), ...(step.to === 'closed' ? (['finalize'] as const) : [])]) {
    await planEffect(tx, moved, effect, row, now)
  }
  if (step.to === 'closed') await wakeDependents(tx, issue.id, now)
  return { issue: moved, result: 'applied', detail: null }
}

export interface NewIssue {
  /** `request` or `alert` through the API; open for what the server files itself (`upkeep`) */
  source: string
  sourceKey: string
  repo: string
  title: string
  facts: unknown
}

/** An alert never reaches the IuRoot workspace (decision 3); the path is real, so a link inside SourceRoot does not hide it. */
const inIuRoot = (repo: string): boolean => repo.split('/').some((part) => part.toLowerCase() === 'iuroot')

/** Postgres refuses this JSON: half a surrogate pair, or a NUL. */
const UNSTORABLE_JSON = new Set(['22P02', '22P05'])

/**
 * Stores a new Issue, always `queued`, with its first `issue_events` row. A repeated `(source, sourceKey)` answers the stored
 * row whatever it became, a closed one too: this wave reopens nothing, and the policy has nothing to add to a row it let in.
 * Refused: a repo outside `repoRoots` (as a spawn's), and an alert in IuRoot. Both throw `RepoRefused`.
 */
export async function createIssueIn(
  tx: SQL,
  input: NewIssue,
  context: { repoRoots: readonly string[]; now: Date },
): Promise<{ issue: Issue; created: boolean }> {
  const { now } = context
  const known = await findIssue(tx, input.source, input.sourceKey)
  if (known) return { issue: known, created: false }

  const repo = await resolveRepo(input.repo, context.repoRoots)
  if (input.source === 'alert' && inIuRoot(repo)) throw new IssueRefused(`an alert files no Issue in IuRoot: ${repo}`)

  const facts = JSON.stringify(input.facts)
  const rows: IssueRow[] = await tx`
    INSERT INTO factory.issues (state, source, source_key, repo, title, facts, created_at, updated_at)
    VALUES ('queued', ${input.source}, ${input.sourceKey}, ${repo}, ${input.title}, ${facts}::text::jsonb, ${now}, ${now})
    ON CONFLICT (source, source_key) DO NOTHING
    RETURNING *`.catch((error: unknown) => {
    if (UNSTORABLE_JSON.has((error as { errno?: string }).errno ?? '')) {
      throw new IssueRefused('facts cannot be stored as JSON')
    }
    throw error
  })
  const [row] = rows
  if (!row) {
    // Lost the race for the key: the winner has committed, or this statement would have waited for it.
    const winner = await findIssue(tx, input.source, input.sourceKey)
    if (!winner) throw new Error(`issue ${input.source}:${input.sourceKey} was not stored`)
    return { issue: winner, created: false }
  }
  await logEvent(
    tx,
    { issueId: row.id, key: `created:${row.id}`, kind: 'created', from: null, to: 'queued', at: now },
    { source: row.source },
  )
  return { issue: toIssue(row), created: true }
}

export const createIssue = (
  sql: SQL,
  input: NewIssue,
  context: { repoRoots: readonly string[]; now: Date },
): Promise<{ issue: Issue; created: boolean }> => sql.begin((tx) => createIssueIn(tx, input, context))

/**
 * Turns every passed `wake_at` into its inbox row and clears it, in one transaction, so a timer fires once: `hold_over` for
 * a `watching` Issue, `wake` for a `waiting` one. The key carries the time: a regression and a second ship is a second hold of
 * the same attempt.
 */
export async function fireTimers(sql: SQL, now: Date, batch = 50): Promise<number> {
  return sql.begin(async (tx) => {
    const due: Pick<IssueRow, 'id' | 'state' | 'attempt' | 'wake_at'>[] = await tx`
      SELECT id, state, attempt, wake_at FROM factory.issues
      WHERE wake_at <= ${now}
      ORDER BY wake_at, id LIMIT ${batch}
      FOR NO KEY UPDATE SKIP LOCKED`
    for (const issue of due) {
      const at = issue.wake_at?.toISOString()
      if (issue.state === 'watching') {
        await enqueue(tx, {
          issueId: issue.id,
          key: `hold:${issue.id}:${issue.attempt}:${at}`,
          kind: 'hold_over',
          at: now,
        })
      } else if (issue.state === 'waiting') {
        await enqueue(tx, { issueId: issue.id, key: `wake:${issue.id}:${at}`, kind: 'wake', at: now })
      }
      await tx`UPDATE factory.issues SET wake_at = NULL WHERE id = ${issue.id}`
    }
    return due.length
  })
}
