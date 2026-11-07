import type { ReadAsk } from '@software-factory/contract'
import type { SQL } from 'bun'
import { cut, fallbackWords } from './plain.ts'
import { loadBriefs, issueNumberOf } from './sessions.ts'

/** An ask older than this is stale. */
export const STALE_ASK_MS = 24 * 3_600_000
/** The raw text of an ask or a health line in the read API: one line, cut at a word. */
export const LINE_TEXT_MAX = 240

interface Waiting {
  id: string
  kind: 'decision' | 'review' | 'errand'
  issue_id: string
  text: string
  at: Date
}

/**
 * What waits on the owner. The asks are the open Decisions and the Concepts and Specs awaiting a verdict (the artifact of an
 * Issue in a `review` wait with no verdict on its newest revision); the human queue is the open Errands. Oldest first.
 */
export async function readAsks(sql: SQL, now: Date): Promise<{ asks: ReadAsk[]; humanQueue: ReadAsk[] }> {
  const decisions: { id: string; issue_id: string; question: string; asked_at: Date }[] = await sql`
    SELECT id, issue_id, question, asked_at FROM factory.decisions
    WHERE answered_at IS NULL AND withdrawn_at IS NULL ORDER BY asked_at, id`
  const reviews: { id: string; issue_id: string; title: string; created_at: Date }[] = await sql`
    SELECT a.id, a.issue_id, a.title, a.created_at FROM factory.artifacts a
    JOIN factory.issues i ON i.id = a.issue_id AND i.state = 'waiting' AND i.wait_reason = 'review'
    WHERE a.kind IN ('concept', 'spec')
      AND NOT EXISTS (
        SELECT 1 FROM factory.verdicts v
        WHERE v.artifact_id = a.id
          AND v.revision = (SELECT max(r.n) FROM factory.artifact_revisions r WHERE r.artifact_id = a.id))
    ORDER BY a.created_at, a.id`
  const errands: { id: string; issue_id: string; summary: string; raised_at: Date }[] = await sql`
    SELECT id, issue_id, summary, raised_at FROM factory.errands WHERE done_at IS NULL ORDER BY raised_at, id`
  const waiting: Waiting[] = [
    ...decisions.map((d): Waiting => ({
      id: d.id,
      kind: 'decision',
      issue_id: d.issue_id,
      text: d.question,
      at: d.asked_at,
    })),
    ...reviews.map((r): Waiting => ({
      id: r.id,
      kind: 'review',
      issue_id: r.issue_id,
      text: r.title,
      at: r.created_at,
    })),
    ...errands.map((e): Waiting => ({
      id: e.id,
      kind: 'errand',
      issue_id: e.issue_id,
      text: e.summary,
      at: e.raised_at,
    })),
  ]
  const briefs = await loadBriefs(sql, [...new Set(waiting.map((w) => w.issue_id))])
  const lines = waiting.map((w): ReadAsk => {
    const words = fallbackWords(w.text, 'ask')
    const brief = briefs.get(w.issue_id)
    return {
      id: w.id,
      kind: w.kind,
      source: w.kind,
      issue: issueNumberOf(w.issue_id),
      issueRef: w.issue_id,
      short: words.short,
      summary: words.summary,
      text: cut(w.text, LINE_TEXT_MAX),
      at: w.at.toISOString(),
      stale: now.getTime() - w.at.getTime() >= STALE_ASK_MS,
      repo: brief?.repo ?? null,
      session: null,
      visible: brief?.visible ?? false,
    }
  })
  const byAge = (a: ReadAsk, b: ReadAsk): number => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)
  return {
    asks: lines.filter((line) => line.kind !== 'errand').sort(byAge),
    humanQueue: lines.filter((line) => line.kind === 'errand').sort(byAge),
  }
}
