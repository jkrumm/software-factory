import { createHash } from 'node:crypto'
import type { SQL } from 'bun'
import { BUDGET_HOURS, DEFAULT_SIZE, SILENT_AFTER_MS } from '../health.ts'
import { liveSessions } from '../sessions.ts'
import { Waiting } from './effects.ts'
import { type HoldCheck, proofInputOf, type Proof } from './hold.ts'
import { enqueue } from './inbox.ts'
import { leadsOnBackgroundWork } from './lead-activity.ts'
import { WAKEABLE } from './lifecycle.ts'
import { leadKey } from './names.ts'
import type { OffTick } from './offtick.ts'
import { markEvent } from './shared.ts'

/**
 * The steward (docs/design.md §4 "The steward"): the one thing that acts on an Issue that stalled. It reads stored rows, calls no model
 * and no port inside a transaction, and moves nothing itself: every act is an inbox row with a deterministic key, so the lifecycle's
 * TABLE decides, `factory issue show` lists it and a replayed pass files nothing twice. The counts are read back from the inbox.
 */

const MIN = 60_000
/** The acts of one cause, at most this many per Issue. */
export const MAX_ACTS = 3
/** When act `n` is due, after the cause began: 30 min, 2 h, 6 h. */
const BACKOFF_MS = [30 * MIN, 120 * MIN, 360 * MIN] as const
/** A cause that is already a condition of its own (a silent lead, a queue behind a claim) starts its first act at that condition. */
const CLAIM_QUEUED_MS = 15 * MIN
const FIRST_MS: Partial<Record<Cause, number>> = { silent: SILENT_AFTER_MS, claim: CLAIM_QUEUED_MS }
/** A timed `wait` is no stall for this long after it began: a claim wake does not cut short a wait the lead just set (a CI run). */
export const WAIT_GRACE_MS = 5 * MIN
/** The retries are spent for the owner this long after the last act, the length of the last backoff. */
const EXHAUSTED_AFTER_MS = BACKOFF_MS[2]

export type Cause = 'blocked' | 'parked' | 'unreported' | 'lead_gone' | 'claim' | 'silent' | 'over_budget'

const WAKE_TEXT = 'recheck your block against the current state; ship, continue, or block again with what changed'
const NUDGE_TEXT = 'report: continue, ship, block, or narrow'

export interface StewardDeps {
  /** re-runs a hold's verification off the tick for a block that names it; without it the note says it was not re-run */
  verify?: { proof: Proof; offTick: OffTick }
}

interface OpenIssue {
  id: number
  repo: string
  state: 'waiting' | 'working'
  reason: string | null
  attempt: number
  waits: number
  size: string | null
  /** when it came to be in this state */
  entered: Date
  /** the timer that ends a `wait`, while it has not fired */
  wake_at: Date | null
  /** the lead's last event, working only */
  last_event: Date | null
  /** when it began working, working only */
  since: Date
}

/** A uuid-shaped id derived from the key: the same act is the same prompt. */
const callOf = (key: string): string => {
  const h = createHash('sha256').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

const minutes = (iso: Date): string => `${iso.toISOString().slice(0, 16)}Z`

/** A cause that holds for the Issue now, with the moment it began. */
interface Candidate {
  cause: Cause
  anchor: Date
}

const key = (issueId: number, cause: Cause, n: number): string => `steward:${issueId}:${cause}:${n}`

/** What the Issue's block says about the hold: only a `block` that names the verification, of an Issue that shipped. */
async function blockNamesVerify(sql: SQL, issue: OpenIssue): Promise<boolean> {
  const [row]: { reason: string | null; shipped: boolean }[] = await sql`
    SELECT (SELECT payload->>'reason' FROM factory.issue_events
            WHERE issue_id = ${issue.id} AND kind = 'block' AND to_state = 'waiting' ORDER BY id DESC LIMIT 1) AS reason,
           EXISTS (SELECT 1 FROM factory.issue_events WHERE issue_id = ${issue.id} AND kind = 'ship' AND to_state = 'watching') AS shipped`
  return row?.shipped === true && /verif/i.test(row.reason ?? '')
}

/**
 * The result of re-running the hold's verification for this act, as one line for the note. The run is off the tick (`OffTick`, keyed by
 * the act) and its answer an `issue_events` row under the same key, so a pass finds it again whoever ran it. `undefined`: still running,
 * the act waits for the next pass.
 */
async function verification(
  sql: SQL,
  deps: StewardDeps,
  issue: OpenIssue,
  act: number,
  now: Date,
): Promise<string | undefined> {
  const eventKey = `steward_verify:${issue.id}:${act}`
  const read = async (): Promise<string | undefined> => {
    const [row]: { payload: { line: string } }[] =
      await sql`SELECT payload FROM factory.issue_events WHERE key = ${eventKey}`
    return row?.payload.line
  }
  const known = await read()
  if (known) return known
  if (!deps.verify) return 'verify was not re-run: the server has no verifier wired'
  const { proof, offTick } = deps.verify
  try {
    await offTick.run(eventKey, async (signal) => {
      const checks: HoldCheck[] = await proof.run(await proofInputOf(sql, issue), signal)
      if (signal.aborted) throw new Waiting('the server is stopping')
      const bad = checks.filter((check) => !check.ok)
      const line =
        bad.length === 0
          ? `verify re-run just now: green (${checks.length} checks)`
          : `verify re-run just now: red, ${bad.map((check) => `${check.name}: ${check.detail.replace(/\s+/g, ' ').slice(0, 160)}`).join(' | ')}`
      await markEvent(sql, issue.id, eventKey, 'steward_verify', now, { ok: bad.length === 0, line })
    })
  } catch (error) {
    if (error instanceof Waiting) return undefined
    return `verify was not re-run: ${error instanceof Error ? error.message : String(error)}`
  }
  return read()
}

/** The holders of a project's claim, waiting in a wakeable reason with another Issue queued behind it for 15 min and no lead working: when the oldest began waiting. */
async function claimHolders(sql: SQL, now: Date): Promise<Map<number, Date>> {
  const rows: { holder: number; queued_at: Date }[] = await sql`
    SELECT h.issue_id AS holder, min(q.queued_at) AS queued_at
    FROM factory.claims h
    JOIN factory.issues hi ON hi.id = h.issue_id AND hi.state = 'waiting' AND hi.reason IN ${sql([...WAKEABLE])}
    JOIN factory.claims q ON q.key = h.key AND q.held_at IS NULL
    JOIN factory.issues qi ON qi.id = q.issue_id AND qi.state = 'queued'
    WHERE h.held_at IS NOT NULL AND q.queued_at <= ${new Date(now.getTime() - CLAIM_QUEUED_MS)}
      AND NOT EXISTS (
        SELECT 1 FROM factory.claims w JOIN factory.issues wi ON wi.id = w.issue_id
        WHERE w.key = h.key AND w.held_at IS NOT NULL AND wi.state = 'working')
    GROUP BY h.issue_id`
  return new Map(rows.map((row) => [row.holder, row.queued_at]))
}

/** Every cause that holds for the Issue now, in the order the steward tries them. */
function candidates(
  issue: OpenIssue,
  live: ReadonlySet<string>,
  holders: ReadonlyMap<number, Date>,
  background: ReadonlySet<number>,
  now: Date,
): Candidate[] {
  const hasLead = live.has(leadKey(issue.id, issue.attempt))
  const found: Candidate[] = []
  if (issue.state === 'waiting') {
    const queued = holders.get(issue.id)
    // A `wait` is the lead's own choice: not a stall while its stated time lies ahead, nor in the minutes after it was set.
    const waitingOnPurpose =
      issue.reason === 'wait' &&
      ((issue.wake_at !== null && issue.wake_at.getTime() > now.getTime()) ||
        now.getTime() - issue.entered.getTime() < WAIT_GRACE_MS)
    if (queued && hasLead && !waitingOnPurpose) found.push({ cause: 'claim', anchor: queued })
    if (hasLead && (issue.reason === 'blocked' || issue.reason === 'parked' || issue.reason === 'unreported')) {
      found.push({ cause: issue.reason, anchor: issue.entered })
    }
    if (issue.reason === 'lead_gone' && !hasLead) found.push({ cause: 'lead_gone', anchor: issue.entered })
    return found
  }
  if (!hasLead) return found
  // Silent from its last event, but not from before it was last woken or began working: the news that moved it is the last word it was given.
  // A lead whose last event is a stop with background work in flight (a subagent) waits for it, it is not silent.
  if (!background.has(issue.id)) {
    found.push({
      cause: 'silent',
      anchor: new Date(Math.max((issue.last_event ?? issue.since).getTime(), issue.since.getTime())),
    })
  }
  const size = issue.size && issue.size in BUDGET_HOURS ? (issue.size as keyof typeof BUDGET_HOURS) : DEFAULT_SIZE
  found.push({ cause: 'over_budget', anchor: new Date(issue.since.getTime() + BUDGET_HOURS[size] * 60 * MIN) })
  return found
}

/** When act `n` of the cause is due. */
const dueAt = (cause: Cause, anchor: Date, n: number): number =>
  anchor.getTime() + (n === 0 ? (FIRST_MS[cause] ?? BACKOFF_MS[0]) : (BACKOFF_MS[n] ?? EXHAUSTED_AFTER_MS))

/** The act for a cause, as the inbox row the lifecycle takes. Undefined when it has to wait (a verification still running). */
async function fileAct(
  sql: SQL,
  deps: StewardDeps,
  issue: OpenIssue,
  cause: Cause,
  n: number,
  now: Date,
): Promise<boolean | undefined> {
  const id = key(issue.id, cause, n + 1)
  const base = { who: 'steward', cause, n: n + 1 }
  if (cause === 'lead_gone') {
    const { duplicate } = await enqueue(sql, {
      issueId: issue.id,
      key: id,
      kind: 'restart',
      at: now,
      payload: { ...base, attempt: issue.attempt, detail: 'the steward restarts a lead that is still gone' },
    })
    return !duplicate
  }
  const waking = issue.state === 'waiting'
  let text = waking ? WAKE_TEXT : NUDGE_TEXT
  if (cause === 'blocked' && (await blockNamesVerify(sql, issue))) {
    const line = await verification(sql, deps, issue, n + 1, now)
    if (line === undefined) return undefined
    text = `${text}. ${line}`
  }
  const { duplicate } = await enqueue(sql, {
    issueId: issue.id,
    key: id,
    kind: 'note',
    at: now,
    payload: { ...base, text, call: callOf(id), ...(waking ? { wake: true } : {}) },
  })
  return !duplicate
}

/** The retries are spent: one event with what was tried. The ask judge (`judge.ts`) then answers it or records the owner's line. */
async function exhaust(sql: SQL, issue: OpenIssue, cause: Cause, now: Date): Promise<void> {
  const rows: { key: string; at: Date; kind: string; result: string | null; payload: { n: number; text?: string } }[] =
    await sql`
    SELECT key, at, kind, result, payload FROM factory.issue_inbox
    WHERE issue_id = ${issue.id} AND key LIKE ${`steward:${issue.id}:${cause}:%`} ORDER BY id`
  const tried = rows.map(
    (row) =>
      `${row.payload.n}. ${minutes(row.at)} ${row.kind === 'restart' ? 'restart' : row.kind === 'note' && row.payload.text === NUDGE_TEXT ? 'nudge' : 'wake'}, ${row.result ?? 'not handled'}`,
  )
  await markEvent(sql, issue.id, `steward_exhausted:${issue.id}:${cause}`, 'steward_exhausted', now, { cause, tried })
}

/**
 * One pass, before the inbox: for each open Issue, the first cause that is due files its next act, at most one per Issue; a cause whose
 * acts are spent and whose last backoff has passed (with the Issue still stuck) tells the owner, once. Idempotent: the keys are the
 * acts', and an act is filed only when its backoff, counted from when the cause began, has elapsed.
 */
export async function runSteward(sql: SQL, now: Date, deps: StewardDeps): Promise<void> {
  const issues: OpenIssue[] = await sql`
    SELECT i.id, i.repo, i.state, i.reason, i.attempt, i.waits, i.size, i.updated_at AS entered, i.wake_at,
      COALESCE((SELECT max(e.at) FROM factory.issue_events e WHERE e.issue_id = i.id AND e.to_state = 'working'), i.updated_at) AS since,
      (SELECT max(v.at) FROM factory.events v WHERE v.session = 'lead-' || i.id || '-' || i.attempt) AS last_event
    FROM factory.issues i WHERE i.state IN ('waiting', 'working') ORDER BY i.id`
  if (issues.length === 0) return

  const live = new Set((await liveSessions(sql, now)).map((session) => session.id))
  const holders = await claimHolders(sql, now)
  const background = await leadsOnBackgroundWork(sql)
  const actRows: { issue_id: number; cause: Cause; n: number; last_at: Date }[] = await sql`
    SELECT issue_id, payload->>'cause' AS cause, count(*)::int AS n, max(at) AS last_at FROM factory.issue_inbox
    WHERE key LIKE 'steward:%' GROUP BY issue_id, payload->>'cause'`
  const acted = new Map(actRows.map((row) => [`${row.issue_id}:${row.cause}`, row]))
  const spentRows: { key: string }[] = await sql`SELECT key FROM factory.issue_events WHERE kind = 'steward_exhausted'`
  const told = new Set(spentRows.map((row) => row.key))

  for (const issue of issues) {
    for (const { cause, anchor } of candidates(issue, live, holders, background, now)) {
      const done = acted.get(`${issue.id}:${cause}`)
      const n = done?.n ?? 0
      if (n >= MAX_ACTS) {
        const spentAt = Math.max(done?.last_at.getTime() ?? 0, anchor.getTime()) + EXHAUSTED_AFTER_MS
        if (now.getTime() >= spentAt && !told.has(`steward_exhausted:${issue.id}:${cause}`))
          await exhaust(sql, issue, cause, now)
        continue
      }
      if (now.getTime() < dueAt(cause, anchor, n)) continue
      // One act per Issue per pass; a verification still running holds the Issue's next act, not another cause's.
      if ((await fileAct(sql, deps, issue, cause, n, now)) !== false) break
    }
  }
}

/** `factory status`: what the steward did in the last 24 h, counted from the inbox rows it filed and the events of the owner's line; nothing is stored. */
export async function stewardStatus(sql: SQL, now: Date): Promise<{ acts: number; exhausted: number }> {
  const since = new Date(now.getTime() - 24 * 60 * MIN)
  const [row]: { acts: number; exhausted: number }[] = await sql`
    SELECT (SELECT count(*)::int FROM factory.issue_inbox WHERE payload->>'who' = 'steward' AND at > ${since}) AS acts,
           (SELECT count(*)::int FROM factory.issue_events WHERE kind = 'steward_exhausted' AND at > ${since}) AS exhausted`
  return { acts: row?.acts ?? 0, exhausted: row?.exhausted ?? 0 }
}
