import { hygieneFinder, STRONG_ROLE } from '@software-factory/contract'

export { hygieneFinder, STRONG_ROLE }
// The light seat: mechanical, well-specified work with a check that proves it (every hygiene finding, whatever its size)
// starts on the cheap seat (the role table's
// `light` row) instead of the `lead` row. modelpick's table of 2026-11-16 put haiku at high effort level with sonnet at
// medium (29.9 against 30.8) at a fifth of its cost, and 12 points under sonnet at high: right for work a rule can name,
// not as the default lead. A light lead that struggles is moved up once: the next lead starts on the lead row.

/** The role table's rows a lead starts on. */
export const LEAD_ROLE = 'lead'
export const LIGHT_ROLE = 'light'

/**
 * The step a lead's move-up takes, read from the seat its attempt ran on: `light` (a lead the light rule seated, or a
 * filed seat below the lead row that asked for it) ends on the lead row; `lead` (a filed lead-row seat that asked for it)
 * ends on the strong row. Null: the lead is not moved: any other filed seat is the filer's, and a lead that was moved up
 * already runs on a row with no step left.
 */
export type MoveStep = 'light' | 'lead'
export function stepOf(
  ranOn: { role?: string | undefined; rule?: string | undefined; moveUp?: true | undefined } | undefined,
): MoveStep | null {
  if (!ranOn) return null
  if (ranOn.rule) return 'light'
  if (!ranOn.moveUp) return null
  return ranOn.role === LEAD_ROLE ? 'lead' : 'light'
}

/** What decides whether an Issue with no filed seat starts light. */
export interface LightFacts {
  /** the Issue's kind as triage left it */
  kind: string
  /** triage's size, null when it judged none */
  size: string | null
  /** triage flagged a design choice (`checkpoint: spec`) */
  spec: boolean
  /** the key of the hygiene finding that filed it (`links:docs/x.md`, `judgment:stale:docs/y.md`, `probe:readme`), if one did */
  hygieneKey: string | null
  /** a monitor alerted with no door route and the factory filed it home: its fix is a route */
  unroutedMonitor: boolean
  /** a light lead was moved up on it before: never light again */
  movedUp: number
  /** the Issue's title and the text it was filed with, for the words that keep a `small` off the light seat */
  text: string
  /** the tripwire is met (`judgeLightGate` in the contract package): triage's `small` may start light; false while it is not met or not measured */
  triageSmall: boolean
}

/**
 * Work whose words say it touches a migration, security or a public surface stays on the lead row even when triage called
 * it `small` and raised no design checkpoint: triage's checkpoint names a new surface, a data model, a dependency or an
 * unseen screen, and these words are the same classes read from the filing, a deterministic net a lead's text cannot talk
 * its way past. A false hit costs a cheap seat, a miss costs a regression.
 */
const OUT_OF_SCOPE =
  /\b(?:migrat\w*|secur\w*|auth(?:n|z|entication|orization|orisation)?|permissions?|credentials?|secrets?|passwords?|vulnerab\w*|cve-\d+|policy\.ts|breaking change|public (?:api|surface)|new (?:route|endpoint|verb|command|api|screen))\b|\.sql\b/i

/** Whether the filing's words keep the Issue off the light seat. */
export const outOfScope = (text: string): boolean => OUT_OF_SCOPE.test(text)

/** Why the Issue starts light (the rule's name, shown on the Issue), or null when it starts on the lead row. */
export function lightRule(facts: LightFacts): string | null {
  if (facts.movedUp > 0) return null
  // A hygiene finding comes from a probe, and the same probe turning green proves the fix: it starts light whatever size
  // triage gave it.
  if (facts.hygieneKey !== null) return `hygiene:${hygieneFinder(facts.hygieneKey)}`
  if (facts.kind === 'docs') return 'kind:docs'
  if (facts.unroutedMonitor) return 'alert:route'
  if (facts.triageSmall && facts.size === 'small' && !facts.spec && !outOfScope(facts.text)) {
    return 'triage:small'
  }
  return null
}

/** A light lead's second stall, or its second refused ship, moves it up. */
const MOVE_UP_AFTER = 2

/** What a movable lead's attempt did, read from its events and its ships. */
export interface StruggleFacts {
  /** the step the current attempt's lead can take (`stepOf`), null for a lead that is never moved */
  step: MoveStep | null
  /** its stalls this attempt, a wall not counted: the account's, not the lead's */
  stalls: number
  /** it said it is out of its depth (`issue block --out-of-depth`) */
  outOfDepth: boolean
  /** its ships the gate or the machine refused this attempt */
  shipRefusals: number
  /** the watch that just regressed, or null */
  regressedWatch: number | null
}

/**
 * Why a movable lead is moved up now, or null: it keeps working. A lead on any other seat is never moved. The words are
 * read back by `moveSignOf` (the seats read): the light step's are as they always were, the lead row's say `the lead`.
 */
export function moveUpWhy(facts: StruggleFacts): string | null {
  if (!facts.step) return null
  const who = facts.step === 'light' ? 'the light lead' : 'the lead'
  if (facts.outOfDepth) return `${who} said the work is beyond its seat`
  if (facts.regressedWatch === 1) return `${who}’s change regressed on its first watch`
  if (facts.stalls >= MOVE_UP_AFTER) return `${who} stalled ${facts.stalls} times`
  if (facts.shipRefusals >= MOVE_UP_AFTER) return `${who}’s ship was refused ${facts.shipRefusals} times`
  return null
}

/**
 * How long the factory waits for a leaving lead's handover, from the moment it asked: a lead that is gone ends the wait at
 * once, and one that does not answer leaves its last words. It bounds the factory's own wait, not the lead (the stall rule
 * is the only liveness rule a lead has).
 */
export const HANDOVER_WAIT_MS = 10 * 60_000
