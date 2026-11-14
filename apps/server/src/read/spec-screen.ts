import { SPEC_SOURCES, type SpecPrecedent, VERDICTS } from '@software-factory/contract'
import type { SQL } from 'bun'
import * as z from 'zod'

/**
 * A review is at the owner when it is a Concept, or a Spec whose latest revision the Spec screen passed to him; a Spec the
 * screen holds or settled is not (`app/checkpoints-specs.ts`). `a` is the artifact row of the query it is used in.
 */
export const screenPassed = (sql: SQL) => sql`
  (a.kind IS DISTINCT FROM 'spec' OR EXISTS (
    SELECT 1 FROM factory.spec_screens s
    WHERE s.artifact_id = a.id AND s.outcome = 'passed'
      AND s.revision = (SELECT max(sr.n) FROM factory.artifact_revisions sr WHERE sr.artifact_id = a.id)))`

/** Who made a Spec revision owed, from its screen row `s` (a revision answered before any look counts as the lead's). */
export const specSourceSql = (sql: SQL) => sql`COALESCE(s.source, 'lead')`

const PrecedentRow = z.object({
  title: z.string().transform((title) => title.slice(0, 200)),
  repo: z.string(),
  source: z.enum(SPEC_SOURCES),
  screened: z.enum(['passed', 'settled']).nullable(),
  needed: z.boolean(),
  verdict: z.enum(VERDICTS),
  note: z
    .string()
    .nullable()
    .transform((note) => note?.slice(0, 2000) ?? null),
})

/**
 * The owner's newest needed-me marks on Specs, newest mark first: the precedents the Spec screen and triage are shown, so a
 * mark changes the next look rather than next week's retro. Unscrubbed; the caller scrubs what goes to a model.
 */
export async function readSpecPrecedents(sql: SQL, limit: number): Promise<SpecPrecedent[]> {
  const rows: unknown[] = await sql`
    SELECT a.title, i.repo, ${specSourceSql(sql)} AS source, s.outcome AS screened, v.needed_me AS needed,
      v.verdict, v.note
    FROM factory.verdicts v
    JOIN factory.artifacts a ON a.id = v.artifact_id
    JOIN factory.issues i ON i.id = a.issue_id
    LEFT JOIN factory.spec_screens s ON s.artifact_id = v.artifact_id AND s.revision = v.revision
    WHERE a.kind = 'spec' AND v.needed_me IS NOT NULL
    ORDER BY COALESCE(v.needed_at, v.at) DESC, v.artifact_id DESC LIMIT ${limit}`
  return rows.map((raw) => PrecedentRow.parse(raw))
}
