import type { SQL } from 'bun'
import * as z from 'zod'
import {
  type Effort,
  REVIEWER_CHEAP_ROLE,
  REVIEWER_ROLE,
  REVIEWER_START_SHARE,
  REVIEWER_TRIPWIRE_DAYS,
  REVIEWER_TRIPWIRE_POINTS,
  REVIEWER_TRIPWIRE_REVIEWS,
  REVIEWER_WINDOW_MIN_ISSUES,
  reviewerTripwire,
  type SeatEvidence,
  type ReviewerKpiRow,
  type ReviewerKpis,
  type Tier,
} from '@software-factory/contract'
import { percentile, per, windowOf } from './stats.ts'

type Seat = ReviewerKpiRow['seat']

interface Window {
  from: Date
  to: Date
}

/** One recorded review: a thread of agw's ledger that covered a ship, with the seat it ran on. */
const Review = z.object({
  issue_id: z.string(),
  /** the attempt's lead ran on the light seat: its Issues are not like the others and stay out of the tripwire */
  light: z.boolean(),
  at: z.coerce.date(),
  assigned: z.string(),
  role: z.string(),
  tier: z.string(),
  rounds: z.coerce.number().int(),
  wall_ms: z.coerce.number().nullable(),
  findings: z.coerce.number().int(),
  applied: z.coerce.number().int(),
  declined: z.coerce.number().int(),
})
export type Review = z.infer<typeof Review>

/** What became of an Issue whose ship carried recorded reviews. */
const Outcome = z.object({
  issue_id: z.string(),
  light: z.boolean(),
  at: z.coerce.date(),
  assigned: z.string(),
  first_watch: z.string().nullable(),
  regressed: z.boolean(),
})
export type Outcome = z.infer<typeof Outcome>

/**
 * The reviews and the Issues of the first accepted ship of each Issue whose evidence names the reviewer seat: the review
 * its first watch followed, so a re-ship after a regression (often with no review of its own) cannot move the regression
 * to an Issue with no reviews. Older
 * evidence has no `reviewer` and no `threads`, so nothing before the seat existed is counted.
 */
async function recordsOf(sql: SQL): Promise<{ reviews: Review[]; outcomes: Outcome[] }> {
  const reviews: unknown[] = await sql`
    WITH first_ship AS (
      SELECT DISTINCT ON (e.issue_id) e.issue_id, e.at, e.payload, EXISTS (
          SELECT 1 FROM factory.issue_events s
          WHERE s.issue_id = e.issue_id AND s.kind = 'lead_started' AND s.result = 'applied'
            AND (s.payload->>'attempt')::int = e.attempt AND s.payload->'seat'->>'rule' IS NOT NULL) AS light
      FROM factory.quality_evidence e
      WHERE e.kind = 'review' AND e.payload ? 'reviewer'
      ORDER BY e.issue_id, e.at)
    SELECT l.issue_id, l.light, l.at, l.payload->>'reviewer' AS assigned, t->'seat'->>'role' AS role, t->>'tier' AS tier,
      (t->>'rounds')::int AS rounds, t->>'wallMs' AS wall_ms,
      (t->'findings'->>'total')::int AS findings, (t->'findings'->>'applied')::int AS applied,
      (t->'findings'->>'declined')::int AS declined
    FROM first_ship l, jsonb_array_elements(coalesce(l.payload->'threads', '[]'::jsonb)) t`
  const outcomes: unknown[] = await sql`
    WITH first_ship AS (
      SELECT DISTINCT ON (e.issue_id) e.issue_id, e.at, e.payload->>'reviewer' AS assigned, EXISTS (
          SELECT 1 FROM factory.issue_events s
          WHERE s.issue_id = e.issue_id AND s.kind = 'lead_started' AND s.result = 'applied'
            AND (s.payload->>'attempt')::int = e.attempt AND s.payload->'seat'->>'rule' IS NOT NULL) AS light
      FROM factory.quality_evidence e
      WHERE e.kind = 'review' AND e.payload ? 'reviewer'
      ORDER BY e.issue_id, e.at)
    SELECT l.issue_id, l.light, l.at, l.assigned,
      (SELECT w.answer FROM factory.quality_watches w
        WHERE w.issue_id = l.issue_id AND w.watch = 1 AND w.answer IN ('passed', 'regressed')) AS first_watch,
      EXISTS (SELECT 1 FROM factory.quality_watches w WHERE w.issue_id = l.issue_id AND w.answer = 'regressed') AS regressed
    FROM first_ship l`
  return { reviews: reviews.map((row) => Review.parse(row)), outcomes: outcomes.map((row) => Outcome.parse(row)) }
}

const seatOfRole = (role: string): Seat => (role === REVIEWER_CHEAP_ROLE ? 'cheap' : 'plain')
const isDeep = (review: Review) => review.tier === 'deep'

/**
 * The Issues of a seat: the ones assigned its row that had at least one non-deep review (a deep-only Issue tested neither
 * seat), with what became of each.
 */
function issuesOf(seat: Seat, reviews: readonly Review[], outcomes: readonly Outcome[]): Outcome[] {
  const reviewed = new Set(reviews.filter((review) => !isDeep(review)).map((review) => review.issue_id))
  return outcomes.filter((outcome) => seatOfRole(outcome.assigned) === seat && reviewed.has(outcome.issue_id))
}

/**
 * The tripwire's evidence of one seat: its non-deep reviews and its Issues' first verifications and regressions. Issues
 * whose lead ran on the light seat are left out of both seats: the cheap row has all of them and the other row none, and
 * mechanical work with a proving check passes more often whatever the reviewer, so they would flatter the cheap row. What
 * is compared is the even and odd Issue numbers of the rest.
 */
function evidenceOf(seat: Seat, reviews: readonly Review[], outcomes: readonly Outcome[]): SeatEvidence {
  const like = reviews.filter((review) => !review.light)
  const issues = issuesOf(
    seat,
    like,
    outcomes.filter((outcome) => !outcome.light),
  ).filter((outcome) => outcome.first_watch !== null)
  return {
    reviews: like.filter((review) => seatOfRole(review.role) === seat && !isDeep(review)).length,
    issues: issues.length,
    passed: issues.filter((outcome) => outcome.first_watch === 'passed').length,
    regressed: issues.filter((outcome) => outcome.regressed).length,
  }
}

const shown = (evidence: SeatEvidence) => ({
  reviews: evidence.reviews,
  issues: evidence.issues,
  firstPassRate: per(evidence.passed, evidence.issues),
  regressionRate: per(evidence.regressed, evidence.issues),
})

const within = <T extends { at: Date }>(rows: readonly T[], w: Window): T[] =>
  rows.filter((row) => row.at >= w.from && row.at < w.to)

/**
 * The tripwire from every recorded review of all time and the cheap row's last days; the same call the lead start asks
 * (`reviewerTakesAll`), so what the page shows is what decides.
 */
function tripwireOf(reviews: readonly Review[], outcomes: readonly Outcome[], now: Date): ReviewerKpis['tripwire'] {
  const recent = windowOf(now, REVIEWER_TRIPWIRE_DAYS)
  const cheap = evidenceOf('cheap', reviews, outcomes)
  const plain = evidenceOf('plain', reviews, outcomes)
  const window = evidenceOf('cheap', within(reviews, recent), within(outcomes, recent))
  const verdict = reviewerTripwire({ cheap, plain, window })
  return {
    minReviews: REVIEWER_TRIPWIRE_REVIEWS,
    points: REVIEWER_TRIPWIRE_POINTS,
    windowDays: REVIEWER_TRIPWIRE_DAYS,
    windowMinIssues: REVIEWER_WINDOW_MIN_ISSUES,
    cheap: shown(cheap),
    plain: shown(plain),
    window: shown(window),
    enough: verdict.enough,
    passOk: verdict.passOk,
    regressOk: verdict.regressOk,
    windowBreaks: verdict.windowBreaks,
    takesAll: verdict.takesAll,
  }
}

/** Whether the cheap reviewer row takes every non-deep review now: what a lead's start asks. */
export async function reviewerTakesAll(sql: SQL, now: Date): Promise<boolean> {
  const { reviews, outcomes } = await recordsOf(sql)
  return tripwireOf(reviews, outcomes, now).takesAll
}

/** The reviewer-agent dollars of a seat's Issues, split by the seat that ran them; null while the usage schema cannot be read. */
export type ReviewerCost = (issues: readonly string[]) => Promise<{ cheap: number; plain: number } | null>

function rowOf(input: {
  seat: Seat
  role: string
  rowOfTable: { tier: Tier; effort: Effort } | null
  reviews: readonly Review[]
  outcomes: readonly Outcome[]
  cost: number | null
}): ReviewerKpiRow {
  const { seat } = input
  const mine = input.reviews.filter((review) => seatOfRole(review.role) === seat)
  const plain = mine.filter((review) => !isDeep(review))
  const issues = issuesOf(seat, input.reviews, input.outcomes)
  const passes = issues.filter((outcome) => outcome.first_watch !== null)
  const findings = plain.reduce((sum, review) => sum + review.findings, 0)
  const applied = plain.reduce((sum, review) => sum + review.applied, 0)
  const declined = plain.reduce((sum, review) => sum + review.declined, 0)
  return {
    seat,
    role: input.role,
    tier: input.rowOfTable?.tier ?? null,
    effort: input.rowOfTable?.effort ?? null,
    reviews: plain.length,
    deepReviews: mine.length - plain.length,
    findings,
    findingsPerReview: per(findings, plain.length),
    applied,
    declined,
    appliedShare: per(applied, applied + declined),
    roundsPerReview: per(
      plain.reduce((sum, review) => sum + review.rounds, 0),
      plain.length,
    ),
    issues: issues.length,
    firstWatches: passes.length,
    firstPassRate: per(passes.filter((outcome) => outcome.first_watch === 'passed').length, passes.length),
    regressedIssues: passes.filter((outcome) => outcome.regressed).length,
    regressionRate: per(passes.filter((outcome) => outcome.regressed).length, passes.length),
    costPerReview: input.cost === null ? null : per(input.cost, mine.length),
    wallP50Ms: percentile(
      plain.flatMap((review) => (review.wall_ms === null ? [] : [review.wall_ms])),
      0.5,
    ),
  }
}

/**
 * The reviewer seats side by side for the window (the reviews whose ship was recorded in it) and the tripwire over the
 * whole record. `table` is the role table's two rows as they stand, for the words next to the numbers.
 */
export async function readReviewerKpis(
  sql: SQL,
  w: Window,
  options: {
    now: Date
    table: { cheap: { tier: Tier; effort: Effort } | null; reviewer: { tier: Tier; effort: Effort } | null }
    cost: ReviewerCost | null
  },
): Promise<ReviewerKpis> {
  const all = await recordsOf(sql)
  const reviews = within(all.reviews, w)
  const outcomes = within(all.outcomes, w)
  const priced = options.cost ? await options.cost([...new Set(outcomes.map((outcome) => outcome.issue_id))]) : null
  const row = (seat: Seat) =>
    rowOf({
      seat,
      role: seat === 'cheap' ? REVIEWER_CHEAP_ROLE : REVIEWER_ROLE,
      rowOfTable: seat === 'cheap' ? options.table.cheap : options.table.reviewer,
      reviews,
      outcomes,
      cost: priced ? priced[seat] : null,
    })
  return {
    rows: [row('plain'), row('cheap')],
    startShare: REVIEWER_START_SHARE,
    tripwire: tripwireOf(all.reviews, all.outcomes, options.now),
  }
}
