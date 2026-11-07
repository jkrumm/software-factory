import type { SQL } from 'bun'
import * as z from 'zod'
import type { NeedItem, NeedKind, NeedsModel } from '@software-factory/contract'
import { plain } from './words.ts'

/** Waiting longer than this is stale. */
export const STALE_MS = 24 * 3_600_000

/** What a work-repo item says under the read token: the ids, kinds and times stay, the words go. */
export const REDACTED_TITLE = 'Work in a private repository'
export const REDACTED_SUMMARY = 'The text of work in a private repository is not shown here.'

/** A project the factory reads from its own `project.yaml`: its repo text is the owner's, not the work account's. */
export interface OpenProject {
  name: string
  repo: string
}

/**
 * Whether a repo is a work repo: it belongs to no project with a `project.yaml` of its own (a project with defaults, or
 * a repo the factory does not know). Fails closed: text of a repo nobody listed is not shown to the read token.
 */
export function isWorkRepo(repo: string | null, open: readonly OpenProject[]): boolean {
  if (repo === null) return false
  return !open.some((p) => p.name === repo || p.repo === repo || repo.startsWith(`${p.repo}/`))
}

/** A need with the scope the redaction needs; the scope never leaves the server. */
export type ScopedNeed = Omit<NeedItem, 'redacted'> & { work: boolean }

export interface ScopedNeeds {
  at: Date
  items: ScopedNeed[]
}

const KIND_ORDER: readonly NeedKind[] = ['decision', 'review', 'errand', 'held_signal']

/** The needs as the contract has them; for the read token every work-repo item loses its title and summary. */
export function needsModel(needs: ScopedNeeds, options: { redact: boolean }): NeedsModel {
  const items = needs.items.map(({ work, ...item }): NeedItem => {
    const hide = options.redact && work
    return {
      ...item,
      title: hide ? REDACTED_TITLE : item.title,
      summary: hide ? REDACTED_SUMMARY : item.summary,
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
    },
  }
}

const DecisionRow = z.object({
  id: z.string(),
  issue_id: z.string(),
  repo: z.string(),
  question: z.string(),
  recommendation: z.string(),
  asked_at: z.date(),
  no_answer: z.object({ default: z.string().nullable().optional(), waitMinutes: z.number().nullable().optional() }),
})

const ReviewRow = z.object({
  issue_id: z.string(),
  repo: z.string(),
  artifact_id: z.string(),
  title: z.string().nullable(),
  kind: z.string().nullable(),
  summary: z.string().nullable(),
  at: z.date(),
})

const ErrandRow = z.object({
  id: z.string(),
  issue_id: z.string(),
  repo: z.string(),
  summary: z.string(),
  detail: z.string().nullable(),
  raised_at: z.date(),
})

const SignalRow = z.object({
  id: z.string(),
  repo: z.string().nullable(),
  title: z.string(),
  text: z.string(),
  received_at: z.date(),
  issue_id: z.string().nullable(),
})

const Project = z.object({ name: z.string(), repo: z.string() })

/**
 * Everything that waits on the owner, newest first within a kind: Decisions that reached him (the owner's step is open),
 * Concepts and Specs under review, open Errands of Issues still open, and held signals. Read-only SQL.
 */
export async function readNeeds(sql: SQL, now: Date): Promise<ScopedNeeds> {
  const open: OpenProject[] = (await sql`SELECT name, repo FROM factory.planning_projects WHERE source = 'file'`).map(
    (raw: unknown) => Project.parse(raw),
  )

  const decisions: unknown[] = await sql`
    SELECT d.id, d.issue_id, d.repo, d.question, d.recommendation, d.asked_at, d.no_answer
    FROM factory.decisions d
    WHERE d.answered_at IS NULL AND d.withdrawn_at IS NULL
      AND EXISTS (SELECT 1 FROM factory.decision_steps s WHERE s.decision_id = d.id AND s.step = 'owner' AND s.outcome = 'open')
    ORDER BY d.asked_at DESC, d.id DESC`
  const reviews: unknown[] = await sql`
    SELECT i.id AS issue_id, i.repo, e.wait->'holds'->>'id' AS artifact_id, a.title, a.kind,
      e.wait->'holds'->>'summary' AS summary, e.at
    FROM factory.issues i
    JOIN LATERAL (
      SELECT x.wait, x.at FROM factory.issue_events x
      WHERE x.issue_id = i.id AND x.result = 'applied' ORDER BY x.version DESC LIMIT 1
    ) e ON true
    LEFT JOIN factory.artifacts a ON a.id = e.wait->'holds'->>'id'
    WHERE i.state = 'waiting' AND i.wait_reason = 'review'
    ORDER BY e.at DESC, i.id DESC`
  const errands: unknown[] = await sql`
    SELECT r.id, r.issue_id, i.repo, r.summary, r.detail, r.raised_at
    FROM factory.errands r JOIN factory.issues i ON i.id = r.issue_id
    WHERE r.done_at IS NULL AND i.state <> 'closed'
    ORDER BY r.raised_at DESC, r.id DESC`
  const signals: unknown[] = await sql`
    SELECT id, repo, title, text, received_at, issue_id
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
        link: { type: 'decision', id: row.id },
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
        link: { type: 'artifact', id: row.artifact_id },
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
        link: { type: 'errand', id: row.id },
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
        link: { type: 'signal', id: row.id },
        work: isWorkRepo(row.repo, open),
      }
    }),
  ]
  return { at: now, items: items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)) }
}
