/**
 * The import and the comparison, against a database: reads the old core's schema (`factory_legacy`, read only), writes the
 * new one (`factory`). One transaction per Issue; every write is keyed or `ON CONFLICT DO NOTHING`, so a second run changes
 * nothing, and a later run appends only what the old core recorded after the first (`import_issues.last_event`).
 */
import { join } from 'node:path'
import type { SQL } from 'bun'
import { fileBlobStore } from '../../src/adapters/blobs/filesystem.ts'
import { postgresWorkStore } from '../../src/adapters/postgres/work-store.ts'
import { artifactOfDecision } from '../../src/app/checkpoints.ts'
import { renderDecisionForm } from '../../src/domains/checkpoints/artifact.ts'
import type { DecisionId } from '../../src/domains/checkpoints/decision.ts'
import type { StoredEvent } from '../../src/domains/work/ports.ts'
import type { EventId, IssueId } from '../../src/kernel/ids.ts'
import { issueId } from '../../src/kernel/ids.ts'
import type { Key } from '../../src/kernel/keys.ts'
import {
  type DecisionRow,
  type Entry,
  type LegacyDecision,
  type LegacyEvent,
  type LegacyIssue,
  type Plan,
  planIssue,
  repoName,
} from './plan.ts'

const IDENT = /^[a-z_][a-z0-9_]*$/

export interface ImportOptions {
  sql: SQL
  /** the old core's schema, read only */
  legacySchema: string
  /** the factory's data directory: the Decisions' forms are written under it */
  dataDir: string
  /** now: the time a claim or a row made by the import is stamped with */
  now: Date
}

export interface IssueResult {
  legacyId: number
  result: 'imported' | 'appended' | 'unchanged' | 'diverged' | 'conflict'
  detail?: string
}

export interface ImportReport {
  issues: IssueResult[]
  /** old event kinds by what became of them */
  kinds: { kind: string; disposition: string; count: number }[]
  notes: string[]
  /** what the machine said to the mapped events: applied, or refused or ignored with the reason (grouped) */
  machine: { applied: number; refused: number; ignored: number; reasons: { reason: string; count: number }[] }
  sequence: number
  claims: number
  edges: number
  planRows: number
  door: { routes: number; sources: number; unrouted: number; subjects: number; seen: number }
}

const schema = (name: string): string => {
  if (!IDENT.test(name)) throw new Error(`not a schema name: ${name}`)
  return name
}

const num = (value: unknown): number => Number(value)
const dateOf = (value: unknown): Date | null => (value instanceof Date ? value : value ? new Date(String(value)) : null)

function legacyIssue(row: Record<string, unknown>): LegacyIssue {
  return {
    id: num(row.id),
    state: String(row.state),
    reason: (row.reason as string | null) ?? null,
    source: String(row.source),
    sourceKey: String(row.source_key),
    repo: String(row.repo),
    title: String(row.title),
    facts: row.facts,
    kind: (row.kind as string | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    attempt: num(row.attempt),
    createdAt: dateOf(row.created_at) ?? new Date(0),
    closedAt: dateOf(row.closed_at),
  }
}

const legacyEvent = (row: Record<string, unknown>): LegacyEvent => ({
  id: num(row.id),
  kind: String(row.kind),
  from: (row.from_state as string | null) ?? null,
  to: (row.to_state as string | null) ?? null,
  at: dateOf(row.at) ?? new Date(0),
  payload: typeof row.payload === 'object' && row.payload !== null ? (row.payload as Record<string, unknown>) : null,
})

const legacyDecision = (row: Record<string, unknown>): LegacyDecision => ({
  id: num(row.id),
  question: String(row.question),
  options: row.options,
  defaultOption: (row.default_option as string | null) ?? null,
  expiresAt: dateOf(row.expires_at),
  answer: (row.answer as string | null) ?? null,
  answeredBy: (row.answered_by as string | null) ?? null,
  answeredAt: dateOf(row.answered_at),
  createdAt: dateOf(row.created_at) ?? new Date(0),
})

/** The old core's Issues, events and decisions, grouped by Issue. */
export async function readLegacy(sql: SQL, legacy: string) {
  const L = schema(legacy)
  const issues = (await sql.unsafe(`SELECT * FROM ${L}.issues ORDER BY id`)) as Record<string, unknown>[]
  const events = (await sql.unsafe(
    `SELECT id::int AS id, issue_id, kind, from_state, to_state, at, payload FROM ${L}.issue_events ORDER BY issue_id, id`,
  )) as Record<string, unknown>[]
  const decisions = (await sql.unsafe(`SELECT * FROM ${L}.decisions ORDER BY issue_id, id`)) as Record<
    string,
    unknown
  >[]
  const eventsOf = new Map<number, LegacyEvent[]>()
  for (const row of events)
    eventsOf.set(num(row.issue_id), [...(eventsOf.get(num(row.issue_id)) ?? []), legacyEvent(row)])
  const decisionsOf = new Map<number, LegacyDecision[]>()
  for (const row of decisions) {
    decisionsOf.set(num(row.issue_id), [...(decisionsOf.get(num(row.issue_id)) ?? []), legacyDecision(row)])
  }
  return issues.map((row) => {
    const issue = legacyIssue(row)
    return { issue, events: eventsOf.get(issue.id) ?? [], decisions: decisionsOf.get(issue.id) ?? [] }
  })
}

const storedOf = (id: IssueId, entry: Entry, at: number): StoredEvent => {
  const decided = entry.decided
  const applied = decided.result === 'applied'
  return {
    id: `event_import-${id.slice('issue_'.length)}-${at}` as EventId,
    issueId: id,
    key: entry.key as Key,
    kind: entry.event.kind as StoredEvent['kind'],
    payload: entry.event.payload,
    actor: entry.actor,
    at: entry.at,
    version: applied ? decided.issue.version : null,
    causation: null,
    result: decided.result,
    detail: applied ? null : decided.detail,
    from: entry.from,
    transition: applied ? decided.transition : null,
  }
}

/** The Decisions' forms as blobs, written before the transaction (a blob is its content: a repeat writes nothing twice). */
async function blobsOf(dataDir: string, decisions: readonly DecisionRow[]) {
  const store = fileBlobStore(join(dataDir, 'blobs'))
  const out = new Map<string, { path: string; sha256: string; bytes: number }>()
  for (const d of decisions) {
    const put = await store.put(
      renderDecisionForm({
        question: d.question,
        recommendation: d.recommendation,
        checked: d.checked,
        options: d.options,
        noAnswer: d.noAnswer,
      }),
    )
    if (!put.ok) throw new Error(`decision ${d.id}: ${put.error.detail}`)
    out.set(d.id, put.value)
  }
  return out
}

async function writeSide(
  tx: SQL,
  id: IssueId,
  repo: string,
  plan: Plan,
  blobs: Map<string, { path: string; sha256: string; bytes: number }>,
): Promise<void> {
  for (const d of plan.decisions) {
    await tx`
      INSERT INTO factory.decisions
        (id, key, issue_id, repo, attempt, question, recommendation, checked, options, no_answer, asked_at, answer,
         settled_by, source, answered_at, withdrawn_at, withdrawn_reason)
      VALUES (${d.id}, ${d.key}, ${id}, ${repo}, ${d.attempt}, ${d.question}, ${d.recommendation}, ${d.checked},
              ${d.options}, ${d.noAnswer}, ${d.askedAt}, ${d.answer},
              ${d.settledBy}, ${d.source}, ${d.answeredAt}, ${d.withdrawnAt}, ${d.withdrawnReason})
      ON CONFLICT (id) DO NOTHING`
    const artifact = artifactOfDecision(d.id as DecisionId)
    const blob = blobs.get(d.id)
    if (!blob) throw new Error(`decision ${d.id} has no blob`)
    await tx`
      INSERT INTO factory.artifacts (id, key, issue_id, kind, title, format, author, created_at)
      VALUES (${artifact}, ${`import:artifact:${d.id}`}, ${id}, 'decision', ${d.question.slice(0, 200)}, 'markdown', 'factory', ${d.askedAt})
      ON CONFLICT (id) DO NOTHING`
    await tx`
      INSERT INTO factory.artifact_revisions (artifact_id, n, key, blob, sha256, bytes, note, created_at)
      VALUES (${artifact}, 1, ${`import:revision:${d.id}`}, ${blob.path}, ${blob.sha256}, ${blob.bytes}, NULL, ${d.askedAt})
      ON CONFLICT (artifact_id, n) DO NOTHING`
  }
  for (const s of plan.decisionSteps) {
    await tx`
      INSERT INTO factory.decision_steps (decision_id, step, claimed_until, outcome, detail, at)
      VALUES (${s.decisionId}, ${s.step}, NULL, ${s.outcome}, ${s.detail}, ${s.at})
      ON CONFLICT (decision_id, step) DO NOTHING`
  }
  for (const s of plan.ships) {
    await tx`
      INSERT INTO factory.quality_ships (id, issue_id, attempt, event_key, at, result, detail, reported)
      VALUES (${s.id}, ${id}, ${s.attempt}, ${s.eventKey}, ${s.at}, ${s.result}, ${s.detail}, ${s.reported})
      ON CONFLICT (id) DO NOTHING`
  }
  for (const e of plan.evidence) {
    await tx`
      INSERT INTO factory.quality_evidence (id, issue_id, attempt, source_key, kind, at, payload)
      VALUES (${e.id}, ${id}, ${e.attempt}, ${e.sourceKey}, ${e.kind}, ${e.at}, ${e.payload})
      ON CONFLICT (id) DO NOTHING`
  }
  for (const w of plan.watches) {
    await tx`
      INSERT INTO factory.quality_watches (key, issue_id, attempt, watch, started_at, window_ms, answer, answered_at)
      VALUES (${w.key}, ${id}, ${w.attempt}, ${w.watch}, ${w.startedAt}, ${w.windowMs}, ${w.answer}, ${w.answeredAt})
      ON CONFLICT (key) DO UPDATE SET answer = EXCLUDED.answer, answered_at = EXCLUDED.answered_at
        WHERE factory.quality_watches.answer IS NULL`
  }
  for (const c of plan.checks) {
    await tx`
      INSERT INTO factory.quality_checks (watch_key, n, at, outcome, checks)
      VALUES (${c.watchKey}, ${c.n}, ${c.at}, ${c.outcome}, ${c.checks})
      ON CONFLICT (watch_key, n) DO NOTHING`
  }
  for (const p of plan.prios) {
    await tx`
      INSERT INTO factory.planning_prios (key, issue_id, value, actor, at)
      VALUES (${p.key}, ${id}, ${p.value}, ${p.actor}, ${p.at})
      ON CONFLICT (key) DO NOTHING`
  }
  if (plan.writeback) {
    await tx`
      INSERT INTO factory.intake_writebacks (issue_id, result, at)
      VALUES (${id}, ${plan.writeback.result}, ${plan.writeback.at})
      ON CONFLICT (issue_id) DO NOTHING`
  }
  for (const f of plan.finalizations) {
    await tx`
      INSERT INTO factory.lead_finalizations
        (issue_id, attempt, claim_at, terminals_at, transcripts_at, worktree_at, archived, worktree_kept, worktree_path, done_at)
      VALUES (${id}, ${f.attempt}, ${f.at}, ${f.at}, ${f.at}, ${f.at}, 0, ${f.worktreeKept}, ${f.worktreePath}, ${f.at})
      ON CONFLICT (issue_id, attempt) DO NOTHING`
  }
}

async function writeDispositions(tx: SQL, legacyId: number, plan: Plan, after: number): Promise<void> {
  for (const d of plan.dispositions) {
    if (d.legacyEvent <= after) continue
    await tx`
      INSERT INTO factory.import_events (legacy_event, legacy_issue, kind, disposition, reason, keys)
      VALUES (${d.legacyEvent}, ${legacyId}, ${d.kind}, ${d.disposition}, ${d.reason}, string_to_array(${d.keys.join('\u0001')}, chr(1)))
      ON CONFLICT (legacy_event) DO NOTHING`
  }
}

async function importOne(
  opts: ImportOptions,
  source: { issue: LegacyIssue; events: LegacyEvent[]; decisions: LegacyDecision[] },
): Promise<IssueResult> {
  const { sql } = opts
  const legacyId = source.issue.id
  const id = issueId(legacyId)
  const plan = planIssue(source.issue, source.events, source.decisions)
  const lastEvent = source.events.reduce((max, e) => Math.max(max, e.id), 0)
  const blobs = await blobsOf(opts.dataDir, plan.decisions)
  const repo = repoName(source.issue.repo)

  return sql.begin(async (tx): Promise<IssueResult> => {
    const work = postgresWorkStore(tx)
    const [ledger] =
      (await tx`SELECT last_event::int AS last_event, carried_version FROM factory.import_issues WHERE legacy_id = ${legacyId}`) as {
        last_event: number
        carried_version: number
      }[]

    if (!ledger) {
      const [taken] = await tx`SELECT 1 FROM factory.issues WHERE id = ${id}`
      if (taken)
        return { legacyId, result: 'conflict', detail: `${id} exists and was not imported: the number is taken` }
      await work.insertIssue(plan.issue)
      for (const [at, entry] of plan.entries.entries()) {
        if (!(await work.appendEvent(storedOf(id, entry, at))))
          throw new Error(`event key ${entry.key} is stored already`)
      }
      await writeSide(tx, id, repo, plan, blobs)
      await writeDispositions(tx, legacyId, plan, -1)
      await tx`
        INSERT INTO factory.import_issues (issue_id, legacy_id, imported_at, last_event, carried_version)
        VALUES (${id}, ${legacyId}, ${opts.now}, ${lastEvent}, ${plan.issue.version})`
      return { legacyId, result: 'imported' }
    }

    if (lastEvent <= ledger.last_event) return { legacyId, result: 'unchanged' }
    const [current] = (await tx`SELECT version FROM factory.issues WHERE id = ${id} FOR UPDATE`) as {
      version: number
    }[]
    if (!current || current.version !== ledger.carried_version) {
      return {
        legacyId,
        result: 'diverged',
        detail: `the new core recorded events on ${id} (version ${current?.version ?? '?'} after ${ledger.carried_version}) and the old core recorded more (events after ${ledger.last_event}): neither is merged`,
      }
    }
    const stored = (await tx`SELECT key FROM factory.issue_events WHERE issue_id = ${id}`) as { key: string }[]
    const planned = new Set(plan.entries.map((e) => e.key))
    if (stored.some((s) => !planned.has(s.key))) {
      return {
        legacyId,
        result: 'diverged',
        detail: `${id}: its stored import events are not a prefix of the new plan`,
      }
    }
    const have = new Set(stored.map((s) => s.key))
    for (const [at, entry] of plan.entries.entries()) {
      if (have.has(entry.key)) continue
      if (!(await work.appendEvent(storedOf(id, entry, at))))
        throw new Error(`event key ${entry.key} is stored already`)
    }
    if (!(await work.updateIssue(plan.issue, current.version)))
      throw new Error(`${id}: the version moved during the import`)
    await writeSide(tx, id, repo, plan, blobs)
    await writeDispositions(tx, legacyId, plan, ledger.last_event)
    await tx`
      UPDATE factory.import_issues SET last_event = ${lastEvent}, carried_version = ${plan.issue.version}, imported_at = ${opts.now}
      WHERE legacy_id = ${legacyId}`
    return { legacyId, result: 'appended' }
  })
}

/** The chain, the plan rows filed, claims of working Issues and the door's registry: everything that is not a per-Issue transaction. */
async function importAround(
  opts: ImportOptions,
  sources: Awaited<ReturnType<typeof readLegacy>>,
): Promise<Omit<ImportReport, 'issues' | 'kinds' | 'notes' | 'machine'>> {
  const { sql } = opts
  const L = schema(opts.legacySchema)
  const imported = new Set(
    ((await sql`SELECT legacy_id FROM factory.import_issues`) as { legacy_id: number }[]).map((r) => num(r.legacy_id)),
  )
  const byId = new Map(sources.map((s) => [s.issue.id, s.issue]))

  let edges = 0
  const deps = (await sql.unsafe(`SELECT issue_id, on_issue FROM ${L}.issue_deps`)) as {
    issue_id: number
    on_issue: number
  }[]
  for (const dep of deps) {
    const issue = byId.get(num(dep.issue_id))
    const blocker = byId.get(num(dep.on_issue))
    if (!issue || !blocker || !imported.has(issue.id) || !imported.has(blocker.id)) continue
    const rows = await sql`
      INSERT INTO factory.planning_edges (issue_id, after_issue, created_at, satisfied_at)
      VALUES (${issueId(issue.id)}, ${issueId(blocker.id)}, ${issue.createdAt}, ${blocker.state === 'closed' ? (blocker.closedAt ?? opts.now) : null})
      ON CONFLICT (issue_id, after_issue) DO NOTHING
      RETURNING issue_id`
    edges += rows.length
  }

  let planRows = 0
  for (const s of sources) {
    if (s.issue.source !== 'plan' || !imported.has(s.issue.id)) continue
    const at = s.issue.sourceKey.indexOf(':')
    if (at < 1) continue
    const rows = await sql`
      INSERT INTO factory.planning_filed_rows (project, row_key, issue_id, filed_at)
      VALUES (${s.issue.sourceKey.slice(0, at)}, ${s.issue.sourceKey.slice(at + 1)}, ${issueId(s.issue.id)}, ${s.issue.createdAt})
      ON CONFLICT (project, row_key) DO NOTHING
      RETURNING project`
    planRows += rows.length
  }

  // A working Issue holds its repo's claim, or it blocks the repo (report 3, open point 3).
  let claims = 0
  for (const s of sources) {
    if (s.issue.state !== 'working' || !imported.has(s.issue.id)) continue
    const rows = await sql`
      INSERT INTO factory.capacity_claims (issue_id, repo, urgent, account, taken_at)
      VALUES (${issueId(s.issue.id)}, ${repoName(s.issue.repo)}, false, NULL, ${opts.now})
      ON CONFLICT (issue_id) DO NOTHING
      RETURNING issue_id`
    claims += rows.length
  }

  const count = async (query: string): Promise<number> => ((await sql.unsafe(query)) as unknown[]).length
  const door = {
    routes: await count(`
      INSERT INTO factory.intake_door_routes (source, monitor, repo, quiet, last_quiet_at, last_event)
      SELECT source, monitor, regexp_replace(repo, '^.*/', ''), quiet, last_quiet_at, last_event FROM ${L}.door_routes
      ON CONFLICT (source, monitor) DO NOTHING RETURNING source`),
    sources: await count(`
      INSERT INTO factory.intake_door_sources (source, first_seen, last_accepted, refused, refused_since, last_refused)
      SELECT source, first_seen, last_accepted, refused, refused_since, last_refused FROM ${L}.door_sources
      ON CONFLICT (source) DO NOTHING RETURNING source`),
    unrouted: await count(`
      INSERT INTO factory.intake_door_unrouted
        (source, monitor, count, last_seen, last_title, last_event, status, down_since, is_group, filed_at, filed_issue)
      SELECT source, monitor, count, last_seen, last_title, last_event, status, down_since, is_group, filed_at,
             CASE WHEN filed_issue IS NULL THEN NULL ELSE 'issue_' || filed_issue END FROM ${L}.door_unrouted
      ON CONFLICT (source, monitor) DO NOTHING RETURNING source`),
    subjects: await count(`
      INSERT INTO factory.intake_subjects (source, subject, fingerprint, issue_id, group_key, filed_at, last_seen, repeats, up_at, writeback)
      SELECT d.source, d.monitor, d.fingerprint, 'issue_' || d.issue_id, NULL, i.created_at, COALESCE(d.last_seen, i.created_at), d.repeats, NULL, false
      FROM ${L}.door_issues d JOIN ${L}.issues i ON i.id = d.issue_id
      WHERE EXISTS (SELECT 1 FROM factory.import_issues m WHERE m.legacy_id = d.issue_id)
      ON CONFLICT (issue_id, source, subject) DO NOTHING RETURNING source`),
    seen: await count(`
      INSERT INTO factory.intake_seen (key, seen_at) SELECT key, seen_at FROM ${L}.intake_seen
      ON CONFLICT (key) DO NOTHING RETURNING key`),
  }

  // A new Issue never takes an old number (0002_work.sql): the sequence is moved past the largest of both cores.
  const [bump] = (await sql`
    SELECT setval('factory.issue_numbers', GREATEST(
      (SELECT COALESCE(max(substr(id, 7)::int), 0) FROM factory.issues),
      (SELECT COALESCE(max(last_value), 1) FROM pg_sequences WHERE schemaname = 'factory' AND sequencename = 'issue_numbers')
    ), true) AS value`) as { value: number }[]
  return { sequence: num(bump?.value), claims, edges, planRows, door }
}

/** Imports every Issue of the old core and what hangs off them. Safe to run again. */
export async function importLegacy(opts: ImportOptions): Promise<ImportReport> {
  const sources = await readLegacy(opts.sql, opts.legacySchema)
  const issues: IssueResult[] = []
  for (const source of sources) issues.push(await importOne(opts, source))
  const around = await importAround(opts, sources)
  const kinds = (await opts.sql`
    SELECT kind, disposition, count(*)::int AS count FROM factory.import_events GROUP BY 1, 2 ORDER BY 1, 2`) as ImportReport['kinds']
  const plans = sources.map((s) => planIssue(s.issue, s.events, s.decisions))
  const notes = plans.flatMap((plan) => plan.notes)
  const machine: ImportReport['machine'] = { applied: 0, refused: 0, ignored: 0, reasons: [] }
  const reasons = new Map<string, number>()
  for (const entry of plans.flatMap((plan) => plan.entries)) {
    machine[entry.decided.result]++
    if (entry.decided.result !== 'applied') {
      const why = `${entry.event.kind} ${entry.decided.result}: ${entry.decided.detail.replace(/\d+/g, 'N')}`
      reasons.set(why, (reasons.get(why) ?? 0) + 1)
    }
  }
  machine.reasons = [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count)
  return { issues, kinds, notes, machine, ...around }
}

export interface Mismatch {
  legacyId: number
  field: 'state' | 'wait' | 'attempt' | 'outcome' | 'missing'
  old: string
  new: string
  /** why the two differ and that is right; null is unexplained, which fails the rehearsal */
  reason: string | null
}

export interface CompareReport {
  compared: number
  matching: number
  explained: Mismatch[]
  unexplained: Mismatch[]
  /** old events with no disposition in the ledger */
  undisposed: number
  /** Issues the new core has worked since the import: their state is its own */
  carried: number
}

const WAIT_OF_REASON: Record<string, string> = {
  wait: 'timer',
  blocked: 'blocked',
  decision: 'decision',
  unreported: 'unreported',
  lead_gone: 'lead_gone',
  wall: 'wall',
  dependency: 'dependency',
  parked: 'regressed',
}

/** Old against new for every imported Issue: the state, the wait, the attempt and the outcome. */
export async function compareLegacy(opts: Pick<ImportOptions, 'sql' | 'legacySchema'>): Promise<CompareReport> {
  const { sql } = opts
  const L = schema(opts.legacySchema)
  const rows = (await sql.unsafe(`
    SELECT o.id AS legacy_id, o.state AS old_state, o.reason AS old_reason, o.attempt AS old_attempt, o.outcome AS old_outcome,
           n.state AS new_state, n.wait_reason AS new_wait, n.outcome AS new_outcome, n.version,
           m.carried_version,
           (SELECT count(*)::int FROM factory.issue_events e WHERE e.issue_id = n.id AND e.kind = 'admitted' AND e.result = 'applied') AS new_attempt,
           (SELECT count(*)::int FROM factory.issue_events e WHERE e.issue_id = n.id AND e.key LIKE '%:forced-close') AS forced,
           (SELECT e.kind FROM ${L}.issue_events e WHERE e.issue_id = o.id AND e.to_state = 'closed' ORDER BY e.id DESC LIMIT 1) AS closed_by
    FROM ${L}.issues o
    LEFT JOIN factory.import_issues m ON m.legacy_id = o.id
    LEFT JOIN factory.issues n ON n.id = m.issue_id
    ORDER BY o.id`)) as Record<string, unknown>[]

  const explained: Mismatch[] = []
  const unexplained: Mismatch[] = []
  let matching = 0
  let carried = 0
  for (const r of rows) {
    const legacyId = num(r.legacy_id)
    const push = (field: Mismatch['field'], old: string, now: string, reason: string | null) =>
      (reason ? explained : unexplained).push({ legacyId, field, old, new: now, reason })
    if (r.new_state === null || r.new_state === undefined) {
      push('missing', String(r.old_state), 'not imported', null)
      continue
    }
    if (num(r.version) !== num(r.carried_version)) {
      carried++
      continue
    }
    const forced = num(r.forced) > 0
    let ok = true
    const oldState = String(r.old_state)
    const newState = String(r.new_state)
    if (oldState !== newState) {
      ok = false
      const claim = oldState === 'waiting' && r.old_reason === 'claim' && newState === 'working'
      push(
        'state',
        oldState,
        newState,
        claim ? "the old claim wait is capacity's in the new core: the Issue is working" : null,
      )
    } else if (oldState === 'waiting') {
      const want = WAIT_OF_REASON[String(r.old_reason)] ?? String(r.old_reason)
      if (want !== r.new_wait) {
        ok = false
        const parked = r.old_reason === 'parked' && (r.new_wait === 'blocked' || r.new_wait === 'regressed')
        push(
          'wait',
          String(r.old_reason),
          String(r.new_wait),
          parked ? 'the old park is a regressed or blocked stall' : null,
        )
      }
    }
    if (num(r.old_attempt) !== num(r.new_attempt)) {
      ok = false
      push('attempt', String(r.old_attempt), String(r.new_attempt), null)
    }
    if (oldState === 'closed' && newState === 'closed') {
      const wantOutcome = r.closed_by === 'stop' ? 'cancelled' : String(r.old_outcome)
      if (wantOutcome !== r.new_outcome) {
        ok = false
        push(
          'outcome',
          String(r.old_outcome),
          String(r.new_outcome),
          forced ? 'closed by force: the new machine did not take the old events' : null,
        )
      } else if (r.closed_by === 'stop') {
        ok = false
        push(
          'outcome',
          String(r.old_outcome),
          String(r.new_outcome),
          "a stop closed as dropped in the old core; the language's Cancel is cancelled",
        )
      }
    }
    if (ok) matching++
  }
  const [undisposed] = (await sql.unsafe(`
    SELECT count(*)::int AS n FROM ${L}.issue_events e
    WHERE NOT EXISTS (SELECT 1 FROM factory.import_events i WHERE i.legacy_event = e.id)
      AND EXISTS (SELECT 1 FROM factory.import_issues m WHERE m.legacy_id = e.issue_id)`)) as { n: number }[]
  return { compared: rows.length, matching, explained, unexplained, undisposed: num(undisposed?.n), carried }
}
