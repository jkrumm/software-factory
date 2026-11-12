import type { SQL } from 'bun'
import * as z from 'zod'
import type { RetroTaste } from '@software-factory/contract'
import { ownerVerdict, type Window } from './kpis.ts'

/** The verdicts and annotations one retro lists; the newest are kept. */
export const TASTE_LIMIT = 200

const Kind = z.enum(['concept', 'spec', 'report'])

const Verdict = z.object({
  artifact: z.string(),
  kind: Kind,
  title: z.string(),
  repo: z.string(),
  issue: z.string(),
  verdict: z.enum(['looks_good', 'with_notes', 'changes']),
  note: z.string().nullable(),
  at: z.coerce.date(),
})

const Annotation = z.object({
  artifact: z.string(),
  kind: Kind,
  title: z.string(),
  repo: z.string(),
  issue: z.string(),
  revision: z.coerce.number().int(),
  quote: z.string(),
  comment: z.string(),
  at: z.coerce.date(),
})

/**
 * What the owner said in the window, in his words: the notes of his own verdicts (never the factory's defaults, see
 * `ownerVerdict`) that say something or ask for more, and every annotation he wrote, each with its artifact, repo and Issue.
 * A `looks_good` without a note is a count in `verdict_changes_share`, not a preference, so it is not listed.
 */
export async function readTaste(sql: SQL, w: Window): Promise<RetroTaste> {
  const verdicts: unknown[] = await sql`
    SELECT a.id AS artifact, a.kind, a.title, i.repo, a.issue_id AS issue, v.verdict, v.note, v.at
    FROM factory.verdicts v
    JOIN factory.artifacts a ON a.id = v.artifact_id AND a.kind IN ('concept', 'spec', 'report')
    JOIN factory.issues i ON i.id = a.issue_id
    WHERE ${ownerVerdict(sql, w)} AND (v.note IS NOT NULL OR v.verdict <> 'looks_good')
    ORDER BY v.at DESC, a.id LIMIT ${TASTE_LIMIT}`
  const annotations: unknown[] = await sql`
    SELECT a.id AS artifact, a.kind, a.title, i.repo, a.issue_id AS issue, n.revision, n.quote, n.comment, n.at
    FROM factory.annotations n
    JOIN factory.artifacts a ON a.id = n.artifact_id AND a.kind IN ('concept', 'spec', 'report')
    JOIN factory.issues i ON i.id = a.issue_id
    WHERE n.author = 'owner' AND n.at >= ${w.from} AND n.at < ${w.to}
    ORDER BY n.at DESC, n.id LIMIT ${TASTE_LIMIT}`
  return {
    verdicts: verdicts.map((raw) => {
      const row = Verdict.parse(raw)
      return { ...row, at: row.at.toISOString() }
    }),
    annotations: annotations.map((raw) => {
      const row = Annotation.parse(raw)
      return { ...row, at: row.at.toISOString() }
    }),
  }
}
