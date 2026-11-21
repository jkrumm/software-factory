import type { SQL } from 'bun'
import * as z from 'zod'
import type { HeldEdge } from '../domains/planning/edge-need.ts'
import { EVIDENCE_SAMPLE_CAP, type EdgeNeed, SHARED_PATHS } from '../kernel/edge-need.ts'
import type { IssueId } from '../kernel/ids.ts'

const NeedRow = z.object({
  source: z.string(),
  added: z.coerce.number().int(),
  needed: z.coerce.number().int(),
  not_needed: z.coerce.number().int(),
  unknown: z.coerce.number().int(),
  removed: z.coerce.number().int(),
})

/**
 * Whether the edges the factory added were needed, per source (`triage`, `queue`: the word before the first colon of
 * `planning_edges.inferred_by`), over the edges added in `[from, to)`. An edge is one the factory added: a stored edge with
 * `inferred_by`, or one the queue loop took back (`queue_edge_removals`, which keeps what the edge carried). It is
 * measured when both Issues shipped (an accepted ship's `commits` evidence, whose paths were not cut at `EVIDENCE_SAMPLE_CAP`): `needed` when the paths their commits touched
 * share one (the shared aggregator and the lockfiles left out), `not_needed` when they share none, `unknown` otherwise.
 */
export async function readEdgeNeed(tx: SQL, window: { from: Date; to: Date }): Promise<EdgeNeed[]> {
  const rows: unknown[] = await tx`
    WITH c AS (${edgeFacts(tx, window)})
    SELECT source, count(*) AS added,
      count(*) FILTER (WHERE measured AND shared) AS needed,
      count(*) FILTER (WHERE measured AND NOT shared) AS not_needed,
      count(*) FILTER (WHERE NOT measured) AS unknown,
      count(*) FILTER (WHERE removed) AS removed
    FROM c GROUP BY source ORDER BY source`
  return rows.map((raw) => {
    const row = NeedRow.parse(raw)
    return {
      source: row.source,
      added: row.added,
      needed: row.needed,
      notNeeded: row.not_needed,
      unknown: row.unknown,
      removed: row.removed,
    }
  })
}

/**
 * One row per edge the factory added in `[from, to)`: its source, the two Issues, when it was added, whether it was taken
 * back (and why: `disjoint` or `owner_wait`), whether both Issues' shipped paths are known (`measured`) and whether they share one (`shared`). The rows
 * `readEdgeNeed` counts and the judge ledger lists.
 */
export function edgeFacts(tx: SQL, window: { from: Date; to: Date }, issues?: readonly string[]) {
  const only = issues === undefined ? tx`` : tx`AND e.issue_id IN ${tx([...issues])}`
  return tx`
    WITH e AS (
      SELECT issue_id, after_issue, inferred_by, created_at AS added_at, false AS removed, NULL::text AS removal_kind
      FROM factory.planning_edges WHERE inferred_by IS NOT NULL
      UNION ALL
      SELECT issue_id, after_issue, inferred_by, added_at, true AS removed, kind AS removal_kind FROM factory.queue_edge_removals
    )
    SELECT split_part(e.inferred_by, ':', 1) AS source, e.removed, e.removal_kind, e.issue_id, e.after_issue, e.added_at,
        (EXISTS (SELECT 1 FROM factory.quality_evidence q WHERE q.issue_id = e.issue_id AND q.kind = 'commits')
          AND EXISTS (SELECT 1 FROM factory.quality_evidence q WHERE q.issue_id = e.after_issue AND q.kind = 'commits')
          AND NOT EXISTS (SELECT 1 FROM factory.quality_evidence q WHERE q.issue_id IN (e.issue_id, e.after_issue)
            AND q.kind = 'commits' AND jsonb_array_length(q.payload->'paths') >= ${EVIDENCE_SAMPLE_CAP})) AS measured,
        EXISTS (
          SELECT 1 FROM factory.quality_evidence qa
          CROSS JOIN LATERAL jsonb_array_elements_text(qa.payload->'paths') pa(path)
          JOIN factory.quality_evidence qb ON qb.issue_id = e.after_issue AND qb.kind = 'commits'
          CROSS JOIN LATERAL jsonb_array_elements_text(qb.payload->'paths') pb(path)
          WHERE qa.issue_id = e.issue_id AND qa.kind = 'commits' AND pa.path = pb.path
            AND pa.path NOT IN ${tx([...SHARED_PATHS])}) AS shared
      FROM e WHERE e.added_at >= ${window.from} AND e.added_at < ${window.to} ${only}`
}

const HeldRow = z.object({
  issue_id: z.string(),
  after_issue: z.string(),
  inferred_by: z.string(),
  issue_state: z.string(),
  blocker_state: z.string(),
  blocker_wait: z.string().nullable(),
  blocker_since: z.coerce.date().nullable(),
  issue_paths: z.array(z.string()).nullable(),
  blocker_paths: z.array(z.string()).nullable(),
})

/**
 * The edges the factory added that still hold a queued Issue behind an open blocker, with what the sweep judges them by:
 * the blocker's state, wait and since when, and the paths each Issue's shipped commits touched (null while it shipped
 * nothing). An edge somebody stated has no `inferred_by` and is never read here.
 */
export async function readHeldEdges(tx: SQL): Promise<HeldEdge[]> {
  const rows: unknown[] = await tx`
    SELECT e.issue_id, e.after_issue, e.inferred_by, i.state AS issue_state, b.state AS blocker_state, b.wait_reason AS blocker_wait,
      (SELECT x.at FROM factory.issue_events x WHERE x.issue_id = b.id AND x.result = 'applied' AND x.to_state IS DISTINCT FROM x.from_state ORDER BY x.version DESC LIMIT 1) AS blocker_since,
      CASE WHEN EXISTS (SELECT 1 FROM factory.quality_evidence k WHERE k.issue_id = i.id AND k.kind = 'commits')
        AND NOT EXISTS (SELECT 1 FROM factory.quality_evidence k WHERE k.issue_id = i.id AND k.kind = 'commits' AND jsonb_array_length(k.payload->'paths') >= ${EVIDENCE_SAMPLE_CAP})
        THEN (SELECT COALESCE(jsonb_agg(DISTINCT p.path), '[]'::jsonb) FROM factory.quality_evidence q
          CROSS JOIN LATERAL jsonb_array_elements_text(q.payload->'paths') p(path)
          WHERE q.issue_id = i.id AND q.kind = 'commits') END AS issue_paths,
      CASE WHEN EXISTS (SELECT 1 FROM factory.quality_evidence k WHERE k.issue_id = b.id AND k.kind = 'commits')
        AND NOT EXISTS (SELECT 1 FROM factory.quality_evidence k WHERE k.issue_id = b.id AND k.kind = 'commits' AND jsonb_array_length(k.payload->'paths') >= ${EVIDENCE_SAMPLE_CAP})
        THEN (SELECT COALESCE(jsonb_agg(DISTINCT p.path), '[]'::jsonb) FROM factory.quality_evidence q
          CROSS JOIN LATERAL jsonb_array_elements_text(q.payload->'paths') p(path)
          WHERE q.issue_id = b.id AND q.kind = 'commits') END AS blocker_paths
    FROM factory.planning_edges e
    JOIN factory.issues i ON i.id = e.issue_id
    JOIN factory.issues b ON b.id = e.after_issue
    WHERE e.inferred_by IS NOT NULL AND e.satisfied_at IS NULL AND i.state = 'queued' AND b.state <> 'closed'
    ORDER BY e.issue_id, e.after_issue`
  return rows.map((raw) => {
    const row = HeldRow.parse(raw)
    return {
      issue: row.issue_id as IssueId,
      after: row.after_issue as IssueId,
      inferredBy: row.inferred_by,
      issueState: row.issue_state,
      blockerState: row.blocker_state,
      blockerWait: row.blocker_wait,
      blockerSince: row.blocker_since,
      issuePaths: row.issue_paths,
      blockerPaths: row.blocker_paths,
    }
  })
}

const RemovedRow = z.object({ issue_id: z.string(), after_issue: z.string() })

/** The edges the queue loop took back: the pairs it must not add again. */
export async function readRemovedEdges(tx: SQL): Promise<{ issue: IssueId; after: IssueId }[]> {
  const rows: unknown[] = await tx`SELECT DISTINCT issue_id, after_issue FROM factory.queue_edge_removals`
  return rows.map((raw) => {
    const row = RemovedRow.parse(raw)
    return { issue: row.issue_id as IssueId, after: row.after_issue as IssueId }
  })
}
