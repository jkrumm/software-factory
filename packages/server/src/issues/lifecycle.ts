import type { Issue, IssueOutcome, IssueState, WaitReason } from '@software-factory/contract'
import { realpath } from 'node:fs/promises'
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
class IssueRefused extends RepoRefused {}

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
  /** starts a new hold */
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

/** A time from a payload as a `Date`, the form Postgres cannot refuse; invalid when it is no time. */
const time = (payload: InboxRow['payload'], name: string): Date | null => {
  const value = text(payload, name)
  return value === null ? null : new Date(value)
}

const badTime = (payload: InboxRow['payload'], name: string): boolean =>
  Number.isNaN(time(payload, name)?.getTime() ?? 0)

async function recordDecision({ tx, issue, row, now }: Context): Promise<string | undefined> {
  const question = text(row.payload, 'question')
  if (!question) return 'an ask needs a question'
  if (badTime(row.payload, 'expiresAt')) return 'expiresAt is not a time'
  const options = Array.isArray(row.payload?.options) ? JSON.stringify(row.payload.options) : null
  await tx`
    INSERT INTO factory.decisions (issue_id, key, question, options, default_option, expires_at, created_at)
    VALUES (${issue.id}, ${row.key}, ${question}, ${options}::text::jsonb, ${text(row.payload, 'default')},
            ${time(row.payload, 'expiresAt')}, ${now})
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

const isIssueId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647

/** Only an open Issue can be waited on: a closed one would never wake this one. */
async function addDependency({ tx, issue, row }: Context): Promise<string | undefined> {
  const on = row.payload?.on
  if (!isIssueId(on) || on === issue.id) return 'a dep needs another Issue in `on`'
  const [blocker]: Pick<IssueRow, 'state'>[] = await tx`SELECT state FROM factory.issues WHERE id = ${on}`
  if (!blocker) return `no Issue ${on}`
  if (blocker.state === 'closed') return `Issue ${on} is closed already`
  await tx`INSERT INTO factory.issue_deps (issue_id, on_issue) VALUES (${issue.id}, ${on}) ON CONFLICT DO NOTHING`
  return undefined
}

/** The event happened before the one that put the Issue where it is: it says nothing about now. */
const older = (row: InboxRow, issue: IssueRow): boolean => row.at < issue.updated_at

/** A wall that happened before the Issue last moved, or before a turn already seen, is over. A late spool line can be either. */
async function wallIsNews({ tx, issue, row }: Context): Promise<string | undefined> {
  if (older(row, issue)) return 'this wall is older than the state it would end'
  const [later] = await tx`
    SELECT 1 FROM factory.issue_inbox
    WHERE issue_id = ${issue.id} AND session = ${row.session} AND kind = 'turn_started' AND at > ${row.at}
    LIMIT 1`
  return later ? 'a turn has started since this wall' : undefined
}

/** A wake answers the wait it was filed for, and a dependency's only once nothing it depends on is open. */
async function wakeIsDue({ tx, issue, row }: Context): Promise<string | undefined> {
  if (row.payload?.for !== issue.reason) return `this wake is not for a ${issue.reason} wait`
  if (issue.reason !== 'dependency') return undefined
  const [open] = await tx`
    SELECT 1 FROM factory.issue_deps d JOIN factory.issues b ON b.id = d.on_issue
    WHERE d.issue_id = ${issue.id} AND b.state <> 'closed'
    LIMIT 1`
  return open ? 'an Issue it depends on is open' : undefined
}

/** The end of a hold and its proof count only for the hold still running: a regression and a second ship started a new one. */
const thisHold = ({ issue, row }: Context): string | undefined =>
  row.payload?.hold === issue.hold ? undefined : `not the current hold (${issue.hold})`

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
  wait: {
    working: {
      to: 'waiting',
      reason: 'wait',
      refuse: ({ row }) => (badTime(row.payload, 'until') ? 'until is not a time' : undefined),
    },
  },
  block: { working: { to: 'waiting', reason: 'blocked' } },
  ask: { working: { to: 'waiting', reason: 'decision', apply: recordDecision } },
  ship: { working: { to: 'watching', hold: true } },
  close: { working: { to: 'closed', outcome: 'done' } },
  drop: { working: { to: 'closed', outcome: 'dropped' } },
  // session events
  limit_stop: { working: { to: 'waiting', reason: 'wall', apply: wallIsNews } },
  turn_started: {
    waiting: {
      to: 'working',
      only: 'wall',
      refuse: ({ issue, row }) => (older(row, issue) ? 'this turn is older than the wall' : undefined),
    },
  },
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
  hold_over: { watching: { effects: ['verify'], refuse: thisHold } },
  verified: { watching: { to: 'closed', outcome: 'done', refuse: thisHold } },
  wake: { waiting: { to: 'working', effects: ['note_lead'], apply: wakeIsDue } },
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
async function wakeDependents(tx: SQL, issueId: number, cause: InboxRow, now: Date): Promise<void> {
  const freed: { id: number }[] = await tx`
    SELECT i.id FROM factory.issue_deps d
    JOIN factory.issues i ON i.id = d.issue_id
    WHERE d.on_issue = ${issueId} AND i.state = 'waiting' AND i.reason = 'dependency'
      AND NOT EXISTS (
        SELECT 1 FROM factory.issue_deps o JOIN factory.issues b ON b.id = o.on_issue
        WHERE o.issue_id = i.id AND b.state <> 'closed')`
  for (const { id } of freed) {
    const key = `wake:${id}:dep:${cause.key}`
    await enqueue(tx, { issueId: id, key, kind: 'wake', at: now, payload: { for: 'dependency' } })
  }
}

async function logEvent(
  tx: SQL,
  input: { issueId: number; key: string; kind: string; from: IssueState | null; to: IssueState | null; at: Date },
  payload: Record<string, unknown> | null,
): Promise<void> {
  await tx`
    INSERT INTO factory.issue_events (issue_id, key, kind, from_state, to_state, at, payload)
    VALUES (${input.issueId}, ${input.key}, ${input.kind}, ${input.from}, ${input.to}, ${input.at}, ${payload})`
}

/** The one statement that moves an Issue. `step.to` comes from the table, so an edge the table lacks cannot be written. */
async function move(tx: SQL, issue: IssueRow, step: Step, cause: InboxRow, now: Date): Promise<IssueRow> {
  const to = step.to ?? issue.state
  const attempt = step.newAttempt ? issue.attempt + 1 : issue.attempt
  const hold = step.hold ? issue.hold + 1 : issue.hold
  const until = step.reason === 'wait' ? time(cause.payload, 'until') : null
  const wakeAt = step.hold ? new Date(now.getTime() + DEFAULT_HOLD_MS) : until
  const [row]: IssueRow[] = await tx`
    UPDATE factory.issues
    SET state = ${to}, reason = ${step.reason ?? null}, outcome = ${step.outcome ?? null}, attempt = ${attempt}, hold = ${hold},
        wake_at = ${wakeAt}, updated_at = ${cause.at}, closed_at = ${to === 'closed' ? now : null}
    WHERE id = ${issue.id}
    RETURNING *`
  if (!row) throw new Error(`issue ${issue.id} is gone`)
  return row
}

async function planEffect(tx: SQL, issue: IssueRow, kind: EffectKind, row: InboxRow, now: Date): Promise<void> {
  const payload = { ...row.payload, attempt: issue.attempt, hold: issue.hold, cause: row.kind }
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
  if (step.to === 'closed') {
    await wakeDependents(tx, issue.id, row, now)
    // Nobody is left to act on an open question, and a reopened Issue asks again.
    await tx`
      UPDATE factory.decisions SET answered_by = 'closed', answered_at = ${now}
      WHERE issue_id = ${issue.id} AND answered_at IS NULL`
  }
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

const namesIuRoot = (path: string): boolean => path.split('/').some((part) => part.toLowerCase() === 'iuroot')

/**
 * An alert never reaches the IuRoot workspace (decision 3). The path is real, so a link inside SourceRoot does not hide it, and
 * a path or a configured root that names IuRoot and links to a neutral place still counts by that name.
 */
async function inIuRoot(repo: string, submitted: string, roots: readonly string[]): Promise<boolean> {
  if (namesIuRoot(repo) || namesIuRoot(submitted)) return true
  for (const root of roots.filter(namesIuRoot)) {
    const real = await realpath(root).catch(() => undefined)
    if (real && (repo === real || repo.startsWith(`${real}/`))) return true
  }
  return false
}

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
  if (input.source === 'alert' && (await inIuRoot(repo, input.repo, context.repoRoots))) {
    throw new IssueRefused(`an alert files no Issue in IuRoot: ${repo}`)
  }

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
 * a `watching` Issue, `wake` for a `waiting` one. Each names what it ends, so one that comes late ends nothing else.
 */
export async function fireTimers(sql: SQL, now: Date, batch = 50): Promise<number> {
  return sql.begin(async (tx) => {
    const due: Pick<IssueRow, 'id' | 'state' | 'attempt' | 'hold' | 'wake_at'>[] = await tx`
      SELECT id, state, attempt, hold, wake_at FROM factory.issues
      WHERE wake_at <= ${now}
      ORDER BY wake_at, id LIMIT ${batch}
      FOR NO KEY UPDATE SKIP LOCKED`
    for (const issue of due) {
      if (issue.state === 'watching') {
        const key = `hold:${issue.id}:${issue.attempt}:${issue.hold}`
        await enqueue(tx, { issueId: issue.id, key, kind: 'hold_over', at: now, payload: { hold: issue.hold } })
      } else if (issue.state === 'waiting') {
        const key = `wake:${issue.id}:${issue.wake_at?.toISOString()}`
        await enqueue(tx, { issueId: issue.id, key, kind: 'wake', at: now, payload: { for: 'wait' } })
      }
      await tx`UPDATE factory.issues SET wake_at = NULL WHERE id = ${issue.id}`
    }
    return due.length
  })
}
