import type { SQL } from 'bun'

/**
 * A review is at the owner when it is a Concept, or a Spec whose latest revision its path passed to him; a Spec held or
 * settled by rule is not (`app/checkpoints-specs.ts`). `a` is the artifact row of the query it is used in.
 */
export const specAtOwner = (sql: SQL) => sql`
  (a.kind IS DISTINCT FROM 'spec' OR EXISTS (
    SELECT 1 FROM factory.spec_paths s
    WHERE s.artifact_id = a.id AND s.outcome = 'passed'
      AND s.revision = (SELECT max(sr.n) FROM factory.artifact_revisions sr WHERE sr.artifact_id = a.id)))`

/** Who made a Spec revision owed, from its path row `s` (`factory.spec_paths`) (a revision answered before any look counts as the lead's). */
export const specSourceSql = (sql: SQL) => sql`COALESCE(s.source, 'lead')`
