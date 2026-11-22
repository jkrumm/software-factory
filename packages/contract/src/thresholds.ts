import type { FrictionCount, KpiKey, KpiTargetValue } from './read-models.ts'

/**
 * Every number the factory acts on when it judges its own figures, in one table: the targets of the seven KPIs and the rules
 * of the friction loop. The KPI catalog (`kpi-catalog.ts`) and `docs/product.md` read the targets from here, and the friction
 * pass (`apps/server/src/domains/improve/friction.ts`) reads both halves: a KPI off its target over a whole window is a friction
 * finding, the same as a count over its rule. Neither keeps a number of its own.
 */

const HOUR_MS = 3_600_000

const atMost = (max: number): KpiTargetValue => ({ kind: 'at_most', min: null, max })
const atLeast = (min: number): KpiTargetValue => ({ kind: 'at_least', min, max: null })
/** No number yet: the catalog's `targetSource` says why and when one is due. */
const NONE_YET: KpiTargetValue = { kind: 'trend', min: null, max: null }

/** What makes a friction count a finding: `min` is the least count, `rate` the least share of Issues closed in the window (null: the count alone decides), `why` the reason in one line. */
export interface FrictionRule {
  min: number
  rate: number | null
  why: string
}

/** The friction groups whose counts are judged; `decision_answered` and `api_transient` are informational and have no rule. */
export type JudgedFrictionGroup = Exclude<FrictionCount['group'], 'decision_answered' | 'api_transient'>

/**
 * A full window and a lead's own report that it is blocked are the factory working: the steward moves the lead to an open
 * account or holds it on a timer, 20 of 21 and 33 of 48 ended that way in the week to 2026-11-18 with no person, median 2 min.
 * A week at 0.03 and 0.015 per Issue closed is weather; the week one Issue's block loop made 47 of 77 stalls was 0.07, so one
 * in twenty (the level NL37 chose for a regression) tells the two apart. `unreported` stays at the bare count.
 * A block that moved a light lead up is not counted at all (`readFriction`): 47 of the 85 blocks of the week to 2026-11-19.
 */
const STALL_BY_RATE: FrictionRule = {
  min: 3,
  rate: 0.05,
  why: 'a block or a full window on one in twenty closed Issues is a loop or a cap that is wrong; fewer are the steward moving or holding a lead',
}

/**
 * A Watch that ended in a regression is one event the friction counts twice: as `regression` and as the `regressed` stall
 * the Issue waits in. The rule is one, so the two cannot disagree: a watch catching a bad change is the factory working, one
 * closed Issue in twenty ending in one means the changes or the watch are wrong (NL37, NL52). 3 of 1310 closed in the week to
 * 2026-11-20 (0.002) filed `stall:regressed` on the old bare count of 2 while `regression` stayed quiet.
 */
const REGRESSION_RULE: FrictionRule = {
  min: 3,
  rate: 0.05,
  why: 'a watch catching a bad change is the factory working; one closed Issue in twenty ending in a regression means the changes or the watch are wrong',
}

export const THRESHOLDS = {
  /** The seven KPI targets. A `trend` target is a KPI with no number yet; its catalog row says why. */
  kpis: {
    avoidable_touches: atMost(0.07),
    first_verification_passes: atLeast(0.9),
    asks_not_needed: atMost(0.2),
    errands_reached_per_100: NONE_YET,
    cycle_p50: atMost(3 * HOUR_MS),
    queue_wait_p90: atMost(8 * HOUR_MS),
    quota_at_reset: atLeast(0.9),
  } satisfies Record<KpiKey, KpiTargetValue>,
  friction: {
    /** A rate stands on at least this many Issues closed in the window; under it, no rate-judged pattern is a finding. */
    minClosed: 10,
    /** The rule of each group. */
    groups: {
      refusal: {
        min: 3,
        rate: 0.05,
        why: 'the same class of refusal on one in twenty closed Issues is a rule or a prompt that is wrong (a class sums every sha and branch it named: 60 of 1,000 is a finding)',
      },
      stall: { min: 2, rate: null, why: 'a stall twice in a week is a cause, not weather' },
      lead_gone: { min: 2, rate: null, why: 'a lead lost twice in a week points at the host or the harness' },
      undelivered_note: { min: 1, rate: null, why: 'a note that never reached its lead is a broken promise' },
      unreviewed_ship: {
        min: 3,
        rate: 0.25,
        why: 'ships with no review on one in four closed Issues is a habit or a broken review path',
      },
      unstated_acceptance: {
        min: 3,
        rate: 0.25,
        why: 'ships that state nothing against the acceptance on one in four closed Issues is a habit or a brief that never asks',
      },
      unproven_ci: {
        min: 3,
        rate: 0.25,
        why: 'ships whose pull request CI was red or missing on one in four closed Issues is a lead that lands before CI says so, or a repo with no CI',
      },
      regression: REGRESSION_RULE,
      avoidable_touch: {
        min: 3,
        rate: 0.15,
        why: 'the owner stepping in on one in seven closed Issues for the same thing means the factory should have',
      },
      orchestrator_steer: {
        min: 5,
        rate: 0.5,
        why: "the orchestrator steering leads on one in two closed Issues is the factory's real avoidable-touch rate: its leads are not briefed or unblocked well enough to work alone",
      },
      signal: {
        min: 3,
        rate: 0.2,
        why: 'quarantined signals from one source on one in five closed Issues is a route or a trust rule to settle',
      },
      api_refused: {
        min: 10,
        rate: null,
        why: 'one operation refused ten times in a week, with the same status, is a contract the CLI help or the policy does not teach: callers keep sending what it refuses',
      },
      ask_unneeded: {
        min: 2,
        rate: null,
        why: 'two asks in a week from one source that changed nothing when he answered (Looks good with no word, the recommendation taken) is a rule that sends him what its lead could decide',
      },
    } satisfies Record<JudgedFrictionGroup, FrictionRule>,
    /** Rules of one key, over the rule of its group: the touches the owner uses to steer and to triage file only at a higher rate than a touch that is a failure; the stalls the factory ends itself file by rate. */
    keys: {
      'stall:wall': STALL_BY_RATE,
      'stall:blocked': STALL_BY_RATE,
      'stall:regressed': REGRESSION_RULE,
      'touch:noted': {
        min: 5,
        rate: 0.5,
        why: 'owner notes on one in two closed Issues (free-form `issue note` calls, not the orchestrator steering) means the leads are not briefed well enough to work alone',
      },
      'touch:cancelled': {
        min: 3,
        rate: 0.4,
        why: 'owner cancels on two in five closed Issues means the intake files work nobody wanted',
      },
    } satisfies Record<string, FrictionRule>,
  },
  /** The judge ledger (`read/judgments.ts`): a judge whose decided answers did not stand over this share, from at least this many, is a finding. */
  judges: { share: 0.2, minAnswers: 10, windowDays: 30 },
} as const

/** Whether a judge's ledger is a finding: enough decided answers and too large a share of them did not stand (`THRESHOLDS.judges`). Strictly over the share. */
export function judgeOverTheLine(
  ledger: { stood: number; didNotStand: number; share: number | null },
  line: { share: number; minAnswers: number } = THRESHOLDS.judges,
): boolean {
  return ledger.stood + ledger.didNotStand >= line.minAnswers && ledger.share !== null && ledger.share > line.share
}

/** Whether `value` meets `target`; null when the target has no number (a trend, unset). Equal to the bound is met. */
export function meetsTarget({ kind, min, max }: KpiTargetValue, value: number): boolean | null {
  if (kind === 'at_most') return max === null ? null : value <= max
  if (kind === 'at_least') return min === null ? null : value >= min
  if (kind === 'between') return min === null || max === null ? null : value >= min && value <= max
  return null
}
