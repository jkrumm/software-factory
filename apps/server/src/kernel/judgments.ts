import {
  type AnswerOutcome,
  type JudgmentAnswer,
  type JudgmentLedger,
  type LedgerJudge,
  judgeOverTheLine,
} from '@software-factory/contract'

// What became of a judge's answers, judged from the events that followed (`read/judgments.ts`). Pure: the read hands it rows.

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** How long after its answer each judge's answer is watched, in ms: an answer nothing contradicted by then stood. */
export const HORIZON_MS = {
  /** the owner replaced a Judge answer with his own answer or a note */
  judge: 7 * DAY,
  /** the Issue moved this soon after a wake or a requeue */
  stewardMoved: 30 * MINUTE,
  /** the Issue stalled again on the same cause within this long */
  stewardStalled: DAY,
  /** a dismissed fingerprint, a split-off amend, a turned-away or not-needed Errand came back */
  raisedAgain: 14 * DAY,
} as const

/** Every ledger judge in the order the screen shows them, with what it is called and the rule that says an answer did not stand. */
const LEDGER: Readonly<Record<LedgerJudge, { label: string; rule: string }>> = {
  judge: {
    label: 'The Judge (Decisions)',
    rule: 'the owner or his delegate answered the Decision himself or noted the Issue within 7 days',
  },
  steward: {
    label: 'The steward (stalled Issues)',
    rule: 'after a wake or requeue the Issue did not move within 30 minutes, or stalled again on the same cause within a day',
  },
  triage: {
    label: 'Triage (amends and edges)',
    rule: 'an amend whose words came back as their own Issue within 14 days, or an edge whose Issues touched no file in common',
  },
  queue: {
    label: 'The queue loop (edges)',
    rule: 'an edge whose Issues touched no file in common, or one the loop took back',
  },
  screen: {
    label: 'The screen (quarantined signals)',
    rule: 'a dismissed signal came back as work within 14 days',
  },
  errand: {
    label: 'The Errand screen (turned away)',
    rule: 'the same need was raised again within 14 days of the turn-away',
  },
  errandNeeded: {
    label: 'The Errand check (closed as not needed)',
    rule: 'the same need was raised again within 14 days of the close',
  },
}

const DID_NOT_STAND: ReadonlySet<AnswerOutcome> = new Set(['overruled', 'raised_again'])

/** The share of decided answers that did not stand; null when none was decided. */
function shareOf(stood: number, didNotStand: number): number | null {
  const decided = stood + didNotStand
  return decided === 0 ? null : didNotStand / decided
}

const NEWEST = 3

/** One judge's ledger from its answers (any order): counts by outcome, the share and the three newest that did not stand. */
export function foldAnswers(judge: LedgerJudge, rows: readonly JudgmentAnswer[]): JudgmentLedger {
  const stood = rows.filter((row) => row.outcome === 'stood').length
  const failed = rows.filter((row) => DID_NOT_STAND.has(row.outcome))
  return {
    judge,
    label: LEDGER[judge].label,
    rule: LEDGER[judge].rule,
    answers: rows.length,
    stood,
    didNotStand: failed.length,
    unknown: rows.length - stood - failed.length,
    share: shareOf(stood, failed.length),
    newest: failed.toSorted((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, NEWEST),
  }
}

/** Whether a judge's ledger is a finding (`judgeOverTheLine`, the one rule the Improve screen shares). */
export const isFinding = (ledger: Pick<JudgmentLedger, 'stood' | 'didNotStand' | 'share'>): boolean =>
  judgeOverTheLine(ledger)
