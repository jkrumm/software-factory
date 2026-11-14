import type { SQL } from 'bun'
import * as z from 'zod'
import { orchestratorSteer, ownerTouch, TOUCH_EVENTS, type Window } from './kpis.ts'
import { frictionWindow } from './friction.ts'
import { specSourceSql } from './spec-screen.ts'
import { plain } from './words.ts'

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
  options: { now: Date; days: number },
  keys: readonly string[],
): Promise<Record<string, string[]>> {
  const { w } = await frictionWindow(sql, options)
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
    const kind = rest[0] ?? ''
    const reason = rest.slice(1).join(':')
    const rows: unknown[] = await sql`
      SELECT issue_id, kind, detail FROM factory.issue_events
      WHERE result = 'refused' AND kind = ${kind} AND at >= ${w.from} AND at < ${w.to} ORDER BY at DESC`
    return recent(
      rows
        .map((raw) => Row.parse(raw))
        .filter((row) => plain(row.detail ?? 'no reason given', 80) === reason)
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
        .filter((row) => plain(row.detail ?? 'no reason given', 80) === tail)
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
    return issueIds(sql`
      SELECT issue_id FROM factory.issue_events
      WHERE kind = 'lead_gone' AND result = 'applied' AND at >= ${w.from} AND at < ${w.to} ORDER BY at DESC`)
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
  if (head === 'spec_unneeded') {
    return issueIds(sql`
      SELECT a.issue_id FROM factory.verdicts v
      JOIN factory.artifacts a ON a.id = v.artifact_id AND a.kind = 'spec'
      LEFT JOIN factory.spec_screens s ON s.artifact_id = v.artifact_id AND s.revision = v.revision
      WHERE v.needed_me IS FALSE AND ${specSourceSql(sql)} = ${tail} AND v.at >= ${w.from} AND v.at < ${w.to}
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
