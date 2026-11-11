import type { StewardAnswer, StewardStall } from '@software-factory/contract'
import type { IssueId } from '../../kernel/ids.ts'

/** Why an Issue stalled (`docs/language.md`, Stall): a wait with a machine cause, the steward's to end. */
export type StallCause = StewardStall['cause']

/** What the steward knows of one stalled Issue, read from its events and the ports around it. */
export interface StallFacts {
  issue: IssueId
  repo: string
  title: string
  kind: StewardStall['kind']
  cause: StallCause
  detail: string
  /** the version that began the wait: a wake names it, and so does everything the steward keys */
  since: number
  stalledAt: Date
  attempt: number
  restarts: number
  regressions: number
  /** how often the steward woke this attempt already */
  stewardWakes: number
  /** a quiet lead's turn count when it went quiet, so a lead that resumed and went quiet again is a new episode; 0 for a stall */
  episode: number
  /** the same stall as one a Decision of the steward already answered, nothing new since: asking again changes nothing */
  repeatOf: RepeatedStall | null
  /** notes recorded while it waited that the lead has not heard */
  notes: string[]
  /** the Issue's latest events, one line each */
  history: string[]
  /** a `wall` stall: the account's window is open again; null when capacity cannot tell */
  windowOpen: boolean | null
}

/** The earlier stall of an Issue that the steward's Decision settled, and the version of that Decision's answer. */
export interface RepeatedStall {
  answeredAt: number
}

export interface StewardRules {
  /** a stall younger than this is left to end by itself: the lead's next turn wakes `unreported` and `wall` */
  minStallMs: number
  /** the steward wakes an `unreported` stall this many times per attempt before it asks */
  maxWakes: number
  /** a working Issue whose lead session has been quiet this long, with nothing reported, is stalled in all but name */
  idleLeadMs: number
  /**
   * the same for a lead whose last turn ended with background work in flight (a subagent, a check): it waits for that work
   * and is not quiet, so only a wait far past a long implementer or check (30 to 67 minutes measured) reads as a frozen task
   */
  idleBackgroundMs: number
}

export const DEFAULT_STEWARD_RULES: StewardRules = {
  minStallMs: 2 * 60_000,
  maxWakes: 2,
  idleLeadMs: 10 * 60_000,
  idleBackgroundMs: 90 * 60_000,
}

/** What the rules say. `ask`: they do not, so the `factory-steward` workflow is asked. */
export type StallAction =
  | { kind: 'wait'; why: string }
  | { kind: 'wake'; detail: string }
  | { kind: 'requeue'; detail: string }
  | { kind: 'ask' }

/** The wake detail the steward's own wakes begin with: how a later pass counts them from the events alone. */
export const STEWARD_DETAIL = 'steward: '

/**
 * Deterministic first (`docs/product.md`, principle 1): wake when the cause is gone, deliver a note that arrived, requeue a
 * lead that is gone. Only a stall the rules cannot read reaches the workflow.
 */
export function decideStall(facts: StallFacts, now: Date, rules: StewardRules): StallAction {
  const age = now.getTime() - facts.stalledAt.getTime()
  if (age < rules.minStallMs) return { kind: 'wait', why: 'too young: the lead may end it by itself' }

  if (facts.cause === 'wall' && facts.windowOpen !== false) {
    return { kind: 'wake', detail: `${STEWARD_DETAIL}the account's window is open again` }
  }
  // A note that arrived while it waited is news the lead has not heard: ending the wait delivers it (a gone lead's next
  // attempt reads it in its brief).
  if (facts.notes.length > 0) {
    return facts.cause === 'lead_gone'
      ? { kind: 'requeue', detail: `${STEWARD_DETAIL}a note arrived: a new attempt reads it` }
      : { kind: 'wake', detail: `${STEWARD_DETAIL}delivers ${facts.notes.length} note(s) that arrived while it waited` }
  }
  if (facts.cause === 'wall') return { kind: 'wait', why: "the account's window is still closed" }
  if (facts.cause === 'unreported' && facts.stewardWakes < rules.maxWakes) {
    return { kind: 'wake', detail: `${STEWARD_DETAIL}it stopped without reporting: it is asked to report` }
  }
  // The same cause, the same words, no news from a person since a Decision settled it: a second Decision would be the same
  // question with the same answer. The Issue stays stalled, which the Console shows; a changed cause or a note ends it.
  if (facts.repeatOf) {
    return {
      kind: 'wait',
      why: `the same stall as the Decision answered at v${facts.repeatOf.answeredAt}: nothing changed`,
    }
  }
  return { kind: 'ask' }
}

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .replace(/\d+/g, ' ')
      .split(/[^a-z]+/)
      .filter((word) => word.length > 3),
  )

/** How alike two stall details read: the share of their words (digits dropped) that both use. Two empty details are alike. */
export function sameWords(a: string, b: string): number {
  const left = words(a)
  const right = words(b)
  if (left.size === 0 && right.size === 0) return 1
  let both = 0
  for (const word of left) if (right.has(word)) both++
  return both / (left.size + right.size - both)
}

/** Two stall details that read alike: the lead's repeated block, or a watch's failing checks with a new count. */
export const SAME_STALL = 0.5

/**
 * The text every idle wake begins with, and so how a later pass counts them from the events alone (a `noted` event of the
 * steward that starts with it). The wake an answer of the workflow sends begins with it too.
 */
export const IDLE_NOTE = 'steward: your session has been idle'

/** How the detail of a quiet lead's facts begins, as the workflow is given them (the lead is never stalled: it stays `working`). */
export const IDLE_STALL = "the lead's session has been idle"

/** What a nudge says to a lead that went quiet on a working Issue: how long, its last event, and what to do. */
export function idleNote(minutes: number, lastEvent: string, extra = '', background = false): string {
  const head = `${IDLE_NOTE} for ${minutes} minute(s) with nothing reported. The last event on the Issue: ${lastEvent}.`
  const tail = background
    ? 'Your last turn ended with background work still running and it has not woken you since: check whether that subagent, check or shell is frozen (stop it and go on), then continue, or report with `factory issue ship|close|block|ask|defer`.'
    : 'Check your background tasks (a subagent or a shell may be frozen: stop it and go on), then continue, or report with `factory issue ship|close|block|ask|defer`.'
  return [head, extra, tail].filter(Boolean).join(' ')
}

/** What the steward knows of a working Issue whose lead is idle. */
export interface IdleFacts {
  /** when the session went quiet: its last turn ended */
  idleSince: Date
  /** the later of that and the last idle wake: the next wake waits another `idleLeadMs` from here */
  quietSince: Date
  /** idle wakes this attempt */
  wakes: number
  /** the Issue's latest event that is no idle wake, one line */
  lastEvent: string
  /** its last turn ended with background work in flight: it waits for that, and is nudged only after `idleBackgroundMs` */
  background: boolean
}

/**
 * A lead whose turn ended with nothing reported and no tool running (a running tool is a `working` session, which is
 * never read here) is woken with a note naming its last event, `maxWakes` times per attempt, each after another
 * `idleLeadMs` of quiet (`idleBackgroundMs` when background work was in flight as the turn ended); after that the
 * workflow is asked, and it may only note the lead: an idle lead is never turned into a Decision.
 */
export function decideIdle(facts: IdleFacts, now: Date, rules: StewardRules): StallAction {
  const quiet = now.getTime() - facts.quietSince.getTime()
  if (quiet < (facts.background ? rules.idleBackgroundMs : rules.idleLeadMs)) {
    return { kind: 'wait', why: 'not idle long enough' }
  }
  if (facts.wakes < rules.maxWakes) {
    return {
      kind: 'wake',
      detail: idleNote(
        Math.floor((now.getTime() - facts.idleSince.getTime()) / 60_000),
        facts.lastEvent,
        '',
        facts.background,
      ),
    }
  }
  return { kind: 'ask' }
}

/** The facts as the workflow takes them: cut to its limits, credentials scrubbed by the caller's `clean`. */
export function stallRequest(facts: StallFacts, now: Date, clean: (text: string) => string): StewardStall {
  const cut = (text: string, max: number) => clean(text).slice(0, max)
  return {
    issue: facts.issue,
    repo: facts.repo,
    title: cut(facts.title, 500) || facts.issue,
    kind: facts.kind,
    cause: facts.cause,
    detail: cut(facts.detail, 4_000),
    stalledMinutes: Math.max(0, Math.floor((now.getTime() - facts.stalledAt.getTime()) / 60_000)),
    attempt: facts.attempt,
    restarts: facts.restarts,
    regressions: facts.regressions,
    stewardWakes: facts.stewardWakes,
    notes: facts.notes.slice(-20).map((note) => cut(note, 500)),
    history: facts.history.slice(-40).map((line) => cut(line, 500)),
  }
}

/** What an answer comes to once the factory has checked it against the stall it was given. */
export type Checked =
  | { kind: 'wake' | 'requeue'; note: string | null; reason: string }
  | { kind: 'decision'; form: unknown; reason: string }
  | { kind: 'none'; why: string }

/**
 * The factory checks the answer again, as the workflow's guard did: `requeue` ends only `lead_gone` and `wake` every other
 * stall. A Decision's form is read by the checkpoints' own reader before anything is recorded.
 */
export function checkAnswer(facts: Pick<StallFacts, 'cause'>, answer: StewardAnswer): Checked {
  const note = answer.note.trim() === '' ? null : answer.note.trim()
  switch (answer.action) {
    case 'none':
      return { kind: 'none', why: answer.reason }
    case 'requeue':
      return facts.cause === 'lead_gone'
        ? { kind: 'requeue', note, reason: answer.reason }
        : { kind: 'none', why: 'requeue ends only a lead_gone stall' }
    case 'wake':
      return facts.cause === 'lead_gone'
        ? { kind: 'none', why: 'a lead_gone stall is ended by requeue' }
        : { kind: 'wake', note, reason: answer.reason }
    case 'raise_decision':
      // A Decision's answer puts the Issue back with its lead; a lead that is gone needs a new attempt, which only a requeue starts.
      if (facts.cause === 'lead_gone')
        return { kind: 'none', why: 'a lead_gone stall is ended by requeue, not by a Decision' }
      return answer.decision
        ? { kind: 'decision', form: answer.decision, reason: answer.reason }
        : { kind: 'none', why: 'raise_decision without a form' }
  }
}

/** The calls the steward makes for one stall before it gives up asking and raises the Decision below. */
export const MAX_ROUNDS = 3

const PLAIN: Record<StallCause, string> = {
  wall: "the account's window is closed",
  unreported: 'the lead stopped without reporting',
  blocked: 'the lead reported it is blocked',
  lead_gone: 'the lead is gone',
  regressed: 'the change regressed after it shipped',
}

/**
 * (Not for `lead_gone`: its exit is a new attempt, not an answer.) The Decision the factory raises itself when the workflow could not say after `MAX_ROUNDS` calls: the stall is real, no
 * rule reads it and no answer came. Both options can be taken back, and with no answer the Issue stays stalled and the
 * owner sees it in the Console.
 */
export function fallbackDecision(facts: StallFacts): unknown {
  const number = facts.issue.slice('issue_'.length)
  return {
    question: `Issue ${number} (${facts.title.slice(0, 120)}) is stalled: ${PLAIN[facts.cause]}. Try again or drop it?`,
    recommendation: 'try again',
    checked: `The steward's rules do not read this ${facts.cause} stall and ${MAX_ROUNDS} asks of the workflow gave no usable answer. Detail: ${facts.detail.slice(0, 300) || 'none'}`,
    options: [
      {
        label: 'try again',
        reversible: true,
        cost:
          facts.cause === 'lead_gone'
            ? 'a new attempt starts and may fail the same way'
            : 'the lead is woken and may stall again',
      },
      {
        label: 'drop',
        reversible: true,
        cost: 'the lead is told to close the Issue as dropped; the work can be filed again',
      },
    ],
    noAnswer: { consequence: 'the Issue stays stalled', default: null, waitMinutes: null },
  }
}
