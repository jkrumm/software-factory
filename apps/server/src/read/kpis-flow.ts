import type { SQL } from 'bun'
import * as z from 'zod'
import type { KpiPart } from '@software-factory/contract'
import { MIN_SAMPLES, percentile, shareOf } from './stats.ts'
import type { Window } from './kpis.ts'

/**
 * The figures the event log, the checkpoint tables and the delivery log answer by themselves, read as parts of a KPI or beside
 * one: how much capacity sat idle behind a non-empty queue, how an Issue's time divides by state, what was spent on Issues that
 * were dropped, what the screen did with the Errands, how long a first watch took and why one regressed. Each is read-only SQL
 * over one window, so each can be checked by SQL over the same window (`apps/server/test/read-models/kpis-flow.test.ts`).
 */

/** An open-ended edge or interval: later than any window. */
const NEVER = new Date('9999-01-01T00:00:00Z')

/** A first watch whose failing check says what the regression was; the first that matches names the cause. */
export const REGRESSION_CAUSES = [
  ['ci', 'The default branch’s CI failed or did not finish'],
  ['verify', 'The project’s verify went red'],
  ['not_deployed', 'The deployed version does not hold the landed commit'],
  ['no_version_probe', 'The project has no version probe'],
  ['checkout', 'The checkout could not be read'],
  ['other', 'A probe or another check failed'],
] as const

/** An account has room while its five-hour window is below this share and the week is not nearly used. */
const ROOM_FIVE_HOUR_BELOW = 50
const ROOM_WEEKLY_BELOW = 90

const part = (key: string, label: string, value: number, unit: KpiPart['unit']): KpiPart => ({
  key,
  label,
  value,
  unit,
})

/**
 * Hours of the window when an Issue no `after` edge held sat queued while an account had room, and the hours an Issue like
 * that was queued at all. Read at the top of each hour: the Issue's state then, the best account's readings in that hour. An hour with no capacity reading at all (the readings are kept a week, or the server was down) is not counted either way, so a window older than the readings is unmeasured, not zero.
 */
async function idleHours(sql: SQL, w: Window): Promise<{ hours: number; idle: number }> {
  const [row] = await sql`
    WITH hrs AS (
      SELECT h FROM generate_series(date_trunc('hour', ${w.from}::timestamptz) + interval '1 hour',
        date_trunc('hour', ${w.to}::timestamptz) - interval '1 hour', interval '1 hour') AS h),
    ev AS (
      SELECT issue_id, to_state, at, lead(at) OVER (PARTITION BY issue_id ORDER BY version) AS nxt
      FROM factory.issue_events WHERE result = 'applied'),
    q AS (SELECT issue_id, at AS s, coalesce(nxt, ${NEVER}) AS e FROM ev WHERE to_state = 'queued'),
    b AS (
      SELECT issue_id, min(created_at) AS b0, max(coalesce(satisfied_at, ${NEVER})) AS b1
      FROM factory.planning_edges GROUP BY issue_id),
    seen AS (
      SELECT DISTINCT date_trunc('hour', read_at) AS h FROM factory.capacity_readings
      WHERE read_at >= ${w.from} AND read_at < ${w.to}),
    free AS (
      SELECT DISTINCT hrs.h FROM hrs
      JOIN seen ON seen.h = hrs.h
      JOIN q ON q.s <= hrs.h AND hrs.h < q.e
      LEFT JOIN b ON b.issue_id = q.issue_id
      WHERE b.issue_id IS NULL OR NOT (b.b0 <= hrs.h AND hrs.h < b.b1)),
    room AS (
      SELECT DISTINCT date_trunc('hour', read_at) AS h FROM factory.capacity_readings
      WHERE enabled AND auth_ok AND exhausted_until IS NULL
        AND five_hour_used < ${ROOM_FIVE_HOUR_BELOW} AND coalesce(weekly_used, 0) < ${ROOM_WEEKLY_BELOW}
        AND read_at >= ${w.from} AND read_at < ${w.to})
    SELECT count(*) AS hours, count(room.h) AS idle FROM free LEFT JOIN room ON room.h = free.h`
  const parsed = z.object({ hours: z.coerce.number(), idle: z.coerce.number() }).parse(row)
  return parsed
}

/** What Issues spent in each state or wait reason, for the intervals that ended in the window. */
async function stateTime(sql: SQL, w: Window): Promise<{ ms: Map<string, number>; n: number }> {
  const rows: unknown[] = await sql`
    WITH ev AS (
      SELECT to_state, wait->>'reason' AS reason, at, lead(at) OVER (PARTITION BY issue_id ORDER BY version) AS nxt
      FROM factory.issue_events WHERE result = 'applied')
    SELECT to_state AS state, coalesce(reason, '') AS reason, sum(extract(epoch FROM nxt - at)) * 1000 AS ms, count(*) AS n
    FROM ev WHERE to_state IN ('working', 'waiting', 'watching') AND nxt >= ${w.from} AND nxt < ${w.to}
    GROUP BY to_state, reason`
  const ms = new Map<string, number>()
  let n = 0
  for (const raw of rows) {
    const row = z
      .object({ state: z.string(), reason: z.string(), ms: z.coerce.number(), n: z.coerce.number() })
      .parse(raw)
    ms.set(row.state === 'waiting' ? `waiting:${row.reason}` : row.state, row.ms)
    n += row.n
  }
  return { ms, n }
}

/** Issues that closed in the window after a lead had started on them: how many ended dropped or cancelled. */
async function closedWithLead(sql: SQL, w: Window) {
  const [row] = await sql`
    WITH closed AS (
      SELECT DISTINCT ON (issue_id) issue_id, outcome FROM factory.issue_events
      WHERE result = 'applied' AND to_state = 'closed' AND at >= ${w.from} AND at < ${w.to}
      ORDER BY issue_id, version)
    SELECT count(*) AS n,
      count(*) FILTER (WHERE outcome = 'dropped') AS dropped,
      count(*) FILTER (WHERE outcome = 'cancelled') AS cancelled
    FROM closed WHERE EXISTS (
      SELECT 1 FROM factory.issue_events a
      WHERE a.issue_id = closed.issue_id AND a.kind = 'admitted' AND a.result = 'applied')`
  return z.object({ n: z.coerce.number(), dropped: z.coerce.number(), cancelled: z.coerce.number() }).parse(row)
}

/** Errands raised in the window, by what the screen did before the owner saw them. */
async function errandCounts(sql: SQL, w: Window) {
  const [row] = await sql`
    SELECT count(*) AS n,
      count(*) FILTER (WHERE turned_away_at IS NOT NULL AND screen_by = 'rule') AS rule,
      count(*) FILTER (WHERE turned_away_at IS NOT NULL AND screen_by = 'judge') AS judge
    FROM factory.errands WHERE issue_id IS NOT NULL AND raised_at >= ${w.from} AND raised_at < ${w.to}`
  return z.object({ n: z.coerce.number(), rule: z.coerce.number(), judge: z.coerce.number() }).parse(row)
}

/** First watches that ended in the window: how many, how long each took, and the cause of each regression. */
async function firstWatches(sql: SQL, w: Window) {
  const rows: unknown[] = await sql`
    SELECT w.answer, extract(epoch FROM w.answered_at - w.started_at) * 1000 AS ms,
      (SELECT array_agg((c->>'name') || '|' || coalesce(c->>'detail', ''))
        FROM (SELECT k.checks FROM factory.quality_checks k WHERE k.watch_key = w.key ORDER BY k.n DESC LIMIT 1) l,
        jsonb_array_elements(l.checks) c
        WHERE (c->>'ok')::boolean = false AND coalesce((c->>'inherited')::boolean, false) = false) AS failed
    FROM factory.quality_watches w
    WHERE w.watch = 1 AND w.answer IN ('passed', 'regressed') AND w.answered_at >= ${w.from} AND w.answered_at < ${w.to}`
  return rows.map((raw) =>
    z
      .object({
        answer: z.enum(['passed', 'regressed']),
        ms: z.coerce.number(),
        failed: z.array(z.string()).nullable(),
      })
      .parse(raw),
  )
}

/** The cause class of a regression from the names and details of the checks that failed in its last run. */
export function regressionCause(failed: readonly string[]): (typeof REGRESSION_CAUSES)[number][0] {
  const has = (test: (name: string, detail: string) => boolean) =>
    failed.some((entry) => {
      const cut = entry.indexOf('|')
      return test(entry.slice(0, cut), entry.slice(cut + 1))
    })
  if (has((name) => name === 'ci')) return 'ci'
  if (has((name) => name === 'make verify' || name.startsWith('make '))) return 'verify'
  if (has((name, detail) => name === 'deployed version' && detail.startsWith('no `make version` target')))
    return 'no_version_probe'
  if (has((name) => name === 'deployed version')) return 'not_deployed'
  if (has((name) => name === 'checkout')) return 'checkout'
  return 'other'
}

/**
 * Why the first watches that ended in the window regressed, as shares of all first watches that ended: the parts of
 * `first_verification_passes`. A regression that failed several checks counts under the first cause in `REGRESSION_CAUSES`.
 * Which of them was the change's fault is for a reader of the sample.
 */
export async function regressionParts(sql: SQL, w: Window): Promise<KpiPart[]> {
  const watches = await firstWatches(sql, w)
  const causes = new Map<string, number>()
  for (const watch of watches.filter((x) => x.answer === 'regressed')) {
    const cause = regressionCause(watch.failed ?? [])
    causes.set(cause, (causes.get(cause) ?? 0) + 1)
  }
  return REGRESSION_CAUSES.flatMap(([key, label]) =>
    causes.has(key) ? [part(key, `Regressed: ${label}`, (causes.get(key) ?? 0) / watches.length, 'share')] : [],
  )
}

/** The flow figures of one window, as parts and beside-figures of the KPIs they explain. */
export interface FlowFigures {
  /** cycle_p50's parts: the ms Issues spent in each state and wait reason, largest first */
  cycleParts: KpiPart[]
  /** beside cycle_p50: the working share and the dropped-after-lead share */
  cycleBeside: KpiPart[]
  /** beside queue_wait_p90: the share of queued hours in which an account had room */
  queueBeside: KpiPart[]
  /** beside errands_reached_per_100: the share of raised Errands the screen turned away */
  errandsBeside: KpiPart[]
  /** beside first_verification_passes: the first watches' median dwell */
  passBeside: KpiPart[]
}

/** A share as a part, or nothing under `MIN_SAMPLES`: a part with no reading is not shown. */
const sharePart = (key: string, label: string, count: number, n: number): KpiPart[] => {
  const value = shareOf(count, n)
  return value === null ? [] : [part(key, label, value, 'share')]
}

/** The flow figures of one window. The keys of the beside-figures are the KPI keys they had, so a retro marker naming one still reads it. */
export async function flowFigures(sql: SQL, w: Window): Promise<FlowFigures> {
  const idle = await idleHours(sql, w)
  const time = await stateTime(sql, w)
  const states = time.ms
  const closed = await closedWithLead(sql, w)
  const errands = await errandCounts(sql, w)
  const watches = await firstWatches(sql, w)

  const working = states.get('working') ?? 0
  const waiting = [...states].filter(([key]) => key.startsWith('waiting:')).reduce((sum, [, ms]) => sum + ms, 0)
  const dwell = percentile(
    watches.map((x) => x.ms),
    0.5,
  )

  return {
    cycleParts: [...states]
      .toSorted((a, b) => b[1] - a[1])
      .map(([key, ms]) =>
        part(key, key.startsWith('waiting:') ? `Waiting: ${key.slice('waiting:'.length)}` : key, ms, 'ms'),
      ),
    cycleBeside: [
      ...(time.n < MIN_SAMPLES || working + waiting === 0
        ? []
        : [part('working_share', 'Working, of working and waiting', working / (working + waiting), 'share')]),
      ...sharePart(
        'dropped_after_lead',
        'Closed dropped or cancelled after a lead started',
        closed.dropped + closed.cancelled,
        closed.n,
      ),
    ],
    queueBeside: sharePart('idle_capacity', 'Queued hours with an account that had room', idle.idle, idle.hours),
    errandsBeside: sharePart(
      'errands_turned_away',
      'Raised Errands the screen turned away',
      errands.rule + errands.judge,
      errands.n,
    ),
    passBeside:
      dwell === null || watches.length < MIN_SAMPLES
        ? []
        : [part('first_watch_dwell_p50', 'First watch dwell, median', dwell, 'ms')],
  }
}
