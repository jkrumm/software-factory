import type { SQL } from 'bun'
import * as z from 'zod'
import {
  ANSWER_OUTCOMES,
  type JudgmentAnswer,
  type JudgmentsModel,
  LEDGER_JUDGES,
  type LedgerJudge,
  THRESHOLDS,
} from '@software-factory/contract'
import { isCut } from '../kernel/epoch.ts'
import { foldAnswers, HORIZON_MS } from '../kernel/judgments.ts'
import { scrub } from '../kernel/scrub.ts'
import { boundedRead } from './bounded.ts'
import { edgeFacts } from './edge-need.ts'
import { windowOf } from './stats.ts'
import { isWorkRepo, loadOpenProjects } from './work.ts'

/**
 * The judge ledger: what became of each judge's answers, read from the events that followed, with no column of its own
 * (`docs/architecture.md`, "The judge ledger"). Each judge has one SQL expression, `outcomeOf`, that says from the stored
 * facts whether an answer stood, was overruled, or came back (`raised_again`); an answer whose horizon has not passed and
 * that nothing contradicted is `unknown` and is left out of the share. The case file's precedents use the same expressions.
 */

/** Rows read per judge: a window of the busiest judge (the screen) is hundreds, never this many. */
const CAP = 5_000
const TEXT = 300
const HIDDEN = 'An answer in a work repository.'

const secs = (ms: number): number => ms / 1000

/**
 * The outcome of one answer as a SQL expression over the aliases of its table (`d` decisions, `c` loop_calls, `s`
 * intake_signals, `e` errands); `now` is when the read runs.
 */
export function outcomeOf(sql: SQL, judge: LedgerJudge, now: Date) {
  switch (judge) {
    case 'judge':
      return sql`CASE
        WHEN d.settled_by IS DISTINCT FROM 'judge' THEN 'unknown'
        WHEN EXISTS (SELECT 1 FROM factory.issue_events n
          WHERE n.issue_id = d.issue_id AND n.result = 'applied' AND n.actor IN ('owner', 'orchestrator')
            AND n.at > d.answered_at AND n.at <= d.answered_at + make_interval(secs => ${secs(HORIZON_MS.judge)}::float8)
            AND (n.kind = 'noted' OR (n.kind = 'answered' AND n.payload->>'decision' = d.id))) THEN 'overruled'
        WHEN d.answered_at + make_interval(secs => ${secs(HORIZON_MS.judge)}::float8) <= ${now} THEN 'stood'
        ELSE 'unknown' END`
    case 'steward':
      return sql`CASE
        WHEN c.loop <> 'steward' OR c.outcome IS DISTINCT FROM 'answered' OR c.answer->>'action' NOT IN ('wake', 'requeue') THEN 'unknown'
        WHEN EXISTS (SELECT 1 FROM factory.issue_events r
          WHERE r.issue_id = c.issue_id AND r.result = 'applied' AND r.to_state = 'waiting' AND r.from_state IS DISTINCT FROM 'waiting'
            AND r.at > c.finished_at AND r.at <= c.finished_at + make_interval(secs => ${secs(HORIZON_MS.stewardStalled)}::float8)
            AND r.wait->>'reason' = (SELECT w.wait->>'reason' FROM factory.issue_events w
              WHERE w.issue_id = c.issue_id AND w.result = 'applied'
                AND w.version = CASE WHEN c.subject ~ '^wait:[0-9]+$' THEN substring(c.subject from 6)::int END)) THEN 'raised_again'
        WHEN EXISTS (SELECT 1 FROM factory.issue_events m
          WHERE m.issue_id = c.issue_id AND m.result = 'applied' AND m.kind <> 'woken' AND m.to_state IS DISTINCT FROM m.from_state
            AND m.at > c.finished_at AND m.at <= c.finished_at + make_interval(secs => ${secs(HORIZON_MS.stewardMoved)}::float8)) THEN 'stood'
        WHEN c.finished_at + make_interval(secs => ${secs(HORIZON_MS.stewardMoved)}::float8) <= ${now} THEN 'overruled'
        ELSE 'unknown' END`
    case 'triage':
      // an amend of a signal: it stood unless the same words came back as an Issue of their own
      return sql`CASE
        WHEN s.state IS DISTINCT FROM 'amended' THEN 'unknown'
        WHEN EXISTS (SELECT 1 FROM factory.intake_signals t
          WHERE t.source = s.source AND t.fingerprint = s.fingerprint AND t.state = 'filed'
            AND t.received_at > s.received_at AND t.received_at <= s.received_at + make_interval(secs => ${secs(HORIZON_MS.raisedAgain)}::float8)) THEN 'raised_again'
        WHEN s.received_at + make_interval(secs => ${secs(HORIZON_MS.raisedAgain)}::float8) <= ${now} THEN 'stood'
        ELSE 'unknown' END`
    case 'queue':
      return sql`'unknown'`
    case 'screen':
      return sql`CASE
        WHEN s.dismissed_by IS DISTINCT FROM 'judge' THEN 'unknown'
        WHEN EXISTS (SELECT 1 FROM factory.intake_signals t
          WHERE t.source = s.source AND t.fingerprint = s.fingerprint AND t.state IN ('filed', 'amended', 'incident', 'promoted')
            AND t.received_at > s.dismissed_at AND t.received_at <= s.dismissed_at + make_interval(secs => ${secs(HORIZON_MS.raisedAgain)}::float8)) THEN 'raised_again'
        WHEN s.dismissed_at + make_interval(secs => ${secs(HORIZON_MS.raisedAgain)}::float8) <= ${now} THEN 'stood'
        ELSE 'unknown' END`
    case 'errand':
      return raisedAgain(sql, now, 'errand')
    case 'errandNeeded':
      return raisedAgain(sql, now, 'errandNeeded')
  }
}

/**
 * An Errand closed by a judge (`at`, `when`): it stood unless the same need, in the same repo, was raised again within the
 * horizon (the same match key, or the same one-line ask).
 */
function raisedAgain(sql: SQL, now: Date, kind: 'errand' | 'errandNeeded') {
  const turned = kind === 'errand'
  const at = turned ? sql`e.turned_away_at` : sql`e.done_at`
  const when = turned ? sql`e.screen_by = 'judge'` : sql`e.closed_by = 'judge' AND e.closed_kind = 'not_needed'`
  return sql`CASE
    WHEN NOT COALESCE(${when}, false) OR ${at} IS NULL THEN 'unknown'
    WHEN EXISTS (SELECT 1 FROM factory.errands f
      LEFT JOIN factory.issues fi ON fi.id = f.issue_id
      LEFT JOIN factory.issues ei ON ei.id = e.issue_id
      WHERE f.id <> e.id AND f.raised_at > ${at} AND f.raised_at <= ${at} + make_interval(secs => ${secs(HORIZON_MS.raisedAgain)}::float8)
        AND fi.repo IS NOT DISTINCT FROM ei.repo
        AND ((e.match_key IS NOT NULL AND f.match_key = e.match_key) OR lower(f.summary) = lower(e.summary))) THEN 'raised_again'
    WHEN ${at} + make_interval(secs => ${secs(HORIZON_MS.raisedAgain)}::float8) <= ${now} THEN 'stood'
    ELSE 'unknown' END`
}

const Row = z.object({
  at: z.coerce.date(),
  issue: z.string().nullable(),
  repo: z.string().nullable(),
  subject: z.string().nullable(),
  answer: z.string().nullable(),
  outcome: z.enum(ANSWER_OUTCOMES),
})

const words = (text: string | null): string =>
  scrub(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT)

interface Span {
  from: Date
  to: Date
  now: Date
}

/** The answers of one judge given in `[from, to)`, newest first, each with its outcome. */
async function answersOf(
  tx: SQL,
  judge: LedgerJudge,
  span: Span,
): Promise<(JudgmentAnswer & { repo: string | null })[]> {
  const { from, to, now } = span
  const outcome = outcomeOf(tx, judge, now)
  let rows: unknown[] = []
  switch (judge) {
    case 'judge':
      rows = await tx`
        SELECT d.answered_at AS at, d.issue_id AS issue, d.repo, d.question AS subject, d.answer, ${outcome} AS outcome
        FROM factory.decisions d
        WHERE d.settled_by = 'judge' AND d.answered_at >= ${from} AND d.answered_at < ${to}
        ORDER BY d.answered_at DESC LIMIT ${CAP}`
      break
    case 'steward':
      rows = await tx`
        SELECT c.finished_at AS at, c.issue_id AS issue, i.repo,
          COALESCE(f.payload->>'title', c.issue_id) AS subject,
          (c.answer->>'action') || ': ' || COALESCE(c.answer->>'reason', '') AS answer, ${outcome} AS outcome
        FROM factory.loop_calls c
        JOIN factory.issues i ON i.id = c.issue_id
        LEFT JOIN factory.issue_events f ON f.issue_id = c.issue_id AND f.kind = 'filed' AND f.version = 1
        WHERE c.loop = 'steward' AND c.outcome = 'answered' AND c.answer->>'action' IN ('wake', 'requeue')
          AND c.finished_at >= ${from} AND c.finished_at < ${to}
        ORDER BY c.finished_at DESC LIMIT ${CAP}`
      break
    case 'triage': {
      const amends: unknown[] = await tx`
        SELECT s.received_at AS at, s.issue_id AS issue, s.repo, s.title AS subject,
          'amended into ' || s.issue_id AS answer, ${outcome} AS outcome
        FROM factory.intake_signals s
        WHERE s.state = 'amended' AND s.key IS NULL AND s.issue_id IS NOT NULL
          AND s.received_at >= ${from} AND s.received_at < ${to}
        ORDER BY s.received_at DESC LIMIT ${CAP}`
      rows = [...amends, ...(await edgeAnswers(tx, 'triage', span))]
      break
    }
    case 'queue':
      rows = await edgeAnswers(tx, 'queue', span)
      break
    case 'screen':
      rows = await tx`
        SELECT s.dismissed_at AS at, s.issue_id AS issue, s.repo, s.title AS subject,
          'dismissed: ' || COALESCE(s.dismissed_reason, '') AS answer, ${outcome} AS outcome
        FROM factory.intake_signals s
        WHERE s.dismissed_by = 'judge' AND s.dismissed_at >= ${from} AND s.dismissed_at < ${to}
        ORDER BY s.dismissed_at DESC LIMIT ${CAP}`
      break
    case 'errand':
      rows = await tx`
        SELECT e.turned_away_at AS at, e.issue_id AS issue, i.repo, e.summary AS subject,
          'turned away: ' || COALESCE(e.screen_note, '') AS answer, ${outcome} AS outcome
        FROM factory.errands e
        LEFT JOIN factory.issues i ON i.id = e.issue_id
        WHERE e.screen_by = 'judge' AND e.turned_away_at >= ${from} AND e.turned_away_at < ${to}
        ORDER BY e.turned_away_at DESC LIMIT ${CAP}`
      break
    case 'errandNeeded':
      rows = await tx`
        SELECT e.done_at AS at, e.issue_id AS issue, i.repo, e.summary AS subject,
          'not needed: ' || COALESCE(e.done_note, '') AS answer, ${outcome} AS outcome
        FROM factory.errands e
        LEFT JOIN factory.issues i ON i.id = e.issue_id
        WHERE e.closed_by = 'judge' AND e.closed_kind = 'not_needed' AND e.done_at >= ${from} AND e.done_at < ${to}
        ORDER BY e.done_at DESC LIMIT ${CAP}`
      break
  }
  return rows
    .map((raw) => Row.parse(raw))
    .map((row) => ({
      at: row.at.toISOString(),
      issue: row.issue,
      repo: row.repo,
      subject: words(row.subject),
      answer: words(row.answer),
      outcome: row.outcome,
    }))
}

/**
 * The edges one source added in the window, as answers: needed (both Issues shipped and touched a file in common) stood,
 * measured and not needed was overruled, a taken-back edge was overruled, the rest is not known yet.
 */
async function edgeAnswers(tx: SQL, source: 'triage' | 'queue', { from, to }: Span): Promise<unknown[]> {
  return tx`
    SELECT f.added_at AS at, f.issue_id AS issue, i.repo,
      f.issue_id || ' waits for ' || f.after_issue AS subject,
      'edge added by ' || f.source || CASE WHEN f.removed THEN ', taken back' ELSE '' END AS answer,
      CASE WHEN f.measured AND f.shared THEN 'stood' WHEN f.measured OR f.removed THEN 'overruled' ELSE 'unknown' END AS outcome
    FROM (${edgeFacts(tx, { from, to })}) f
    JOIN factory.issues i ON i.id = f.issue_id
    WHERE f.source = ${source}
    ORDER BY f.added_at DESC LIMIT ${CAP}`
}

/**
 * The ledger of every judge over the last `days` days (cut at the counting epoch): its answers by what became of them, the
 * share that did not stand, and the three newest that did not. `redact` hides the words of a work repo's answers.
 */
export function readJudgments(
  sql: SQL,
  options: { now: Date; days: number; epoch?: Date | null; redact?: boolean },
): Promise<JudgmentsModel> {
  const { now, days } = options
  const w = windowOf(now, days)
  const since = isCut(w.from, options.epoch ?? null) ? (options.epoch ?? null) : null
  const span = { from: since ?? w.from, to: w.to, now }
  return boundedRead(sql, 30_000, async (tx) => {
    const open = options.redact ? await loadOpenProjects(tx) : []
    const judges = []
    for (const judge of LEDGER_JUDGES) {
      const rows = (await answersOf(tx, judge, span)).map(({ repo, ...row }) =>
        options.redact && isWorkRepo(repo, open) ? { ...row, subject: HIDDEN, answer: '' } : row,
      )
      judges.push(foldAnswers(judge, rows))
    }
    return {
      at: now.toISOString(),
      days,
      window: { from: span.from.toISOString(), to: span.to.toISOString() },
      since: since?.toISOString() ?? null,
      findingShare: THRESHOLDS.judges.share,
      findingMinAnswers: THRESHOLDS.judges.minAnswers,
      judges,
    }
  })
}
