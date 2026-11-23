import type { SQL } from 'bun'
import * as z from 'zod'
import {
  askVerdict,
  decisionChangedNothing,
  orchestratorSteer,
  ownerDecision,
  ownerTouch,
  TOUCH_EVENTS,
  verdictChangedNothing,
  type Window,
} from './kpis.ts'
import { frictionWindow } from './friction.ts'
import { specSourceSql } from './spec-path.ts'
import { refusalKind } from './refusal-kind.ts'

/** Refs shown per pattern. */
const LIMIT = 5

const Row = z.object({ issue_id: z.string(), kind: z.string().nullable(), detail: z.string().nullable() })

/** The most recent distinct Issue refs of rows already newest first. */
const recent = (ids: readonly string[]): string[] => [...new Set(ids)].slice(0, LIMIT)

const issueIds = async (rows: Promise<unknown[]>): Promise<string[]> =>
  recent((await rows).map((raw) => z.object({ issue_id: z.string() }).parse(raw).issue_id))

/**
 * The Issues behind the counts of `readFriction`, for the keys asked: the same predicates, the same window, the Issues
 * newest first. A key with no Issue behind it (`undelivered_note`, `signal_held:*`) or none known is absent from the answer.
 * Read-only SQL.
 */
export async function readFrictionEvidence(
  sql: SQL,
  options: { now: Date; days: number; epoch?: Date | null },
  keys: readonly string[],
): Promise<Record<string, string[]>> {
  const { w } = frictionWindow(options)
  const out: Record<string, string[]> = {}
  for (const key of keys) {
    const refs = await refsOf(sql, w, key)
    if (refs) out[key] = refs
  }
  return out
}

async function refsOf(sql: SQL, w: Window, key: string): Promise<string[] | null> {
  const [head, ...rest] = key.split(':')
  const tail = rest.join(':')

  if (head === 'refusal') {
    const rows: unknown[] = await sql`
      SELECT issue_id, NULL::text AS kind, detail FROM factory.issue_events
      WHERE result = 'refused' AND at >= ${w.from} AND at < ${w.to} ORDER BY at DESC`
    return recent(
      rows
        .map((raw) => Row.parse(raw))
        .filter((row) => refusalKind(row.detail).id === tail)
        .map((row) => row.issue_id),
    )
  }
  if (head === 'ship_refused') {
    const rows: unknown[] = await sql`
      SELECT issue_id, NULL::text AS kind, detail FROM factory.quality_ships
      WHERE result = 'refused' AND at >= ${w.from} AND at < ${w.to} ORDER BY at DESC`
    return recent(
      rows
        .map((raw) => Row.parse(raw))
        .filter((row) => refusalKind(row.detail).id === tail)
        .map((row) => row.issue_id),
    )
  }
  if (head === 'stall') {
    return issueIds(sql`
      SELECT issue_id FROM factory.issue_events
      WHERE result = 'applied' AND to_state = 'waiting' AND wait->>'reason' = ${tail}
        AND at >= ${w.from} AND at < ${w.to} ORDER BY at DESC`)
  }
  if (key === 'lead_gone') {
    // the same two sources as the count: lost leads that were revived (no event) are lost leads too
    return issueIds(sql`
      SELECT issue_id FROM (
        SELECT issue_id, at FROM factory.issue_events
        WHERE kind = 'lead_gone' AND result = 'applied' AND at >= ${w.from} AND at < ${w.to}
        UNION ALL
        SELECT l.issue_id, l.at FROM factory.lead_losses l WHERE l.at >= ${w.from} AND l.at < ${w.to}
          AND NOT EXISTS (SELECT 1 FROM factory.issue_events e WHERE e.issue_id = l.issue_id AND e.kind = 'lead_gone'
            AND e.result = 'applied' AND e.payload->>'attempt' = l.attempt::text)
      ) lost ORDER BY at DESC`)
  }
  if (key === 'unreviewed_ship') {
    return issueIds(sql`
      SELECT issue_id FROM factory.quality_evidence
      WHERE kind = 'review' AND payload->>'status' NOT IN ('covered', 'not_required')
        AND at >= ${w.from} AND at < ${w.to} ORDER BY at DESC`)
  }
  if (key === 'unstated_acceptance') {
    return issueIds(sql`
      SELECT issue_id FROM factory.quality_evidence
      WHERE kind = 'acceptance' AND jsonb_array_length(payload->'statements') = 0
        AND at >= ${w.from} AND at < ${w.to} ORDER BY at DESC`)
  }
  if (key === 'unproven_ci') {
    return issueIds(sql`
      SELECT issue_id FROM factory.quality_evidence
      WHERE kind = 'ci' AND payload->>'status' IN ('red', 'missing')
        AND at >= ${w.from} AND at < ${w.to} ORDER BY at DESC`)
  }
  if (key === 'regression') {
    return issueIds(sql`
      SELECT issue_id FROM factory.quality_watches
      WHERE answer = 'regressed' AND answered_at >= ${w.from} AND answered_at < ${w.to} ORDER BY answered_at DESC`)
  }
  if (key === 'ask_unneeded:decision') {
    return issueIds(sql`
      SELECT d.issue_id FROM factory.decisions d
      WHERE ${ownerDecision(sql, w)} AND ${decisionChangedNothing(sql)} ORDER BY d.answered_at DESC`)
  }
  if (key === 'ask_unneeded:concept') {
    return issueIds(sql`
      SELECT a.issue_id FROM factory.verdicts v
      JOIN factory.artifacts a ON a.id = v.artifact_id AND a.kind = 'concept'
      WHERE ${askVerdict(sql, w)} AND ${verdictChangedNothing(sql)} ORDER BY v.at DESC`)
  }
  if (head === 'ask_unneeded') {
    return issueIds(sql`
      SELECT a.issue_id FROM factory.verdicts v
      JOIN factory.artifacts a ON a.id = v.artifact_id AND a.kind = 'spec'
      LEFT JOIN factory.spec_screens s ON s.artifact_id = v.artifact_id AND s.revision = v.revision
      WHERE ${askVerdict(sql, w)} AND ${verdictChangedNothing(sql)} AND ${specSourceSql(sql)} = ${tail}
      ORDER BY v.at DESC`)
  }
  if (key === 'touch:decision_answered') {
    return issueIds(sql`
      SELECT issue_id FROM factory.decisions
      WHERE settled_by = 'owner' AND worth_asking IS NOT TRUE AND answered_at >= ${w.from} AND answered_at < ${w.to}
      ORDER BY answered_at DESC`)
  }
  if (key === 'steer:decision_answered') {
    return issueIds(sql`
      SELECT issue_id FROM factory.decisions
      WHERE settled_by = 'orchestrator' AND worth_asking IS NOT TRUE AND answered_at >= ${w.from} AND answered_at < ${w.to}
      ORDER BY answered_at DESC`)
  }
  if (head === 'steer' && (TOUCH_EVENTS as readonly string[]).includes(tail)) {
    return issueIds(sql`
      SELECT issue_id FROM factory.issue_events
      WHERE ${orchestratorSteer(sql, [tail])} AND at >= ${w.from} AND at < ${w.to}
      ORDER BY at DESC`)
  }
  if (head === 'touch' && (TOUCH_EVENTS as readonly string[]).includes(tail)) {
    return issueIds(sql`
      SELECT issue_id FROM factory.issue_events
      WHERE ${ownerTouch(sql, [tail])} AND at >= ${w.from} AND at < ${w.to}
      ORDER BY at DESC`)
  }
  return null
}
