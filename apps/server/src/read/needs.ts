import type { SQL } from 'bun'
import * as z from 'zod'
import type { NeedItem, NeedKind, NeedsModel } from '@software-factory/contract'
import { readLongWaits } from './long-waits.ts'
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
      sourceLink: hide ? null : item.sourceLink,
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
  issue_id: z.string(),
  repo: z.string(),
  summary: z.string(),
  detail: z.string().nullable(),
  raised_at: z.date(),
  screen_note: z.string().nullable(),
  origin: z.string().nullable(),
})

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
 * Concepts and Specs under review, open Errands of Issues still open, held signals, and the long timed waits other Issues
 * wait behind (`longWaitMs` and up). Read-only SQL.
 */
export async function readNeeds(sql: SQL, now: Date, options: { longWaitMs?: number } = {}): Promise<ScopedNeeds> {
  const open = await loadOpenProjects(sql)
  const longWaits = await readLongWaits(sql, options.longWaitMs ?? DEFAULT_LONG_WAIT_MS)

  const decisions: unknown[] = await sql`
    SELECT d.id, d.issue_id, d.repo, d.question, d.artifact_id, d.recommendation, d.asked_at, d.no_answer,
      (SELECT j.detail FROM factory.decision_steps j WHERE j.decision_id = d.id AND j.step = 'judge') AS judge,
      (SELECT f.payload->>'origin' FROM factory.issue_events f WHERE f.issue_id = d.issue_id AND f.kind = 'filed' AND f.version = 1) AS origin
    FROM factory.decisions d
    WHERE d.answered_at IS NULL AND d.withdrawn_at IS NULL
      AND EXISTS (SELECT 1 FROM factory.decision_steps s WHERE s.decision_id = d.id AND s.step = 'owner' AND s.outcome = 'open')
    ORDER BY d.asked_at DESC, d.id DESC`
  const reviews: unknown[] = await sql`
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
    ORDER BY e.at DESC, i.id DESC`
  const errands: unknown[] = await sql`
    SELECT r.id, r.issue_id, i.repo, r.summary, r.detail, r.raised_at, r.screen_note,
      (SELECT f.payload->>'origin' FROM factory.issue_events f WHERE f.issue_id = r.issue_id AND f.kind = 'filed' AND f.version = 1) AS origin
    FROM factory.errands r JOIN factory.issues i ON i.id = r.issue_id
    WHERE r.done_at IS NULL AND r.reached_owner_at IS NOT NULL AND i.state <> 'closed'
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
        sourceLink: null,
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
        sourceLink: null,
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
        source: null,
        sourceLink: null,
        wait: null,
        work: isWorkRepo(row.repo, open),
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
        sourceLink: row.link,
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
      sourceLink: null,
      wait: { reason: 'timer', until: wait.until, held: wait.held },
      work: isWorkRepo(wait.repo, open),
    })),
  ]
  return { at: now, items: items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)) }
}
