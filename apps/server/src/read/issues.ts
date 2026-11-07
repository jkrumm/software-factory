import type {
  ReadAccountQuota,
  ReadAskLine,
  ReadEvidenceLine,
  ReadInsights,
  ReadIssueCard,
  ReadIssueDetail,
  ReadSessionCard,
  ReadTimelineLine,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import { describeEvent, phaseOf, stateSentence } from './describe.ts'
import { aboutOf, cut, firstSentence, plainText } from './plain.ts'
import {
  deriveLeads,
  emptyInsights,
  issueNumberOf,
  leadKeyOf,
  loadAttempts,
  loadBriefs,
  type LeadSession,
  type SessionDeps,
} from './sessions.ts'

/** The default list length of `/v1/issues`, and its ceiling. */
export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 500
const TITLE_WORDS_MAX = 80

export type IssueScope = 'open' | 'closed' | 'all'

interface IssueRow {
  id: string
  repo: string
  state: ReadIssueCard['state']
  wait_reason: string | null
  outcome: string | null
  filed: { title?: unknown; kind?: unknown } | null
  created_at: Date
  updated_at: Date
  closed_at: Date | null
  work: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

const ISSUE_COLUMNS = (sql: SQL) => sql`
  i.id, i.repo, i.state, i.wait_reason, i.outcome, f.payload AS filed, f.at AS created_at, u.updated_at,
  CASE WHEN i.state = 'closed' THEN u.closed_at END AS closed_at,
  EXISTS (SELECT 1 FROM factory.planning_projects p WHERE p.name = i.repo AND p.source = 'defaults') AS work`

const ISSUE_JOINS = (sql: SQL) => sql`
  FROM factory.issues i
  JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
  JOIN LATERAL (
    SELECT max(e.at) AS updated_at, max(e.at) FILTER (WHERE e.to_state = 'closed') AS closed_at
    FROM factory.issue_events e WHERE e.issue_id = i.id AND e.result = 'applied') u ON true`

async function listRows(sql: SQL, input: { scope: IssueScope; limit: number }): Promise<IssueRow[]> {
  const where =
    input.scope === 'open'
      ? sql`WHERE i.state <> 'closed'`
      : input.scope === 'closed'
        ? sql`WHERE i.state = 'closed'`
        : sql``
  const rows: IssueRow[] = await sql`
    SELECT ${ISSUE_COLUMNS(sql)} ${ISSUE_JOINS(sql)} ${where}
    ORDER BY u.updated_at DESC, i.id DESC LIMIT ${input.limit}`
  return rows
}

async function rowOf(sql: SQL, id: string): Promise<IssueRow | undefined> {
  const rows: IssueRow[] = await sql`SELECT ${ISSUE_COLUMNS(sql)} ${ISSUE_JOINS(sql)} WHERE i.id = ${id}`
  return rows[0]
}

/** What the cards need besides the Issues' own rows, per Issue id. */
interface Extras {
  goals: Map<string, string>
  closings: Map<string, string>
  asking: Set<string>
  heldBy: Map<string, number>
}

async function loadExtras(sql: SQL, ids: readonly string[]): Promise<Extras> {
  const goals = new Map<string, string>()
  const closings = new Map<string, string>()
  const asking = new Set<string>()
  const heldBy = new Map<string, number>()
  if (ids.length === 0) return { goals, closings, asking, heldBy }
  const signals: { issue_id: string; text: string }[] = await sql`
    SELECT DISTINCT ON (issue_id) issue_id, text FROM factory.intake_signals
    WHERE issue_id IN ${sql(ids)} ORDER BY issue_id, received_at`
  for (const row of signals) goals.set(row.issue_id, row.text)
  const ends: { issue_id: string; payload: unknown }[] = await sql`
    SELECT DISTINCT ON (issue_id) issue_id, payload FROM factory.issue_events
    WHERE issue_id IN ${sql(ids)} AND kind IN ('closed', 'cancelled') AND result = 'applied'
    ORDER BY issue_id, at DESC, version DESC`
  for (const row of ends) {
    const reason = isRecord(row.payload) ? text(row.payload.reason) : null
    if (reason) closings.set(row.issue_id, reason)
  }
  const open: { issue_id: string }[] = await sql`
    SELECT issue_id FROM factory.decisions WHERE issue_id IN ${sql(ids)} AND answered_at IS NULL AND withdrawn_at IS NULL
    UNION SELECT issue_id FROM factory.errands WHERE issue_id IN ${sql(ids)} AND done_at IS NULL`
  for (const row of open) asking.add(row.issue_id)
  const holders: { id: string; holder: string }[] = await sql`
    SELECT i.id, min(c.issue_id) AS holder FROM factory.issues i
    JOIN factory.capacity_claims c ON c.repo = i.repo AND c.issue_id <> i.id
    WHERE i.id IN ${sql(ids)} AND i.state = 'queued' GROUP BY i.id`
  for (const row of holders) heldBy.set(row.id, issueNumberOf(row.holder))
  return { goals, closings, asking, heldBy }
}

const OWNER_WAITS = new Set(['decision', 'review', 'errand'])

function cardOf(input: {
  row: IssueRow
  leads: readonly LeadSession[]
  extras: Extras
  quota: ReadonlyMap<string, ReadAccountQuota>
  now: Date
}): ReadIssueCard {
  const { row, leads, extras, now } = input
  const open = row.state !== 'closed'
  const filedTitle = text(row.filed?.title) ?? row.id
  const latest = leads.at(-1)
  const live = open && latest?.alive ? latest : undefined
  const account = latest?.card.account ?? null
  const closing = extras.closings.get(row.id)
  const closingSentence = !open && closing ? firstSentence(plainText(closing)) : ''
  const summary = closingSentence || stateSentence({ state: row.state, reason: row.wait_reason, outcome: row.outcome })
  const startedAt = row.created_at
  const insights: ReadInsights = {
    ...emptyInsights({ startedAt, endedAt: row.closed_at, now }),
    workingMs: leads.reduce((sum, lead) => sum + lead.workingMs, 0),
    turns: leads.reduce((sum, lead) => sum + lead.turns, 0),
    attempts: Math.max(leads.length, 1),
  }
  return {
    id: issueNumberOf(row.id),
    ref: row.id,
    filedTitle,
    title: cut(plainText(filedTitle), TITLE_WORDS_MAX) || filedTitle,
    summary,
    about: aboutOf(filedTitle, extras.goals.get(row.id) ?? null),
    state: row.state,
    reason: row.wait_reason,
    outcome: row.outcome,
    phase: phaseOf({ state: row.state, reason: row.wait_reason }),
    repo: row.repo,
    repoName: row.repo,
    visible: row.work,
    kind: text(row.filed?.kind),
    size: null,
    lead: live?.card.id ?? null,
    account,
    quota: account ? (input.quota.get(account) ?? null) : null,
    insights,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
    heldBy: extras.heldBy.get(row.id) ?? null,
    waitingOnOwner:
      open && ((row.state === 'waiting' && OWNER_WAITS.has(row.wait_reason ?? '')) || extras.asking.has(row.id)),
  }
}

export interface Cards {
  cards: ReadIssueCard[]
  /** the derived attempts per Issue id, oldest first */
  leads: Map<string, LeadSession[]>
}

async function build(
  deps: SessionDeps,
  rows: readonly IssueRow[],
  quota: ReadonlyMap<string, ReadAccountQuota>,
): Promise<Cards> {
  const ids = rows.map((row) => row.id)
  const [attempts, briefs, extras] = await Promise.all([
    loadAttempts(deps.sql, ids, 0),
    loadBriefs(deps.sql, ids),
    loadExtras(deps.sql, ids),
  ])
  const derived = await deriveLeads(deps, { attempts, briefs, quota })
  const leads = new Map<string, LeadSession[]>()
  for (const lead of derived) {
    const list = leads.get(lead.card.issueRef ?? '') ?? []
    list.push(lead)
    leads.set(lead.card.issueRef ?? '', list)
  }
  const now = deps.clock.now()
  return { cards: rows.map((row) => cardOf({ row, leads: leads.get(row.id) ?? [], extras, quota, now })), leads }
}

/** `GET /v1/issues`: the newest activity first. */
export async function listCards(
  deps: SessionDeps,
  input: { scope: IssueScope; limit: number; quota: ReadonlyMap<string, ReadAccountQuota> },
): Promise<ReadIssueCard[]> {
  const rows = await listRows(deps.sql, input)
  return (await build(deps, rows, input.quota)).cards
}

interface DecisionRow {
  question: string
  options: unknown
  no_answer: unknown
  answer: string | null
  asked_at: Date
}

/** `GET /v1/issues/:id`: the card with its timeline, evidence, asks and sessions; undefined for no such Issue. */
export async function issueDetail(
  deps: SessionDeps,
  input: { id: string; quota: ReadonlyMap<string, ReadAccountQuota> },
): Promise<ReadIssueDetail | undefined> {
  const { sql } = deps
  const row = await rowOf(sql, input.id)
  if (!row) return undefined
  const { cards, leads } = await build(deps, [row], input.quota)
  const card = cards[0]
  if (!card) return undefined
  const events: { at: Date; kind: string; payload: unknown }[] = await sql`
    SELECT at, kind, payload FROM factory.issue_events
    WHERE issue_id = ${row.id} AND result = 'applied' ORDER BY version`
  const timeline: ReadTimelineLine[] = events.map((event) => {
    const attempt = isRecord(event.payload) ? event.payload.attempt : undefined
    return {
      at: event.at.toISOString(),
      kind: event.kind,
      text: describeEvent(event.kind, event.payload),
      session: typeof attempt === 'number' ? leadKeyOf(row.id, attempt) : null,
    }
  })
  const proof: { kind: string; at: Date; payload: unknown }[] = await sql`
    SELECT kind, at, payload FROM factory.quality_evidence WHERE issue_id = ${row.id} ORDER BY at`
  const evidence: ReadEvidenceLine[] = proof.map((line) => ({
    kind: line.kind,
    link: null,
    note: isRecord(line.payload) ? (text(line.payload.note) ?? text(line.payload.summary)) : null,
    at: line.at.toISOString(),
  }))
  const decisions: DecisionRow[] = await sql`
    SELECT question, options, no_answer, answer, asked_at FROM factory.decisions
    WHERE issue_id = ${row.id} ORDER BY asked_at`
  const asks: ReadAskLine[] = decisions.map((d) => ({
    question: d.question,
    options: Array.isArray(d.options)
      ? d.options.flatMap((option) => (isRecord(option) && typeof option.label === 'string' ? [option.label] : []))
      : [],
    default: isRecord(d.no_answer) ? text(d.no_answer.default) : null,
    answer: d.answer,
    askedAt: d.asked_at.toISOString(),
  }))
  const sessions: ReadSessionCard[] = (leads.get(row.id) ?? []).map((lead) => lead.card)
  return { ...card, timeline, evidence, asks, sessions }
}
