import type { SQL } from 'bun'
import * as z from 'zod'
import { CASE_OUTCOMES } from '@software-factory/contract'
import type { CaseRead, CaseSubject } from '../kernel/case-file.ts'
import { scrub } from '../kernel/scrub.ts'
import { boundedRead } from './bounded.ts'
import { callOutcome, edgeOutcomes, outcomeOf } from './judgments.ts'

/**
 * The case file's parts the database holds (`docs/architecture.md` §Loops and agw, "The case file"): the Issue as filed, the
 * owner's notes on it, the repo's project, its open Issues with their summaries and edges, the plan rows around the Issue and
 * this judge's earlier answers in the repo. Read-only; every text scrubbed and cut to its share of agw's cap. A work repo's
 * case is read like any other: its words go to agw (NL22), never to the read surface.
 */

/** Each part's share of the case, in characters: what the factory leaves out when a part is long. */
const CUT = {
  title: 300,
  issueText: 3_000,
  facts: 16_000,
  note: 2_000,
  notes: 8_000,
  project: 3_000,
  open: 30,
  summary: 300,
  plan: 10_000,
  planRow: 8_000,
  neighbour: 600,
  precedents: 6,
  precedent: 600,
} as const

const cut = (text: string | null | undefined, max: number): string => scrub(text ?? '').slice(0, max)

const iso = (at: Date): string => at.toISOString()

const IssueRow = z.object({ id: z.string(), repo: z.string(), title: z.string().nullable() })
const NoteRow = z.object({ version: z.number().int(), actor: z.string(), at: z.date(), text: z.string().nullable() })
const OpenRow = z.object({
  id: z.string(),
  state: z.string(),
  title: z.string().nullable(),
  summary: z.string(),
  after: z.array(z.string()),
  before: z.array(z.string()),
})
const ProjectRow = z.object({ repo: z.string(), project: z.unknown() })
const FiledRow = z.object({ project: z.string(), row_key: z.string(), plan: z.unknown() })
const PrecedentRow = z.object({
  at: z.date().nullable(),
  subject: z.string().nullable(),
  answer: z.string().nullable(),
  outcome: z.enum(CASE_OUTCOMES),
})

const IssueIdText = /^issue_[1-9][0-9]*$/

/** The Issue a subject names, directly or through its Decision or Errand. */
async function issueOfSubject(tx: SQL, subject: CaseSubject): Promise<string | null> {
  if (subject.issue) return subject.issue
  if (subject.decision) {
    const [row]: { issue_id: string }[] =
      await tx`SELECT issue_id FROM factory.decisions WHERE id = ${subject.decision}`
    return row?.issue_id ?? null
  }
  if (subject.errand) {
    const [row]: { issue_id: string | null }[] =
      await tx`SELECT issue_id FROM factory.errands WHERE id = ${subject.errand}`
    return row?.issue_id ?? null
  }
  return null
}

/**
 * The Issue as filed: its title and the first signal's words (`text`), and the notes recorded while it settled (`facts`:
 * a plan row's facts, `issue new`'s text). The owner's later notes are their own part.
 */
async function issuePart(tx: SQL, id: string, title: string) {
  const [signal]: { text: string }[] = await tx`
    SELECT s.text FROM factory.intake_signals s WHERE s.issue_id = ${id} ORDER BY s.received_at LIMIT 1`
  const [settled]: { version: number | null }[] = await tx`
    SELECT min(version)::int AS version FROM factory.issue_events
    WHERE issue_id = ${id} AND kind = 'settled' AND result = 'applied'`
  const notes = (
    (await tx`
      SELECT version, actor, at, payload->>'text' AS text FROM factory.issue_events
      WHERE issue_id = ${id} AND kind = 'noted' AND result = 'applied' ORDER BY version`) as unknown[]
  ).map((raw) => NoteRow.parse(raw))
  const settledAt = settled?.version ?? Number.POSITIVE_INFINITY
  const filing = notes.filter((note) => note.version < settledAt)
  const owner = notes.filter(
    (note) => note.version > settledAt && (note.actor === 'owner' || note.actor === 'orchestrator'),
  )
  const text = [cut(title, CUT.title), cut(signal?.text, CUT.issueText)].filter(Boolean).join('\n\n')
  const facts = cut(filing.map((note) => note.text ?? '').join('\n\n'), CUT.facts)
  let room = CUT.notes
  const ownerNotes: { at: string; text: string }[] = []
  // The newest notes are the ones that steer: kept first, shown oldest first.
  for (const note of owner.toReversed()) {
    const said = cut(note.text, Math.min(CUT.note, room))
    if (!said) continue
    room -= said.length
    ownerNotes.unshift({ at: iso(note.at), text: said })
    if (room <= 0) break
  }
  return { issue: { text, facts }, ownerNotes }
}

/** The repo's open Issues but the subject's, newest first, with their first words and their open edges. */
async function openPart(tx: SQL, repo: string, excluding: string | null) {
  const rows: unknown[] = await tx`
    SELECT i.id, i.state, f.payload->>'title' AS title,
      COALESCE(
        (SELECT s.text FROM factory.intake_signals s WHERE s.issue_id = i.id ORDER BY s.received_at LIMIT 1),
        (SELECT n.payload->>'text' FROM factory.issue_events n
          WHERE n.issue_id = i.id AND n.kind = 'noted' AND n.result = 'applied' ORDER BY n.version LIMIT 1),
        '') AS summary,
      COALESCE((SELECT array_agg(e.after_issue ORDER BY e.after_issue) FROM factory.planning_edges e
        WHERE e.issue_id = i.id AND e.satisfied_at IS NULL), '{}') AS after,
      COALESCE((SELECT array_agg(e.issue_id ORDER BY e.issue_id) FROM factory.planning_edges e
        WHERE e.after_issue = i.id AND e.satisfied_at IS NULL), '{}') AS before
    FROM factory.issues i
    JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
    WHERE i.repo = ${repo} AND i.state <> 'closed' AND i.id <> ${excluding ?? ''}
    ORDER BY substring(i.id from 7)::int DESC LIMIT ${CUT.open}`
  return rows
    .map((raw) => OpenRow.parse(raw))
    .map((row) => ({
      id: row.id,
      title: cut(row.title, CUT.title),
      summary: cut(row.summary, CUT.summary),
      state: row.state,
      after: row.after.filter((id) => IssueIdText.test(id)),
      before: row.before.filter((id) => IssueIdText.test(id)),
    }))
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One plan row as text: its key, title and edges, and its facts (cut to `max`; 0 leaves them out). */
function rowText(row: Record<string, unknown>, max: number, mark = ''): string {
  const lines = [`- key: ${String(row.key)}${mark}`]
  if (typeof row.title === 'string') lines.push(`  title: ${row.title}`)
  if (typeof row.repo === 'string') lines.push(`  repo: ${row.repo}`)
  if (Array.isArray(row.after) && row.after.length) lines.push(`  after: [${row.after.map(String).join(', ')}]`)
  if (typeof row.after_needs === 'string') lines.push(`  after_needs: ${row.after_needs}`)
  if (max > 0 && isRecord(row.facts)) {
    lines.push('  facts:')
    for (const [name, value] of Object.entries(row.facts)) {
      const said = typeof value === 'string' ? value : JSON.stringify(value)
      lines.push(`    ${name}: ${said.replace(/\s*\n\s*/g, ' ')}`)
    }
  }
  return cut(lines.join('\n'), max > 0 ? max : CUT.neighbour)
}

/** The plan row the Issue was filed from, the rows it waits for and the rows that wait for it, from the synced plan. */
async function planPart(tx: SQL, issue: string): Promise<string | undefined> {
  const [raw]: unknown[] = await tx`
    SELECT r.project, r.row_key, p.plan FROM factory.planning_filed_rows r
    JOIN factory.planning_projects p ON p.name = r.project
    WHERE r.issue_id = ${issue}`
  if (!raw) return undefined
  const filed = FiledRow.parse(raw)
  const rows = isRecord(filed.plan) && Array.isArray(filed.plan.rows) ? filed.plan.rows.filter(isRecord) : []
  const own = rows.find((row) => row.key === filed.row_key)
  if (!own) return undefined
  const after = new Set(Array.isArray(own.after) ? own.after.map(String) : [])
  const before = rows.filter((row) => Array.isArray(row.after) && row.after.map(String).includes(filed.row_key))
  const neighbours = [...rows.filter((row) => after.has(String(row.key))), ...before]
  const parts = [
    `The plan of ${filed.project} (docs/plan.yaml), the row this Issue was filed from and its neighbours:`,
    rowText(own, CUT.planRow, ' (this Issue)'),
    ...neighbours.map((row) =>
      rowText(row, 0, after.has(String(row.key)) ? ' (this Issue waits for it)' : ' (waits for this Issue)'),
    ),
  ]
  return cut(parts.join('\n'), CUT.plan)
}

const CallRow = z.object({ call_issue: z.string().nullable(), claimed_at: z.date(), finished_at: z.date() })

/** A queue call's edges are the ones added while it ran, and this long after: the loop applies an answer once it has it. */
const QUEUE_APPLY_MS = 5 * 60_000

/**
 * Sets the outcome of triage and queue precedents from the edges the call added (`read/judgments.ts`: the ledger's own
 * expression): triage's are the edges of its Issue, the queue's are the repo's added while the call ran.
 */
async function withEdgeOutcomes(
  tx: SQL,
  judge: 'triage' | 'queue',
  rows: unknown[],
  repo: string,
  now: Date,
): Promise<unknown[]> {
  const calls = rows.map((raw) => ({ raw: raw as Record<string, unknown>, call: CallRow.parse(raw) }))
  if (calls.length === 0) return rows
  const issues =
    judge === 'triage'
      ? [...new Set(calls.flatMap(({ call }) => (call.call_issue ? [call.call_issue] : [])))]
      : undefined
  const from =
    judge === 'triage' ? new Date(0) : new Date(Math.min(...calls.map(({ call }) => call.claimed_at.getTime())))
  const edges = await edgeOutcomes(tx, {
    source: judge,
    from,
    to: now,
    issues,
    repo: judge === 'queue' ? repo : undefined,
  })
  return calls.map(({ raw, call }) => ({
    ...raw,
    outcome: callOutcome(
      edges.filter((edge) =>
        judge === 'triage'
          ? edge.issue === call.call_issue
          : edge.at >= call.claimed_at && edge.at.getTime() <= call.finished_at.getTime() + QUEUE_APPLY_MS,
      ),
    ),
  }))
}

/** This judge's earlier answers in the repo, newest first, each with what became of it (`read/judgments.ts`: `unknown` while it is too early to say). */
async function precedentsPart(tx: SQL, subject: CaseSubject, repo: string, issue: string | null, now: Date) {
  const limit = CUT.precedents
  let rows: unknown[] = []
  switch (subject.judge) {
    case 'judge':
      rows = await tx`
        SELECT j.at, d.question AS subject,
          CASE WHEN j.outcome = 'answered' THEN 'answered ' || COALESCE(d.answer, '') || ' (' || COALESCE(j.detail, '') || ')'
               WHEN j.outcome = 'back' THEN 'sent back to its lead: ' || COALESCE(j.detail, '')
               ELSE j.outcome || ' to the owner: ' || COALESCE(j.detail, '')
                 || CASE WHEN d.settled_by = 'owner' THEN '; the owner answered ' || d.answer ELSE '' END
          END AS answer, ${outcomeOf(tx, 'judge', now)} AS outcome
        FROM factory.decisions d
        JOIN factory.issues i ON i.id = d.issue_id
        JOIN factory.decision_steps j ON j.decision_id = d.id AND j.step = 'judge'
          AND j.outcome IN ('answered', 'passed', 'rejected', 'back')
        WHERE i.repo = ${repo} AND d.id <> ${subject.decision ?? ''}
        ORDER BY j.at DESC LIMIT ${limit}`
      break
    case 'steward':
    case 'triage':
    case 'queue': {
      // a steward call is judged by the stall it ended; a triage or queue call by the edges it added (set below)
      const outcome = subject.judge === 'steward' ? outcomeOf(tx, 'steward', now) : tx`'unknown'`
      rows = await tx`
        SELECT c.finished_at AS at,
          COALESCE((SELECT f.payload->>'title' FROM factory.issue_events f WHERE f.issue_id = c.issue_id AND f.kind = 'filed' AND f.version = 1) || ' (' || c.subject || ')', c.subject) AS subject,
          c.answer::text AS answer, ${outcome} AS outcome, c.issue_id AS call_issue, c.claimed_at, c.finished_at
        FROM factory.loop_calls c
        LEFT JOIN factory.issues i ON i.id = c.issue_id
        WHERE c.loop = ${subject.judge} AND c.outcome = 'answered' AND COALESCE(i.repo, c.repo) = ${repo}
          AND COALESCE(c.issue_id, '') <> ${issue ?? '-'}
        ORDER BY c.finished_at DESC LIMIT ${limit}`
      if (subject.judge !== 'steward') rows = await withEdgeOutcomes(tx, subject.judge, rows, repo, now)
      break
    }
    case 'screen':
      rows = await tx`
        SELECT s.screened_at AS at, s.title AS subject,
          s.state || CASE WHEN s.dismissed_by = 'judge' THEN ': ' || COALESCE(s.dismissed_reason, '') ELSE '' END
            || CASE WHEN s.screen_note IS NOT NULL THEN '; ' || s.screen_note ELSE '' END AS answer,
          ${outcomeOf(tx, 'screen', now)} AS outcome
        FROM factory.intake_signals s
        WHERE s.repo = ${repo} AND s.screened_at IS NOT NULL
        ORDER BY s.screened_at DESC LIMIT ${limit}`
      break
    case 'errand':
      rows = await tx`
        SELECT COALESCE(e.turned_away_at, e.reached_owner_at, e.raised_at) AS at, e.summary AS subject,
          CASE WHEN e.turned_away_at IS NOT NULL THEN 'turn_away' ELSE 'pass' END || ': ' || COALESCE(e.screen_note, '') AS answer,
          ${outcomeOf(tx, 'errand', now)} AS outcome
        FROM factory.errands e
        JOIN factory.issues i ON i.id = e.issue_id
        WHERE i.repo = ${repo} AND e.screen_by = 'judge' AND e.id <> ${subject.errand ?? ''}
        ORDER BY e.raised_at DESC LIMIT ${limit}`
      break
    case 'errandNeeded':
      rows = await tx`
        SELECT e.done_at AS at, e.summary AS subject, 'not_needed: ' || COALESCE(e.done_note, '') AS answer,
          ${outcomeOf(tx, 'errandNeeded', now)} AS outcome
        FROM factory.errands e
        JOIN factory.issues i ON i.id = e.issue_id
        WHERE i.repo = ${repo} AND e.closed_by = 'judge' AND e.closed_kind = 'not_needed'
        ORDER BY e.done_at DESC LIMIT ${limit}`
      break
  }
  return rows
    .map((raw) => PrecedentRow.parse(raw))
    .map((row) => ({
      at: row.at ? iso(row.at) : '',
      subject: cut(row.subject, CUT.precedent),
      answer: cut(row.answer, CUT.precedent),
      outcome: row.outcome,
    }))
    .filter((row) => row.subject !== '' && row.answer !== '')
}

/**
 * The parts of a case the database holds, for the subject a judgment request names. A subject whose Issue or repo the
 * factory does not know reads an empty case; the caller sends the request as it is.
 */
export function readCaseFile(sql: SQL, subject: CaseSubject, timeoutMs = 10_000, now = new Date()): Promise<CaseRead> {
  return boundedRead(sql, timeoutMs, async (tx) => {
    const issueId = await issueOfSubject(tx, subject)
    const [issueRaw]: unknown[] = issueId
      ? await tx`
          SELECT i.id, i.repo, f.payload->>'title' AS title FROM factory.issues i
          JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
          WHERE i.id = ${issueId}`
      : []
    const issue = issueRaw ? IssueRow.parse(issueRaw) : null
    const repo = issue?.repo ?? subject.repo ?? null
    const found: CaseRead = { repo, checkout: null, transcript: null, case: {} }
    if (issue && subject.judge === 'steward' && subject.attempt) {
      const [hook]: { path: string | null }[] = await tx`
        SELECT h.payload->>'transcriptPath' AS path FROM factory.lead_hook_events h
        WHERE h.session = ${`lead-${issue.id.slice('issue_'.length)}-${subject.attempt}`} AND h.payload->>'transcriptPath' IS NOT NULL
        ORDER BY h.at DESC, h.seq DESC LIMIT 1`
      found.transcript = hook?.path ?? null
    }
    if (issue) Object.assign(found.case, await issuePart(tx, issue.id, issue.title ?? ''))
    if (issue) {
      const plan = await planPart(tx, issue.id)
      if (plan) found.case.plan = plan
    }
    if (!repo) return found
    const [projectRaw]: unknown[] = await tx`SELECT repo, project FROM factory.planning_projects WHERE name = ${repo}`
    if (projectRaw) {
      const project = ProjectRow.parse(projectRaw)
      found.checkout = project.repo
      found.case.project = cut(JSON.stringify(project.project, null, 1), CUT.project)
    }
    found.case.open = await openPart(tx, repo, issue?.id ?? null)
    found.case.precedents = await precedentsPart(tx, subject, repo, issue?.id ?? null, now)
    return found
  })
}
