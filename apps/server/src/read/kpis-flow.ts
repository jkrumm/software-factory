import type { SQL } from 'bun'
import * as z from 'zod'
import type { Kpi, KpiPart } from '@software-factory/contract'
import { percentile, per } from './stats.ts'
import type { Window } from './kpis.ts'

/**
 * The KPIs the event log, the checkpoint tables and the delivery log answer by themselves: where Issues waited and why, how
 * much capacity sat idle behind a non-empty queue, how a lead's time divides, what was spent on Issues that were dropped,
 * what the loops' own paths cost (amends, nudges, notes, Errands) and why a first watch regressed. Each is read-only SQL over
 * one window, so each can be checked by SQL over the same window (`apps/server/test/read-models/kpis-flow.test.ts`).
 */

type Figure = Omit<Kpi, 'history' | 'target'> & { target?: Kpi['target'] }

const Duration = z.object({ ms: z.coerce.number() })

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

/** The Issue events that count as a lead visibly acting after a nudge (a lead's own verb, not a note). */
const ACTION_KINDS = ['shipped', 'asked', 'deferred', 'closed', 'submitted', 'errand_raised', 'stalled'] as const
/** How long after a steward's note a lead's action still counts as its answer. */
export const NUDGE_ANSWER_MS = 30 * 60_000

/** An account has room while its five-hour window is below this share and the week is not nearly used. */
export const ROOM_FIVE_HOUR_BELOW = 50
export const ROOM_WEEKLY_BELOW = 90

const part = (key: string, label: string, value: number, unit: KpiPart['unit']): KpiPart => ({
  key,
  label,
  value,
  unit,
})

/** Queued time that ended in the window, in ms, and how much of it an unmet `after` edge held. */
async function queuedTime(sql: SQL, w: Window) {
  const [row] = await sql`
    WITH ev AS (
      SELECT issue_id, to_state, at, lead(at) OVER (PARTITION BY issue_id ORDER BY version) AS nxt
      FROM factory.issue_events WHERE result = 'applied'),
    q AS (SELECT issue_id, at AS s, nxt AS e FROM ev WHERE to_state = 'queued' AND nxt >= ${w.from} AND nxt < ${w.to}),
    b AS (
      SELECT issue_id, min(created_at) AS b0, max(coalesce(satisfied_at, ${NEVER})) AS b1
      FROM factory.planning_edges GROUP BY issue_id)
    SELECT count(*) AS n,
      coalesce(sum(extract(epoch FROM q.e - q.s)), 0) * 1000 AS total_ms,
      coalesce(sum(CASE WHEN b.issue_id IS NULL THEN 0
        ELSE extract(epoch FROM greatest(least(q.e, b.b1) - greatest(q.s, b.b0), interval '0')) END), 0) * 1000 AS chain_ms
    FROM q LEFT JOIN b ON b.issue_id = q.issue_id`
  const parsed = z.object({ n: z.coerce.number(), total_ms: z.coerce.number(), chain_ms: z.coerce.number() }).parse(row)
  return { n: parsed.n, total: parsed.total_ms, chain: parsed.chain_ms }
}

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

/** Signals received in the window, and those that amended an open Issue instead of filing one. */
async function signalCounts(sql: SQL, w: Window) {
  const [row] = await sql`
    SELECT count(*) AS n, count(*) FILTER (WHERE state = 'amended') AS amended
    FROM factory.intake_signals WHERE received_at >= ${w.from} AND received_at < ${w.to}`
  return z.object({ n: z.coerce.number(), amended: z.coerce.number() }).parse(row)
}

/** Steward notes sent in the window, and those a lead's own verb followed within `NUDGE_ANSWER_MS`. */
async function nudges(sql: SQL, w: Window) {
  const [row] = await sql`
    SELECT count(*) AS n, count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM factory.issue_events x
      WHERE x.issue_id = n.issue_id AND x.result = 'applied' AND x.actor = 'lead'
        AND x.kind IN ${sql([...ACTION_KINDS])}
        AND x.at > n.at AND x.at <= n.at + ${NUDGE_ANSWER_MS / 1000}::int * interval '1 second')) AS acted
    FROM factory.issue_events n
    WHERE n.kind = 'noted' AND n.actor = 'steward' AND n.result = 'applied' AND n.at >= ${w.from} AND n.at < ${w.to}`
  return z.object({ n: z.coerce.number(), acted: z.coerce.number() }).parse(row)
}

/** Seconds from claimed to typed of the notes the lead only got by force (typed into a busy prompt), in ms. */
async function forcedNoteDelays(sql: SQL, w: Window): Promise<number[]> {
  const rows: unknown[] = await sql`
    SELECT extract(epoch FROM typed_at - claimed_at) * 1000 AS ms FROM factory.lead_deliveries
    WHERE kind = 'note' AND forced AND typed_at IS NOT NULL AND claimed_at >= ${w.from} AND claimed_at < ${w.to}`
  return rows.map((raw) => Duration.parse(raw).ms)
}

/** Errands raised in the window, by what the screen did before the owner saw them. */
async function errandCounts(sql: SQL, w: Window) {
  const [row] = await sql`
    SELECT count(*) AS n,
      count(*) FILTER (WHERE turned_away_at IS NOT NULL AND screen_by = 'rule') AS rule,
      count(*) FILTER (WHERE turned_away_at IS NOT NULL AND screen_by = 'judge') AS judge
    FROM factory.errands WHERE raised_at >= ${w.from} AND raised_at < ${w.to}`
  return z.object({ n: z.coerce.number(), rule: z.coerce.number(), judge: z.coerce.number() }).parse(row)
}

/** First watches that ended in the window: how many, how long each took, and the cause of each regression. */
async function firstWatches(sql: SQL, w: Window) {
  const rows: unknown[] = await sql`
    SELECT w.answer, extract(epoch FROM w.answered_at - w.started_at) * 1000 AS ms,
      (SELECT array_agg((c->>'name') || '|' || coalesce(c->>'detail', ''))
        FROM (SELECT k.checks FROM factory.quality_checks k WHERE k.watch_key = w.key ORDER BY k.n DESC LIMIT 1) l,
        jsonb_array_elements(l.checks) c WHERE (c->>'ok')::boolean = false) AS failed
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

const kpi = (k: Figure): Omit<Kpi, 'history'> => ({ ...k, target: k.target ?? { kind: 'unset', min: null, max: null } })

const TREND = { kind: 'trend', min: null, max: null } as const

/** The flow KPIs of one window. */
export async function flowKpis(sql: SQL, w: Window): Promise<Array<Omit<Kpi, 'history'>>> {
  const queued = await queuedTime(sql, w)
  const idle = await idleHours(sql, w)
  const time = await stateTime(sql, w)
  const states = time.ms
  const closed = await closedWithLead(sql, w)
  const signals = await signalCounts(sql, w)
  const steward = await nudges(sql, w)
  const delays = await forcedNoteDelays(sql, w)
  const errands = await errandCounts(sql, w)
  const watches = await firstWatches(sql, w)

  const working = states.get('working') ?? 0
  const waiting = [...states].filter(([key]) => key.startsWith('waiting:')).reduce((sum, [, ms]) => sum + ms, 0)
  const stateParts = [...states]
    .toSorted((a, b) => b[1] - a[1])
    .map(([key, ms]) =>
      part(key, key.startsWith('waiting:') ? `Waiting: ${key.slice('waiting:'.length)}` : key, ms, 'ms'),
    )

  const regressed = watches.filter((x) => x.answer === 'regressed')
  const causes = new Map<string, number>()
  for (const watch of regressed) {
    const cause = regressionCause(watch.failed ?? [])
    causes.set(cause, (causes.get(cause) ?? 0) + 1)
  }
  const dwell = (answer: 'passed' | 'regressed') =>
    percentile(
      watches.filter((x) => x.answer === answer).map((x) => x.ms),
      0.5,
    )
  const delayed = percentile(delays, 0.5)

  return [
    kpi({
      key: 'queue_time',
      label: 'Queued time by reason',
      value: queued.n === 0 ? null : queued.total,
      unit: 'ms',
      n: queued.n,
      count: null,
      target: TREND,
      measured: true,
      definition:
        'The time Issues spent queued, for the queue intervals that ended in the window (admitted, cancelled or closed), and how much of it an `after` edge held: from the first edge’s creation to the last one’s satisfaction, cut to the interval. The rest is capacity (the repo’s lead cap, a seat, a slot, the account windows, the queue state): the factory does not record which, per interval.',
      parts:
        queued.n === 0
          ? []
          : [
              part('chain', 'Held by an after edge', queued.chain, 'ms'),
              part('capacity', 'Capacity, cap or the queue state', Math.max(0, queued.total - queued.chain), 'ms'),
            ],
    }),
    kpi({
      key: 'idle_capacity',
      label: 'Idle capacity behind a queue',
      value: per(idle.idle, idle.hours),
      unit: 'share',
      n: idle.hours,
      count: idle.idle,
      target: TREND,
      measured: true,
      definition: `Of the hours of the window (read at the top of the hour) in which an Issue no after edge held sat queued, the share in which an enabled, signed-in account that was not exhausted had room: its five-hour window under ${ROOM_FIVE_HOUR_BELOW} % and its week under ${ROOM_WEEKLY_BELOW} %. Hours with no capacity reading (the readings are kept a week) are left out, so an older window has no data. A queue that waits behind a timer, a repo’s lead cap or a slot shows here.`,
      parts: [],
    }),
    kpi({
      key: 'working_share',
      label: 'Working share of a lead’s time',
      value: per(working, working + waiting),
      unit: 'share',
      n: time.n,
      count: null,
      target: TREND,
      measured: true,
      definition:
        'Of the time Issues spent working or waiting (a wait on a Decision, a review, an Errand, a timer, a dependency, a block), for the intervals that ended in the window, the share spent working. The parts are the ms in each state and wait reason, watching included; that a lead working is itself waiting on a background run is in the transcripts (`factory retro`), not here.',
      parts: stateParts,
    }),
    kpi({
      key: 'dropped_after_lead',
      label: 'Issues dropped or cancelled after a lead started',
      value: per(closed.dropped + closed.cancelled, closed.n),
      unit: 'share',
      n: closed.n,
      count: closed.dropped + closed.cancelled,
      target: TREND,
      measured: true,
      definition:
        'Of the Issues that closed in the window after a lead had been admitted to them, the share that closed dropped (the lead gave it up) or cancelled (the owner stopped it): a lead’s time that shipped nothing, whether the Issue was a duplicate, misrouted or noise. Not split by reason: that is words.',
      parts:
        closed.n === 0
          ? []
          : [
              part('dropped', 'Dropped by the lead', closed.dropped / closed.n, 'share'),
              part('cancelled', 'Cancelled by the owner', closed.cancelled / closed.n, 'share'),
            ],
    }),
    kpi({
      key: 'amend_rate',
      label: 'Signals that amended an Issue',
      value: per(signals.amended, signals.n),
      unit: 'share',
      n: signals.n,
      count: signals.amended,
      target: TREND,
      measured: true,
      definition:
        'Of the signals received in the window, the share that amended an Issue already open (its fingerprint or its words matched) instead of filing a new one.',
      parts: [],
    }),
    kpi({
      key: 'nudges_acted',
      label: 'Steward nudges a lead acted on',
      value: per(steward.acted, steward.n),
      unit: 'share',
      n: steward.n,
      count: steward.acted,
      target: TREND,
      measured: true,
      definition: `Of the notes the steward sent in the window, the share followed within ${NUDGE_ANSWER_MS / 60_000} minutes by the lead's own verb on that Issue (${ACTION_KINDS.join(', ')}). A lead that only keeps working is not counted: the event log shows no action.`,
      parts: [],
    }),
    kpi({
      key: 'forced_note_delay_p50',
      label: 'Forced note delivery delay, median',
      value: delayed,
      unit: 'ms',
      n: delays.length,
      count: null,
      target: TREND,
      measured: true,
      definition:
        'The time from a note’s claim to its typing, for the notes that could be typed only by force into a busy prompt and were claimed in the window. The part is the 90th percentile.',
      parts: delays.length === 0 ? [] : [part('p90', '90th percentile', percentile(delays, 0.9) ?? 0, 'ms')],
    }),
    kpi({
      key: 'errands_turned_away',
      label: 'Errands the screen turned away',
      value: per(errands.rule + errands.judge, errands.n),
      unit: 'share',
      n: errands.n,
      count: errands.rule + errands.judge,
      target: TREND,
      measured: true,
      definition:
        'Of the Errands raised in the window, the share the screen (its rules, then the Judge) turned away before they reached the owner: a CLI call a token can make, a step the lead had a way round. What reached him and he found needless is his word, not counted.',
      parts:
        errands.n === 0
          ? []
          : [
              part('rule', 'Turned away by a rule', errands.rule / errands.n, 'share'),
              part('judge', 'Turned away by the Judge', errands.judge / errands.n, 'share'),
            ],
    }),
    kpi({
      key: 'regression_cause',
      label: 'Regressed first watches, by cause',
      value: per(regressed.length, watches.length),
      unit: 'share',
      n: watches.length,
      count: regressed.length,
      target: TREND,
      measured: true,
      definition:
        'Of the first watches that ended in the window, the share that regressed, split by what failed in its last run: the CI, the project’s verify, a deployed version that lacks the landed commit, a missing version probe, the checkout, another check. The first of these in that order names a regression that failed several. Which of them was the change’s fault is for a reader of the sample, not this count.',
      parts: REGRESSION_CAUSES.flatMap(([key, label]) =>
        causes.has(key) ? [part(key, label, (causes.get(key) ?? 0) / watches.length, 'share')] : [],
      ),
    }),
    kpi({
      key: 'first_watch_dwell_p50',
      label: 'First watch, median time to its answer',
      value: percentile(
        watches.map((x) => x.ms),
        0.5,
      ),
      unit: 'ms',
      n: watches.length,
      count: null,
      target: TREND,
      measured: true,
      definition:
        'The median time from a first watch’s start to its answer, for those answered in the window. A pass rate over watches that answer in seconds checks little: this is the number to read beside first verification passes. The parts are the medians for the passed and the regressed.',
      parts: [
        ...(dwell('passed') === null ? [] : [part('passed', 'Passed', dwell('passed') ?? 0, 'ms' as const)]),
        ...(dwell('regressed') === null
          ? []
          : [part('regressed', 'Regressed', dwell('regressed') ?? 0, 'ms' as const)]),
      ],
    }),
  ]
}
