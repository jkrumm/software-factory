import type { SQL } from 'bun'
import * as z from 'zod'
import {
  type FrictionModel,
  type KpiModel,
  RETRO_MARKER,
  type RetroCapacity,
  type RetroCapacityFigure,
  type RetroLedgerEntry,
  type RetroModel,
  type RetroSample,
  type RetroSession,
} from '@software-factory/contract'
import type { CiTimes } from '../domains/loops/ports.ts'
import { capacityFigures, tuneConstant } from './capacity-tuning.ts'
import { type CapacityConstants, readCapacityLoop } from './capacity-loop.ts'
import { readFriction } from './friction.ts'
import { readKpis, type Window } from './kpis.ts'
import { readRetroBuild } from './retro-build.ts'
import { readTaste } from './retro-taste.ts'
import { REGRESSION_CAUSES, regressionCause } from './kpis-flow.ts'
import { windowOf } from './stats.ts'
import { plain } from './words.ts'

/** Issues listed per sample. */
export const SAMPLE_SIZE = 10

/** A number within this share of `before` has not moved. */
export const FLAT_WITHIN = 0.05

const Ref = z.object({ issue_id: z.string() })

const sessionsOf = async (sql: SQL, w: Window): Promise<RetroSession[]> => {
  const rows: unknown[] = await sql`
    SELECT DISTINCT ON (issue_id, attempt, payload->>'transcriptPath') issue_id, attempt,
      payload->>'model' AS model, payload->>'account' AS account, payload->>'transcriptPath' AS path
    FROM factory.lead_hook_events
    WHERE kind = 'session_started' AND at >= ${w.from} AND at < ${w.to}
    ORDER BY issue_id, attempt, payload->>'transcriptPath', at`
  return rows.map((raw) => {
    const row = z
      .object({
        issue_id: z.string(),
        attempt: z.coerce.number().int(),
        model: z.string().nullable(),
        account: z.string().nullable(),
        path: z.string().nullable(),
      })
      .parse(raw)
    return {
      issue: row.issue_id,
      attempt: row.attempt,
      model: row.model,
      account: row.account,
      transcriptPath: row.path,
    }
  })
}

const Sample = z.object({ issue_id: z.string(), why: z.string().nullable(), ms: z.coerce.number().nullable() })
const samples = (rows: unknown[]): RetroSample[] =>
  rows.map((raw) => {
    const row = Sample.parse(raw)
    return { issue: row.issue_id, why: row.why ?? '', ms: row.ms }
  })

/** First watches that regressed in the window, by cause. */
async function regressed(sql: SQL, w: Window): Promise<RetroSample[]> {
  const rows: unknown[] = await sql`
    SELECT k.issue_id,
      (SELECT array_agg((c->>'name') || '|' || coalesce(c->>'detail', ''))
        FROM (SELECT x.checks FROM factory.quality_checks x WHERE x.watch_key = k.key ORDER BY x.n DESC LIMIT 1) l,
        jsonb_array_elements(l.checks) c
        WHERE (c->>'ok')::boolean = false AND coalesce((c->>'inherited')::boolean, false) = false) AS failed
    FROM factory.quality_watches k
    WHERE k.watch = 1 AND k.answer = 'regressed' AND k.answered_at >= ${w.from} AND k.answered_at < ${w.to}
    ORDER BY k.answered_at DESC LIMIT ${SAMPLE_SIZE}`
  return rows.map((raw) => {
    const row = Ref.extend({ failed: z.array(z.string()).nullable() }).parse(raw)
    const cause = regressionCause(row.failed ?? [])
    return { issue: row.issue_id, why: REGRESSION_CAUSES.find(([key]) => key === cause)?.[1] ?? cause, ms: null }
  })
}

const stalled = async (sql: SQL, w: Window) =>
  samples(
    await sql`
      SELECT DISTINCT ON (issue_id) issue_id, wait->>'reason' AS why, NULL::float8 AS ms FROM factory.issue_events
      WHERE result = 'applied' AND to_state = 'waiting' AND wait->>'reason' IN ('wall', 'unreported', 'blocked', 'lead_gone', 'regressed')
        AND at >= ${w.from} AND at < ${w.to}
      ORDER BY issue_id, at DESC LIMIT ${SAMPLE_SIZE}`,
  )

const slowest = async (sql: SQL, w: Window) =>
  samples(
    await sql`
      SELECT c.issue_id, 'cycle' AS why, extract(epoch FROM (c.at - f.at)) * 1000 AS ms
      FROM factory.issue_events c
      JOIN factory.issue_events f ON f.issue_id = c.issue_id AND f.kind = 'filed' AND f.version = 1
      WHERE c.result = 'applied' AND c.to_state = 'closed' AND c.outcome = 'done' AND c.at >= ${w.from} AND c.at < ${w.to}
      ORDER BY ms DESC LIMIT ${SAMPLE_SIZE}`,
  )

const refused = async (sql: SQL, w: Window) =>
  samples(
    await sql`
      SELECT issue_id, plain_detail AS why, NULL::float8 AS ms FROM (
        SELECT DISTINCT ON (issue_id) issue_id, kind || ': ' || coalesce(detail, 'no reason given') AS plain_detail, at
        FROM factory.issue_events WHERE result = 'refused' AND at >= ${w.from} AND at < ${w.to}
        ORDER BY issue_id, at DESC) r
      ORDER BY at DESC LIMIT ${SAMPLE_SIZE}`,
  ).map((s) => ({ ...s, why: plain(s.why, 160) }))

const dropped = async (sql: SQL, w: Window) =>
  samples(
    await sql`
      SELECT c.issue_id, c.outcome || ': ' || coalesce(c.payload->>'reason', '') AS why, NULL::float8 AS ms
      FROM factory.issue_events c
      WHERE c.result = 'applied' AND c.to_state = 'closed' AND c.outcome IN ('dropped', 'cancelled')
        AND c.at >= ${w.from} AND c.at < ${w.to}
        AND EXISTS (SELECT 1 FROM factory.issue_events a WHERE a.issue_id = c.issue_id AND a.kind = 'admitted' AND a.result = 'applied')
      ORDER BY c.at DESC LIMIT ${SAMPLE_SIZE}`,
  ).map((s) => ({ ...s, why: plain(s.why, 160) }))

/** Better, worse or flat against `before`, in the direction the signal wanted the number to go. */
export function movedOf(before: number, now: number, direction: 'up' | 'down'): 'better' | 'worse' | 'flat' {
  const change = before === 0 ? (now === 0 ? 0 : Math.sign(now)) : (now - before) / Math.abs(before)
  if (Math.abs(change) <= FLAT_WITHIN) return 'flat'
  return change > 0 === (direction === 'up') ? 'better' : 'worse'
}

/** The retro signals the factory has seen (`RETRO_MARKER` in their text), against the KPIs as they are now. */
export async function ledgerOf(
  sql: SQL,
  kpis: KpiModel,
  capacity: readonly RetroCapacityFigure[] = [],
): Promise<RetroLedgerEntry[]> {
  const rows: unknown[] = await sql`
    SELECT s.id, s.title, s.text, s.received_at, s.issue_id, i.state, i.outcome,
      (SELECT max(e.at) FROM factory.issue_events e
        WHERE e.issue_id = s.issue_id AND e.kind = 'shipped' AND e.result = 'applied') AS shipped_at
    FROM factory.intake_signals s LEFT JOIN factory.issues i ON i.id = s.issue_id
    WHERE s.text ~ 'Retro: [0-9]{4}-[0-9]{2}-[0-9]{2} kpi=[a-z0-9_]+ before=' ORDER BY s.received_at`
  const windowFrom = new Date(kpis.window.from).getTime()
  const entries: RetroLedgerEntry[] = []
  for (const raw of rows) {
    const row = z
      .object({
        id: z.string(),
        title: z.string(),
        text: z.string(),
        received_at: z.coerce.date(),
        issue_id: z.string().nullable(),
        state: z.string().nullable(),
        outcome: z.string().nullable(),
        shipped_at: z.coerce.date().nullable(),
      })
      .parse(raw)
    const marker = RETRO_MARKER.exec(row.text)
    if (!marker) continue
    const [, , key, rawBefore, direction] = marker
    const before = rawBefore === 'none' ? null : Number(rawBefore)
    const now = kpis.kpis.find((k) => k.key === key)?.value ?? capacity.find((f) => f.key === key)?.value ?? null
    const measured =
      row.shipped_at === null
        ? 'not_shipped'
        : before === null || now === null
          ? 'unknown'
          : row.shipped_at.getTime() <= windowFrom
            ? 'after'
            : 'partial'
    entries.push({
      signal: row.id,
      title: row.title,
      filedAt: row.received_at.toISOString(),
      issue: row.issue_id,
      state: row.state,
      outcome: row.outcome,
      shippedAt: row.shipped_at?.toISOString() ?? null,
      kpi: key ?? '',
      before,
      direction: direction === 'up' ? 'up' : 'down',
      now,
      measured,
      moved:
        (measured === 'after' || measured === 'partial') && before !== null && now !== null
          ? movedOf(before, now, direction === 'up' ? 'up' : 'down')
          : null,
    })
  }
  return entries
}

/** The capacity loop over the window, its per-day figures and the one setting the fixed rules would change first. */
async function capacityOf(
  sql: SQL,
  options: { now: Date; days: number; constants: CapacityConstants; build: readonly RetroCapacityFigure[] },
): Promise<RetroCapacity> {
  const loop = await readCapacityLoop(sql, options)
  const figures = [...capacityFigures(loop), ...options.build]
  const heaviest = loop.leadCosts[0] ?? null
  const memoryShare = loop.idleSeatHours.total > 0 ? loop.idleSeatHoursMemory.total / loop.idleSeatHours.total : 0
  return {
    figures,
    tune: tuneConstant(figures, loop.constants, {
      memoryShare,
      trigger: loop.idleSeatHoursMemory.swapUsed > loop.idleSeatHoursMemory.swapout ? 'swapUsed' : 'swapout',
      heaviest: heaviest && { repo: heaviest.repo, peakMibP80: heaviest.peakMibP80 },
    }),
    loop,
  }
}

/**
 * What the weekly retro reads from the database over the last `days` days: the KPI table (with its history, so the window
 * before is in it), the friction counts, the lead sessions with their transcript paths (the CLI reads those), samples of
 * the Issues worth reading, the ledger of the earlier retro signals and the owner's taste (his verdict notes and annotations). `redact` (the read token) drops transcript paths
 * and the words of the samples: a work repository's words never leave it.
 */
export async function readRetro(
  sql: SQL,
  options: { now: Date; days: number; redact?: boolean; capacityConstants?: CapacityConstants; ciTimes?: CiTimes },
): Promise<RetroModel> {
  const { now, days } = options
  const w = windowOf(now, days)
  const kpis = await readKpis(sql, { now, days })
  const friction: FrictionModel = await readFriction(sql, { now, days })
  const sessions = await sessionsOf(sql, w)
  const build = await readRetroBuild(sql, { now, days, ...(options.ciTimes ? { ciTimes: options.ciTimes } : {}) })
  const capacity = options.capacityConstants
    ? await capacityOf(sql, { now, days, constants: options.capacityConstants, build: build.figures })
    : null
  const model: RetroModel = {
    at: now.toISOString(),
    days,
    window: { from: w.from.toISOString(), to: w.to.toISOString() },
    kpis,
    friction,
    sessions,
    samples: {
      regressed: await regressed(sql, w),
      stalled: await stalled(sql, w),
      slowest: await slowest(sql, w),
      refused: await refused(sql, w),
      dropped: await dropped(sql, w),
    },
    ledger: await ledgerOf(sql, kpis, capacity?.figures ?? build.figures),
    taste: await readTaste(sql, w),
    capacity,
    build,
  }
  if (!options.redact) return model
  const bare = (list: RetroSample[]): RetroSample[] => list.map((s) => ({ ...s, why: '' }))
  return {
    ...model,
    sessions: sessions.map((s) => ({ ...s, transcriptPath: null })),
    samples: {
      regressed: bare(model.samples.regressed),
      stalled: bare(model.samples.stalled),
      slowest: bare(model.samples.slowest),
      refused: bare(model.samples.refused),
      dropped: bare(model.samples.dropped),
    },
    ledger: model.ledger.map((e) => ({ ...e, title: '' })),
    taste: {
      verdicts: model.taste.verdicts.map((v) => ({ ...v, title: '', note: null })),
      annotations: model.taste.annotations.map((a) => ({ ...a, title: '', quote: '', comment: '' })),
    },
  }
}
