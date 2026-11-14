import type { SQL } from 'bun'
import * as z from 'zod'
import type { NeedItem, NeedKind, NeedsModel } from '@software-factory/contract'
import { RUN_STATUSES, STILL_NEEDED_NOTE, triedLine } from '../kernel/run.ts'
import { hostOf } from '../kernel/hands.ts'
import { readLongWaits } from './long-waits.ts'
import { screenPassed } from './spec-screen.ts'
import { DEFAULT_LONG_WAIT_MS } from './needs-settings.ts'
import { plain } from './words.ts'
import { isWorkRepo, loadOpenProjects, REDACTED_SUMMARY, REDACTED_TITLE } from './work.ts'

export { isWorkRepo, REDACTED_SUMMARY, REDACTED_TITLE }
export type { OpenProject } from './work.ts'

/** Waiting longer than this is stale. */
export const STALE_MS = 24 * 3_600_000

/** A need with the scope the redaction needs; the scope never leaves the server. */
export type ScopedNeed = Omit<NeedItem, 'redacted'> & { work: boolean }

export interface ScopedNeeds {
  at: Date
  items: ScopedNeed[]
}

const KIND_ORDER: readonly NeedKind[] = ['decision', 'review', 'errand', 'held_signal', 'long_wait']

/** The needs as the contract has them; for the read token every work-repo item loses its title and summary. */
export function needsModel(needs: ScopedNeeds, options: { redact: boolean }): NeedsModel {
  const items = needs.items.map(({ work, ...item }): NeedItem => {
    const hide = options.redact && work
    return {
      ...item,
      title: hide ? REDACTED_TITLE : item.title,
      summary: hide ? REDACTED_SUMMARY : item.summary,
      judge: hide ? null : item.judge,
      command: hide ? null : item.command,
      sourceLink: hide ? null : item.sourceLink,
      tried: hide ? null : item.tried,
      redacted: hide,
    }
  })
  const count = (kind: NeedKind) => items.filter((item) => item.kind === kind).length
  return {
    at: needs.at.toISOString(),
    items,
    counts: {
      decision: count('decision'),
      review: count('review'),
      errand: count('errand'),
      held_signal: count('held_signal'),
      long_wait: count('long_wait'),
    },
  }
}

/** A held signal's source in a person's word: the origin's, or what the tool watches; never the tool's own name. */
export function sourceWords(source: string, origin: string): string {
  if (source === 'kuma') return 'an uptime check'
  if (source === 'beszel') return 'the server monitor'
  if (source === 'launchd') return 'a background job'
  if (source === 'hyperdx') return 'the application'
  if (source === 'github' || source === 'checks') return 'GitHub'
  if (source.startsWith('feedback')) return 'feedback'
  if (source.startsWith('owner')) return 'you'
  return origin
}

const DecisionRow = z.object({
  id: z.string(),
  issue_id: z.string(),
  repo: z.string(),
  question: z.string(),
  artifact_id: z.string().nullable(),
  recommendation: z.string(),
  asked_at: z.date(),
  no_answer: z.object({ default: z.string().nullable().optional(), waitMinutes: z.number().nullable().optional() }),
  judge: z.string().nullable(),
  origin: z.string().nullable(),
})

const ReviewRow = z.object({
  issue_id: z.string(),
  repo: z.string(),
  artifact_id: z.string(),
  title: z.string().nullable(),
  kind: z.string().nullable(),
  summary: z.string().nullable(),
  at: z.date(),
  origin: z.string().nullable(),
})

const ErrandRow = z.object({
  id: z.string(),
  issue_id: z.string().nullable(),
  repo: z.string().nullable(),
  summary: z.string(),
  detail: z.string().nullable(),
  raised_at: z.date(),
  screen_note: z.string().nullable(),
  origin: z.string().nullable(),
  source: z.string().nullable(),
  command: z.string().nullable(),
  host: z.enum(['macbook', 'iphone', 'portal', 'any']).nullable(),
  run_status: z.enum(RUN_STATUSES).nullable(),
  run_exit: z.number().int().nullable(),
  run_at: z.date().nullable(),
  run_attempts: z.number().int(),
  run_head: z.string().nullable(),
  check_at: z.date().nullable(),
  check_note: z.string().nullable(),
})

/** What the last attempt at an Errand said, newest first: a run that came back unsuccessful, or a check that overruled a done. */
function triedOf(row: z.infer<typeof ErrandRow>): string | null {
  const run =
    row.run_status && row.run_at
      ? {
          at: row.run_at,
          line: triedLine({
            status: row.run_status,
            exit: row.run_exit,
            head: row.run_head ?? '',
            attempts: row.run_attempts,
          }),
        }
      : null
  const check =
    row.check_note?.startsWith(STILL_NEEDED_NOTE) && row.check_at ? { at: row.check_at, line: row.check_note } : null
  const latest = run && check ? (run.at.getTime() >= check.at.getTime() ? run : check) : (run ?? check)
  return latest ? plain(latest.line, 300) : null
}

const SignalRow = z.object({
  id: z.string(),
  repo: z.string().nullable(),
  title: z.string(),
  text: z.string(),
  received_at: z.date(),
  issue_id: z.string().nullable(),
  screen_note: z.string().nullable(),
  origin: z.string(),
  source: z.string(),
  link: z.string().nullable(),
})

/**
 * Everything that waits on the owner, newest first within a kind: Decisions that reached him (the owner's step is open),
 * Concepts and Specs under review, open Errands (a lead's, whose Issue is still open, and requests no Issue raised), held
 * signals, and the long timed waits other Issues wait behind (`longWaitMs` and up) whose time has passed. Read-only SQL.
 */
export async function readNeeds(sql: SQL, now: Date, options: { longWaitMs?: number } = {}): Promise<ScopedNeeds> {
  const open = await loadOpenProjects(sql)
  // A timer that is still running is information, not a request: Flow shows the waiting Issue. It reaches the owner only once
  // its time has passed and the Issue is still not awake.
  const longWaits = (await readLongWaits(sql, options.longWaitMs ?? DEFAULT_LONG_WAIT_MS)).filter(
    (wait) => Date.parse(wait.until) <= now.getTime(),
  )

  const decisions: unknown[] = await sql`
    SELECT d.id, d.issue_id, d.repo, d.question, d.artifact_id, d.recommendation, d.asked_at, d.no_answer,
      (SELECT j.detail FROM factory.decision_steps j WHERE j.decision_id = d.id AND j.step = 'judge') AS judge,
      (SELECT f.payload->>'origin' FROM factory.issue_events f WHERE f.issue_id = d.issue_id AND f.kind = 'filed' AND f.version = 1) AS origin
    FROM factory.decisions d
    WHERE d.answered_at IS NULL AND d.withdrawn_at IS NULL
      AND EXISTS (SELECT 1 FROM factory.decision_steps s WHERE s.decision_id = d.id AND s.step = 'owner' AND s.outcome = 'open')
    ORDER BY d.asked_at DESC, d.id DESC`
  // A Spec its filer attached holds its Issue in the queue, not in a wait: it is under review while it has no verdict on
  // its latest revision and the Issue has no lead yet (the same predicate as `spec_pending` in `read/planning.ts`).
  const reviews: unknown[] = await sql`
    SELECT * FROM (
      SELECT i.id AS issue_id, i.repo, e.wait->'holds'->>'id' AS artifact_id, a.title, a.kind,
        e.wait->'holds'->>'summary' AS summary, e.at,
        (SELECT f.payload->>'origin' FROM factory.issue_events f WHERE f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1) AS origin
      FROM factory.issues i
      JOIN LATERAL (
        SELECT x.wait, x.at FROM factory.issue_events x
        WHERE x.issue_id = i.id AND x.result = 'applied' ORDER BY x.version DESC LIMIT 1
      ) e ON true
      LEFT JOIN factory.artifacts a ON a.id = e.wait->'holds'->>'id'
      WHERE i.state = 'waiting' AND i.wait_reason = 'review' AND e.wait->>'verdictGiven' IS NULL
        AND ${screenPassed(sql)}
      UNION ALL
      SELECT i.id AS issue_id, i.repo, a.id AS artifact_id, a.title, a.kind, NULL::text AS summary, r.created_at AS at,
        (SELECT f.payload->>'origin' FROM factory.issue_events f WHERE f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1) AS origin
      FROM factory.artifacts a
      JOIN factory.issues i ON i.id = a.issue_id AND i.state IN ('settling', 'queued')
      JOIN LATERAL (
        SELECT n, created_at FROM factory.artifact_revisions WHERE artifact_id = a.id ORDER BY n DESC LIMIT 1
      ) r ON true
      WHERE a.key LIKE 'filed-spec:%'
        AND NOT EXISTS (SELECT 1 FROM factory.verdicts v WHERE v.artifact_id = a.id AND v.revision = r.n)
        AND ${screenPassed(sql)}
    ) reviews
    ORDER BY at DESC, issue_id DESC`
  const errands: unknown[] = await sql`
    SELECT r.id, r.issue_id, i.repo, r.summary, r.detail, r.raised_at, r.screen_note, r.source, r.command, r.host,
      r.run_status, r.run_exit, r.run_at, r.run_attempts, r.run_head, r.check_at, r.check_note,
      (SELECT f.payload->>'origin' FROM factory.issue_events f WHERE f.issue_id = r.issue_id AND f.kind = 'filed' AND f.version = 1) AS origin
    FROM factory.errands r LEFT JOIN factory.issues i ON i.id = r.issue_id
    WHERE r.done_at IS NULL AND r.reached_owner_at IS NOT NULL AND (r.issue_id IS NULL OR i.state <> 'closed')
    ORDER BY r.raised_at DESC, r.id DESC`
  const signals: unknown[] = await sql`
    SELECT id, repo, title, text, received_at, issue_id, screen_note, origin, source, link
    FROM factory.intake_signals WHERE state = 'held'
    ORDER BY received_at DESC, id DESC`

  const base = (since: Date) => ({
    since: since.toISOString(),
    ageMs: Math.max(0, now.getTime() - since.getTime()),
    stale: now.getTime() - since.getTime() > STALE_MS,
  })

  const items: ScopedNeed[] = [
    ...decisions.map((raw): ScopedNeed => {
      const row = DecisionRow.parse(raw)
      const wait = row.no_answer.default ? row.no_answer.waitMinutes : null
      return {
        ...base(row.asked_at),
        kind: 'decision',
        id: row.id,
        issue: row.issue_id,
        repo: row.repo,
        title: plain(row.question, 120),
        summary: plain(row.recommendation, 200),
        defaultAt: typeof wait === 'number' ? new Date(row.asked_at.getTime() + wait * 60_000).toISOString() : null,
        judge: row.judge === null ? null : plain(row.judge, 200),
        link: { type: 'decision', id: row.id },
        artifact: row.artifact_id,
        origin: row.origin,
        source: null,
        command: null,
        host: null,
        sourceLink: null,
        tried: null,
        wait: null,
        work: isWorkRepo(row.repo, open),
      }
    }),
    ...reviews.map((raw): ScopedNeed => {
      const row = ReviewRow.parse(raw)
      const noun = row.kind === 'spec' ? 'A spec' : row.kind === 'concept' ? 'A concept' : 'An artifact'
      return {
        ...base(row.at),
        kind: 'review',
        id: row.artifact_id,
        issue: row.issue_id,
        repo: row.repo,
        title: plain(row.title ?? row.summary ?? `${noun} waits for your verdict`, 120),
        summary: plain(row.summary ?? `${noun} waits for your verdict.`, 200),
        defaultAt: null,
        judge: null,
        link: { type: 'artifact', id: row.artifact_id },
        artifact: null,
        origin: row.origin,
        source: null,
        command: null,
        host: null,
        sourceLink: null,
        tried: null,
        wait: null,
        work: isWorkRepo(row.repo, open),
      }
    }),
    ...errands.map((raw): ScopedNeed => {
      const row = ErrandRow.parse(raw)
      return {
        ...base(row.raised_at),
        kind: 'errand',
        id: row.id,
        issue: row.issue_id,
        repo: row.repo,
        title: plain(row.summary, 120),
        summary: plain(row.detail ?? row.summary, 200),
        defaultAt: null,
        judge: row.screen_note === null ? null : plain(row.screen_note, 300),
        link: { type: 'errand', id: row.id },
        artifact: null,
        origin: row.origin,
        source: row.source,
        command: row.command,
        // a lead's Errand names no host: it is read from its words, as a request's is at intake
        host: row.host ?? hostOf(`${row.summary}\n${row.detail ?? ''}`),
        sourceLink: null,
        tried: triedOf(row),
        wait: null,
        // a request no Issue raised names no repo, so it may be about a work repo: the read token never sees its words
        work: row.repo === null || isWorkRepo(row.repo, open),
      }
    }),
    ...signals.map((raw): ScopedNeed => {
      const row = SignalRow.parse(raw)
      return {
        ...base(row.received_at),
        kind: 'held_signal',
        id: row.id,
        issue: row.issue_id,
        repo: row.repo,
        title: plain(row.title, 120),
        summary: plain(row.text, 200),
        defaultAt: null,
        judge: row.screen_note === null ? null : plain(row.screen_note, 300),
        link: { type: 'signal', id: row.id },
        artifact: null,
        origin: row.origin,
        source: sourceWords(row.source, row.origin),
        command: null,
        host: null,
        sourceLink: row.link,
        tried: null,
        wait: null,
        work: isWorkRepo(row.repo, open),
      }
    }),
    ...longWaits.map((wait): ScopedNeed => ({
      ...base(wait.since),
      kind: 'long_wait',
      id: wait.issue,
      issue: wait.issue,
      repo: wait.repo,
      title: plain(wait.title, 120),
      summary: `Deferred to a later time; ${wait.held === 1 ? '1 open Issue waits' : `${wait.held} open Issues wait`} behind it.`,
      defaultAt: null,
      judge: null,
      link: { type: 'issue', id: wait.issue },
      artifact: null,
      origin: wait.origin,
      source: null,
      command: null,
      host: null,
      sourceLink: null,
      tried: null,
      wait: { reason: 'timer', until: wait.until, held: wait.held },
      work: isWorkRepo(wait.repo, open),
    })),
  ]
  return { at: now, items: items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)) }
}
