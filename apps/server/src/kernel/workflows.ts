import {
  ErrandNeededAnswer,
  ErrandNeededRequest,
  ErrandScreenAnswer,
  ErrandScreenRequest,
  HygieneAnswer,
  HygieneRequest,
  JudgeInputWire,
  JudgeVerdictWire,
  QueueAnswer,
  QueueRequest,
  ScreenAnswer,
  ScreenRequest,
  StewardAnswer,
  StewardStall,
  TriageAmendRequest,
  TriageAnswer,
  TriageSettleRequest,
} from '@software-factory/contract'
import type * as z from 'zod'
import { type Key, key } from './keys.ts'

/**
 * How often and how soon a failed call of a workflow is asked again: `tries` calls in all (infinite: no cap), `backoffMs`
 * between them, doubling up to `capMs` when there is one. The callers that retry (a loop's rounds, the Judge's steps, a
 * signal's screening) read their numbers here; the loops' own settings may move `backoffMs`.
 */
export interface RetryRule {
  tries: number
  backoffMs: number
  capMs?: number
}

/** The wait before the try after `attempt` failed ones (the first retry follows attempt 0). */
export const retryDelayMs = (rule: RetryRule, attempt: number): number =>
  rule.capMs === undefined ? rule.backoffMs : Math.min(rule.backoffMs * 2 ** attempt, rule.capMs)

interface Workflow<Request, Answer> {
  /** the `agw` workflow this entry runs */
  agw: string
  request: z.ZodType<Request>
  answer: z.ZodType<Answer>
  /** the leading parts of every idempotency key of this workflow; the caller adds what names the call */
  key: (...parts: readonly (string | number)[]) => Key
  /**
   * The workflow answers a failed model run with a valid neutral answer whose reason starts "<what> unavailable:".
   * Such an answer is not an answer: the call fails (`gone`) and the caller's retry takes it.
   */
  failsWhenUnavailable: boolean
  retry: RetryRule
}

function workflow<Request, Answer>(
  entry: Omit<Workflow<Request, Answer>, 'key'> & { keyed: readonly string[] },
): Workflow<Request, Answer> {
  const { keyed, ...rest } = entry
  return { ...rest, key: (...parts) => key(...keyed, ...parts) }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The Judge's tries, shared by every first-look screen that reuses its Decision step. */
const JUDGE_RETRY: RetryRule = { tries: 3, backoffMs: 5 * MINUTE }
/** A loop's rounds on one subject: asked again after the gap, given up after three. */
const LOOP_RETRY: RetryRule = { tries: 3, backoffMs: 10 * MINUTE }
/** Asked once: a failed call is not retried by any loop (the caller's own fallback takes it). */
const ONCE: RetryRule = { tries: 1, backoffMs: 0 }

/**
 * Every workflow the factory asks of agw, once. A call is `agw.run(name, request, key)`; the adapter is the only code that
 * knows `agw`. The wire shapes come from the contract, the examples both repos parse are `packages/contract/fixtures/loops.json`.
 */
export const WORKFLOWS = {
  /** the Judge: a Decision, answered or handed to the owner */
  judge: workflow({
    agw: 'factory-ask',
    request: JudgeInputWire,
    answer: JudgeVerdictWire,
    keyed: ['factory-ask'],
    failsWhenUnavailable: true,
    retry: JUDGE_RETRY,
  }),
  /** the Errand screen */
  errandScreen: workflow({
    agw: 'factory-errand',
    request: ErrandScreenRequest,
    answer: ErrandScreenAnswer,
    keyed: ['factory-errand'],
    failsWhenUnavailable: false,
    retry: JUDGE_RETRY,
  }),
  /** whether an open Errand is still needed: asked daily, a failure again after six hours */
  errandNeeded: workflow({
    agw: 'factory-errand-needed',
    request: ErrandNeededRequest,
    answer: ErrandNeededAnswer,
    keyed: ['factory-errand-needed'],
    failsWhenUnavailable: false,
    retry: { tries: Number.POSITIVE_INFINITY, backoffMs: 6 * HOUR },
  }),
  /** what a stalled Issue needs when the rules do not say */
  steward: workflow({
    agw: 'factory-steward',
    request: StewardStall,
    answer: StewardAnswer,
    keyed: ['steward'],
    failsWhenUnavailable: true,
    retry: LOOP_RETRY,
  }),
  /** triage for an Issue that is settling: the Issues it must wait for */
  settle: workflow({
    agw: 'factory-triage',
    request: TriageSettleRequest,
    answer: TriageAnswer,
    keyed: ['triage', 'settle'],
    failsWhenUnavailable: true,
    retry: LOOP_RETRY,
  }),
  /** triage for a signal that deterministic matching is unsure about: asked once, a failed call files the signal anew */
  amend: workflow({
    agw: 'factory-triage',
    request: TriageAmendRequest,
    answer: TriageAnswer,
    keyed: ['triage', 'amend'],
    failsWhenUnavailable: false,
    retry: ONCE,
  }),
  /** edges and an order for a repo's queued Issues */
  queue: workflow({
    agw: 'factory-queue',
    request: QueueRequest,
    answer: QueueAnswer,
    keyed: ['queue'],
    failsWhenUnavailable: true,
    retry: LOOP_RETRY,
  }),
  /** the documents a sweep picked, read against the code they describe */
  hygiene: workflow({
    agw: 'factory-hygiene',
    request: HygieneRequest,
    answer: HygieneAnswer,
    keyed: ['hygiene'],
    failsWhenUnavailable: true,
    retry: { tries: 3, backoffMs: 6 * HOUR },
  }),
  /** the Judge's look at one quarantined signal */
  screen: workflow({
    agw: 'factory-screen',
    request: ScreenRequest,
    answer: ScreenAnswer,
    keyed: ['screen'],
    failsWhenUnavailable: false,
    retry: { tries: 5, backoffMs: 10 * MINUTE, capMs: 6 * HOUR },
  }),
} as const

export type WorkflowName = keyof typeof WORKFLOWS
export type WorkflowRequest<N extends WorkflowName> = z.output<(typeof WORKFLOWS)[N]['request']>
export type WorkflowAnswer<N extends WorkflowName> = z.output<(typeof WORKFLOWS)[N]['answer']>
