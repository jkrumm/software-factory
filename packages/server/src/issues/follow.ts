import {
  type DecisionEntry,
  EVIDENCE_KINDS,
  type EvidenceEntry,
  type EvidenceKind,
  type IssueState,
  type IssueView,
  type StatusIssue,
  type StatusWait,
  type TimelineEntry,
  type WaitReason,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import { unmetKinds } from './evidence.ts'
import { getIssue } from './read.ts'

/** Open Issues the status screen lists; the rest are counted. */
export const STATUS_ISSUES = 40
/** A closed Issue stays on the screen this long when its finalize failed. */
const FINALIZE_SHOWN_MS = 24 * 3_600_000
/** Entries of an Issue's story `GET /issues/:id/timeline` returns, newest ones; the count of the rest is in the answer. */
export const TIMELINE_ENTRIES = 500
const EVIDENCE_ENTRIES = 200

/** What the owner needs first: a failed finalize, then Issues that wait, then the running, then the queue. */
const RANK: Record<IssueState, number> = { closed: 0, waiting: 1, working: 2, watching: 3, queued: 4, settling: 5 }

interface StatusRow {
  id: number
  state: IssueState
  reason: WaitReason | null
  repo: string
  title: string
  attempt: number
  wake_at: Date | null
  updated_at: Date
  closed_at: Date | null
  lead: string | null
  phase: string | null
  decisions: number
  claim_wait: boolean
  finalize_error: string | null
  derived: { required?: unknown; mergedAt?: unknown } | null
}

const isKind = (value: unknown): value is EvidenceKind => EVIDENCE_KINDS.some((kind) => kind === value)

/**
 * The open Issues for `factory status` (and a closed one, for a day, whose finalize failed), most urgent first. Reads stored rows only:
 * no git and no port, so it is as cheap as the rest of the screen. The evidence still missing is what the last `ship` or `close` of the
 * current attempt derived from its commits, minus what is on record since: until a lead has tried one, nothing is known and nothing is
 * listed.
 */
export async function statusIssues(sql: SQL, now: Date): Promise<{ issues: StatusIssue[]; more: number }> {
  const since = new Date(now.getTime() - FINALIZE_SHOWN_MS)
  const rows: StatusRow[] = await sql`
    SELECT i.id, i.state, i.reason, i.repo, i.title, i.attempt, i.wake_at, i.updated_at, i.closed_at,
      (SELECT s.id FROM factory.sessions s WHERE s.id = 'lead-' || i.id || '-' || i.attempt) AS lead,
      (SELECT e.payload->>'phase' FROM factory.issue_events e
       WHERE e.issue_id = i.id AND e.kind = 'phase' AND e.payload->>'attempt' = i.attempt::text ORDER BY e.id DESC LIMIT 1) AS phase,
      (SELECT count(*)::int FROM factory.decisions d WHERE d.issue_id = i.id AND d.answered_at IS NULL) AS decisions,
      EXISTS (SELECT 1 FROM factory.claims c WHERE c.issue_id = i.id AND c.held_at IS NULL) AS claim_wait,
      (SELECT f.error FROM factory.issue_effects f
       WHERE f.issue_id = i.id AND f.kind = 'finalize' AND f.done_at IS NULL AND f.cancelled_at IS NULL AND f.error IS NOT NULL
       ORDER BY f.id DESC LIMIT 1) AS finalize_error,
      (SELECT b.payload->'derived' FROM factory.issue_inbox b
       WHERE b.issue_id = i.id AND b.kind IN ('ship', 'close') AND b.payload->>'attempt' = i.attempt::text AND b.payload ? 'derived'
       ORDER BY b.id DESC LIMIT 1) AS derived
    FROM factory.issues i
    WHERE i.state <> 'closed'
       OR (i.closed_at > ${since} AND EXISTS (
         SELECT 1 FROM factory.issue_effects f
         WHERE f.issue_id = i.id AND f.kind = 'finalize' AND f.done_at IS NULL AND f.cancelled_at IS NULL AND f.error IS NOT NULL))`

  const open = rows.filter((row) => row.state === 'working' || row.state === 'waiting')
  const stored: { issue_id: number; kind: string; newest: Date }[] =
    open.length === 0
      ? []
      : await sql`
        SELECT e.issue_id, e.kind, max(e.at) AS newest FROM factory.evidence e
        JOIN factory.issues i ON i.id = e.issue_id AND e.attempt = i.attempt
        WHERE e.issue_id IN ${sql(open.map((row) => row.id))} GROUP BY e.issue_id, e.kind`

  const view = (row: StatusRow): StatusIssue => {
    const required = Array.isArray(row.derived?.required) ? row.derived.required.filter(isKind) : []
    const mergedAt = typeof row.derived?.mergedAt === 'string' ? row.derived.mergedAt : null
    const mine = stored.filter((s) => s.issue_id === row.id)
    const waiting: StatusWait | null =
      row.state === 'waiting' ? row.reason : row.state === 'queued' && row.claim_wait ? 'claim' : null
    return {
      id: row.id,
      state: row.state,
      repo: row.repo,
      title: row.title,
      attempt: row.attempt,
      lead: row.state === 'closed' ? null : row.lead,
      phase: row.phase,
      waiting,
      wakeAt: row.wake_at?.toISOString() ?? null,
      missing: open.includes(row) ? unmetKinds(required, mine, mergedAt).map((u) => u.kind) : [],
      decisions: row.decisions,
      finalizeError: row.state === 'closed' ? row.finalize_error : null,
      since: (row.closed_at ?? row.updated_at).toISOString(),
    }
  }
  const sorted = [...rows].sort(
    (a, b) => RANK[a.state] - RANK[b.state] || a.updated_at.getTime() - b.updated_at.getTime() || a.id - b.id,
  )
  return { issues: sorted.slice(0, STATUS_ISSUES).map(view), more: Math.max(0, sorted.length - STATUS_ISSUES) }
}

interface EventRow {
  id: string
  key: string
  kind: string
  from_state: string | null
  to_state: string | null
  at: Date
  payload: unknown
  session: string | null
}

interface InboxRow {
  id: string
  key: string
  kind: string
  session: string | null
  at: Date
  payload: unknown
  result: 'applied' | 'refused' | 'ignored' | null
  detail: string | null
  error: string | null
}

/**
 * One Issue's story, oldest first: its `issue_events` (what the lifecycle applied or refused, with the state it moved from and to) and
 * the inbox rows no event came of, which are the ones still unhandled (a failed one with its error) and the other things filed that
 * moved nothing. A session's silent events (`turn_started`, `prompt_idle`…) are in `factory session get`, not here. Then its evidence and
 * its questions. Every payload is what its sender filed: data.
 */
export async function getIssueView(sql: SQL, id: number): Promise<IssueView | undefined> {
  // One snapshot: the tick moves rows from the inbox to the events between statements, and a row must be in one list or the other.
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`
    return readIssueView(tx, id)
  })
}

async function readIssueView(sql: SQL, id: number): Promise<IssueView | undefined> {
  const issue = await getIssue(sql, id)
  if (!issue) return undefined
  const events: EventRow[] = await sql`
    SELECT e.id, e.key, e.kind, e.from_state, e.to_state, e.at, e.payload, b.session
    FROM factory.issue_events e LEFT JOIN factory.issue_inbox b ON b.key = e.key
    WHERE e.issue_id = ${id} ORDER BY e.at DESC, e.id DESC LIMIT ${TIMELINE_ENTRIES}`
  const [counted]: { n: number }[] =
    await sql`SELECT count(*)::int AS n FROM factory.issue_events WHERE issue_id = ${id}`
  const waiting: InboxRow[] = await sql`
    SELECT b.id, b.key, b.kind, b.session, b.at, b.payload, b.result, b.detail, b.error FROM factory.issue_inbox b
    WHERE b.issue_id = ${id} AND NOT EXISTS (SELECT 1 FROM factory.issue_events e WHERE e.key = b.key)
      AND (b.handled_at IS NULL OR b.session IS NULL)
    ORDER BY b.at DESC, b.id DESC LIMIT ${TIMELINE_ENTRIES}`
  const [waitingCounted]: { n: number }[] = await sql`
    SELECT count(*)::int AS n FROM factory.issue_inbox b
    WHERE b.issue_id = ${id} AND NOT EXISTS (SELECT 1 FROM factory.issue_events e WHERE e.key = b.key)
      AND (b.handled_at IS NULL OR b.session IS NULL)`

  const story: { at: Date; rank: number; id: number; entry: TimelineEntry }[] = [
    ...events.map((e) => ({
      at: e.at,
      rank: 0,
      id: Number(e.id),
      entry: {
        at: e.at.toISOString(),
        source: 'event' as const,
        kind: e.kind,
        key: e.key,
        from: e.from_state,
        to: e.to_state,
        session: e.session,
        result: null,
        detail: null,
        payload: e.payload,
      },
    })),
    ...waiting.map((b) => ({
      at: b.at,
      rank: 1,
      id: Number(b.id),
      entry: {
        at: b.at.toISOString(),
        source: 'inbox' as const,
        kind: b.kind,
        key: b.key,
        from: null,
        to: null,
        session: b.session,
        result: b.result,
        detail: b.error ?? b.detail,
        payload: b.payload,
      },
    })),
  ]
  story.sort((a, b) => a.at.getTime() - b.at.getTime() || a.rank - b.rank || a.id - b.id)
  const shown = story.slice(-TIMELINE_ENTRIES)

  // The newest ones, oldest first: what a lead proved last is what the gate reads.
  const evidence: (Omit<EvidenceEntry, 'at'> & { at: Date })[] = await sql`
    SELECT * FROM (
      SELECT kind, link, payload, attempt, at, author, id FROM factory.evidence
      WHERE issue_id = ${id} ORDER BY at DESC, id DESC LIMIT ${EVIDENCE_ENTRIES}) newest
    ORDER BY at, id`
  const [evidenceCounted]: { n: number }[] =
    await sql`SELECT count(*)::int AS n FROM factory.evidence WHERE issue_id = ${id}`
  const decisions: {
    id: string
    question: string
    options: unknown
    default_option: string | null
    expires_at: Date | null
    created_at: Date
    answer: string | null
    answered_by: string | null
    answered_at: Date | null
  }[] = await sql`SELECT * FROM factory.decisions WHERE issue_id = ${id} ORDER BY id`

  return {
    ...issue,
    timeline: shown.map((s) => s.entry),
    timelineCut: Math.max(0, (counted?.n ?? 0) + (waitingCounted?.n ?? 0) - shown.length),
    evidence: evidence.map(({ kind, link, payload, attempt, at, author }) => ({
      kind,
      link,
      payload,
      attempt,
      at: at.toISOString(),
      author,
    })),
    evidenceCut: Math.max(0, (evidenceCounted?.n ?? 0) - evidence.length),
    decisions: decisions.map((d): DecisionEntry => ({
      id: Number(d.id),
      question: d.question,
      options: d.options,
      default: d.default_option,
      expiresAt: d.expires_at?.toISOString() ?? null,
      askedAt: d.created_at.toISOString(),
      answer: d.answer,
      answeredBy: d.answered_by,
      answeredAt: d.answered_at?.toISOString() ?? null,
    })),
  }
}
