import { ISSUE_VERBS, type IssueOutcome, type IssueState, type WaitReason } from '@software-factory/contract'
import type { SQL } from 'bun'
import { notifyMove } from '../notify/rules.ts'
import { addDependency, releaseDependents } from './deps.ts'
import { answerDecision, recordDecision } from './decisions.ts'
import type { EffectKind } from './effects.ts'
import type { IssueRow } from './read.ts'
import { badTime, type Context, type InboxRow, logEvent, text, time } from './shared.ts'

/** The hold after `ship`, until a manifest says otherwise (Wave 4). */
export const DEFAULT_HOLD_MS = 30 * 60_000
/** `closed → queued` is for the same fault within this long. */
export const REOPEN_WINDOW_MS = 30 * 24 * 60 * 60_000

interface Step {
  /** the state it moves to; absent, the event is recorded and the state stays */
  to?: IssueState
  /** why it waits, when `to` is `waiting` */
  reason?: WaitReason
  /** how it ended, when `to` is `closed` */
  outcome?: IssueOutcome
  /** applies only to an Issue waiting for this reason */
  only?: WaitReason
  /** applies only then: otherwise the event is as if the state had no entry */
  when?: (context: Context) => boolean
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

/** The event happened before the one that put the Issue where it is: it says nothing about now. */
const older = (row: InboxRow, issue: IssueRow): boolean => row.at < issue.updated_at

/**
 * What a session event says about an Issue only while nothing newer has happened: a wall or a stop that came before the Issue last
 * moved, or before a turn its session already began, is over. A late spool line can be either.
 */
const isNews =
  (what: 'wall' | 'stop') =>
  async ({ tx, issue, row }: Context): Promise<string | undefined> => {
    if (older(row, issue)) return `this ${what} is older than the state it would end`
    const [later] = await tx`
      SELECT 1 FROM factory.issue_inbox
      WHERE issue_id = ${issue.id} AND session = ${row.session} AND kind = 'turn_started' AND at > ${row.at}
      LIMIT 1`
    return later ? `a turn has started since this ${what}` : undefined
  }
const wallIsNews = isNews('wall')
const stopIsNews = isNews('stop')

/** A wake answers the wait it was filed for, and a dependency's only once no dependency is left: a close removes its rows. */
async function wakeIsDue({ tx, issue, row }: Context): Promise<string | undefined> {
  if (row.payload?.for !== issue.reason) return `this wake is not for a ${issue.reason} wait`
  if (issue.reason === 'wait' && row.payload.wait !== issue.waits) return 'this wake is for an earlier wait'
  if (issue.reason !== 'dependency') return undefined
  const [open] = await tx`SELECT 1 FROM factory.issue_deps WHERE issue_id = ${issue.id} LIMIT 1`
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
      // A wait with no time has no way out but a stop: what has none is `block` or `ask`.
      refuse: ({ row }) =>
        text(row.payload, 'until') === null || badTime(row.payload, 'until')
          ? 'a wait needs a time in `until`'
          : undefined,
    },
  },
  block: { working: { to: 'waiting', reason: 'blocked' } },
  // The factory's own: a lead that stopped twice with nothing reported (§5, "Following a lead").
  unreported: { working: { to: 'waiting', reason: 'unreported', apply: stopIsNews } },
  // The factory's own: the lead's spawn failed or ended, and a note had nobody to go to (Wave 4 may start a new attempt from here).
  lead_gone: { working: { to: 'waiting', reason: 'lead_gone' } },
  ask: { working: { to: 'waiting', reason: 'decision', apply: recordDecision } },
  // Wave 4: the evidence the manifest derives is checked here (`refuse`), for `ship` and for a `close` that touched deployable paths.
  ship: { working: { to: 'watching', hold: true } },
  close: { working: { to: 'closed', outcome: 'done' } },
  drop: { working: { to: 'closed', outcome: 'dropped' } },
  // session events
  limit_stop: { working: { to: 'waiting', reason: 'wall', apply: wallIsNews } },
  turn_started: {
    waiting: {
      to: 'working',
      only: 'wall',
      // The session that hit the wall is past it; a worker's turn says nothing about its lead, nor an older turn about the wall.
      when: ({ issue, row }) => row.session === issue.wall_session && !older(row, issue),
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
  // A question past its expiry with no default: it stays open (an answer is still taken), and the line is for the owner.
  lapsed: { waiting: { only: 'decision' } },
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

/** The one statement that moves an Issue. `step.to` comes from the table, so an edge the table lacks cannot be written. */
async function move(tx: SQL, issue: IssueRow, step: Step, cause: InboxRow, now: Date): Promise<IssueRow> {
  const to = step.to ?? issue.state
  const attempt = step.newAttempt ? issue.attempt + 1 : issue.attempt
  const hold = step.hold ? issue.hold + 1 : issue.hold
  const waits = step.reason === 'wait' ? issue.waits + 1 : issue.waits
  // A timed wait wakes at `until`; a question with an expiry is looked at again then (the default is taken, or the owner is told).
  const until =
    step.reason === 'wait'
      ? time(cause.payload, 'until')
      : step.reason === 'decision'
        ? time(cause.payload, 'expiresAt')
        : null
  const wakeAt = step.hold ? new Date(now.getTime() + DEFAULT_HOLD_MS) : until
  const [row]: IssueRow[] = await tx`
    UPDATE factory.issues
    SET state = ${to}, reason = ${step.reason ?? null}, wall_session = ${step.reason === 'wall' ? cause.session : null}, outcome = ${step.outcome ?? null}, attempt = ${attempt}, hold = ${hold}, waits = ${waits}, revision = revision + 1,
        wake_at = ${wakeAt}, updated_at = GREATEST(updated_at, ${cause.at}), closed_at = ${to === 'closed' ? now : null}
    WHERE id = ${issue.id}
    RETURNING *`
  if (!row) throw new Error(`issue ${issue.id} is gone`)
  return row
}

async function planEffect(
  tx: SQL,
  issue: IssueRow,
  kind: EffectKind,
  row: InboxRow,
  cause: string,
  now: Date,
): Promise<void> {
  const payload = { ...row.payload, attempt: issue.attempt, hold: issue.hold, cause }
  await tx`
    INSERT INTO factory.issue_effects (issue_id, key, kind, payload, created_at)
    VALUES (${issue.id}, ${`${kind}:${row.key}`}, ${kind}, ${payload}, ${now})
    ON CONFLICT (key) DO NOTHING`
}

/** A failed row its Issue moved past is refused, with its line in the Issue's events: a retry must not act on a later attempt. */
export async function supersede(tx: SQL, issue: IssueRow, row: InboxRow, now: Date): Promise<string> {
  const detail = `superseded: ${row.error}`
  await logEvent(
    tx,
    { issueId: issue.id, key: `superseded:${row.key}`, kind: 'refused', from: issue.state, to: null, at: now },
    { event: row.kind, detail },
  )
  return detail
}

export type Handled = { issue: IssueRow; result: 'applied' | 'refused' | 'ignored'; detail: string | null }

/**
 * One inbox row against one Issue, inside the transaction that holds the Issue's lock: the transition, its `issue_events` row
 * and the effects it asks for commit together, or none of it happens.
 */
export async function applyEvent(tx: SQL, issue: IssueRow, row: InboxRow, now: Date): Promise<Handled> {
  // Only a state that can regress reads the flag: elsewhere it is a signal like any other, which is the door's common case.
  const regressed = row.kind === 'signal' && row.payload?.regression === true && TABLE.regression?.[issue.state]
  const kind = regressed ? 'regression' : row.kind
  const context = { tx, issue, row, now }
  const found = TABLE[kind]?.[issue.state]
  const fits = found && (!found.only || found.only === issue.reason) && (!found.when || found.when(context))
  const step = fits ? found : undefined
  const refused = async (detail: string): Promise<Handled> => {
    await logEvent(
      tx,
      { issueId: issue.id, key: row.key, kind: 'refused', from: issue.state, to: null, at: row.at },
      { event: row.kind, detail },
    )
    return { issue, result: 'refused', detail }
  }
  // A lead's verb is for the attempt it was filed under; a new attempt began since, and its lead has not said this.
  const filedFor = row.payload?.attempt
  if (typeof filedFor === 'number' && (ISSUE_VERBS as readonly string[]).includes(kind) && filedFor !== issue.attempt) {
    return refused(`${kind} was filed for attempt ${filedFor}, the Issue is on attempt ${issue.attempt}`)
  }
  if (!step) {
    if (SILENT.has(kind)) return { issue, result: 'ignored', detail: null }
    return refused(`${kind} does not apply to a ${issue.state} Issue`)
  }

  const refusal = step.refuse?.(context) ?? (await step.apply?.(context))
  if (refusal) return refused(refusal)

  const moved = step.to ? await move(tx, issue, step, row, now) : issue
  await logEvent(
    tx,
    { issueId: issue.id, key: row.key, kind, from: issue.state, to: step.to ?? null, at: row.at },
    row.payload,
  )
  // The owner hears of a park by the factory itself and of a regression, in the transaction that decided it.
  await notifyMove(tx, { issue: moved, kind, payload: row.payload, now })
  if (step.to === 'closed') {
    // A closed Issue wants no lead, no note and no check: an older `finalize` still has work to do.
    await tx`
      UPDATE factory.issue_effects SET cancelled_at = ${now}
      WHERE issue_id = ${issue.id} AND done_at IS NULL AND cancelled_at IS NULL AND kind <> 'finalize'`
  }
  for (const effect of [...(step.effects ?? []), ...(step.to === 'closed' ? (['finalize'] as const) : [])]) {
    await planEffect(tx, moved, effect, row, kind, now)
  }
  if (step.to === 'closed') {
    await releaseDependents(tx, issue.id, row, now)
    // Nobody is left to act on an open question, and a reopened Issue asks again.
    await tx`
      UPDATE factory.decisions SET answered_by = 'closed', answered_at = ${now}
      WHERE issue_id = ${issue.id} AND answered_at IS NULL`
  }
  return { issue: moved, result: 'applied', detail: null }
}
