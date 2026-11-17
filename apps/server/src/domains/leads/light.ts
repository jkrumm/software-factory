// The light seat: mechanical, well-specified work with a check that proves it starts on the cheap seat (the role table's
// `light` row) instead of the `lead` row. modelpick's table of 2026-11-16 put haiku at high effort level with sonnet at
// medium (29.9 against 30.8) at a fifth of its cost, and 12 points under sonnet at high: right for work a rule can name,
// not as the default lead. A light lead that struggles is moved up once: the next lead starts on the lead row.

/** The role table's rows a lead starts on. */
export const LEAD_ROLE = 'lead'
export const LIGHT_ROLE = 'light'

/** Hygiene finding classes whose fix is mechanical: a link, a word, a context budget, a dependency bump, a project file. */
export const LIGHT_CLASSES: readonly string[] = [
  'links',
  'retired',
  'context',
  'deps',
  'project',
  'readme',
  'agentsmd',
  'stale',
]

/**
 * The tripwire for triage's `small`. Light starts with the rule classes only; triage's `small` with no design choice joins
 * them once light's first verification pass rate, over a week of light Issues, is within `TRIPWIRE_POINTS` of lead's. The
 * Improve screen's seat table shows both rates and whether the tripwire is met (`read/kpis-seats.ts`); flipping this is
 * the one-line change that follows it.
 */
export const LIGHT_FROM_TRIAGE_SMALL = false
export const TRIPWIRE_POINTS = 3
export const TRIPWIRE_DAYS = 7

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
  /** the switch above, passed in so a test can turn it */
  triageSmall?: boolean
}

/** The class a hygiene key names: a probe's first segment, a judgment's kind, a declared probe's name. */
export function hygieneClass(key: string): string {
  const [head = '', second = ''] = key.split(':')
  return head === 'judgment' || head === 'probe' ? second : head
}

/** Why the Issue starts light (the rule's name, shown on the Issue), or null when it starts on the lead row. */
export function lightRule(facts: LightFacts): string | null {
  if (facts.movedUp > 0) return null
  if (facts.hygieneKey !== null) {
    const found = hygieneClass(facts.hygieneKey)
    if (LIGHT_CLASSES.includes(found)) return `hygiene:${found}`
  }
  if (facts.kind === 'docs') return 'kind:docs'
  if (facts.unroutedMonitor) return 'alert:route'
  if ((facts.triageSmall ?? LIGHT_FROM_TRIAGE_SMALL) && facts.size === 'small' && !facts.spec) return 'triage:small'
  return null
}

/** A light lead's second stall, or its second refused ship, moves it up. */
export const MOVE_UP_AFTER = 2

/** What a light lead's attempt did, read from its events and its ships. */
export interface StruggleFacts {
  /** the current attempt's lead started on the light row */
  light: boolean
  /** its stalls this attempt, a wall not counted: the account's, not the lead's */
  stalls: number
  /** it said it is out of its depth (`issue block --out-of-depth`) */
  outOfDepth: boolean
  /** its ships the gate or the machine refused this attempt */
  shipRefusals: number
  /** the watch that just regressed, or null */
  regressedWatch: number | null
}

/** Why a light lead is moved up now, or null: it keeps working. A lead on any other seat is never moved. */
export function moveUpWhy(facts: StruggleFacts): string | null {
  if (!facts.light) return null
  if (facts.outOfDepth) return 'the light lead said the work is beyond its seat'
  if (facts.regressedWatch === 1) return 'the light lead’s change regressed on its first watch'
  if (facts.stalls >= MOVE_UP_AFTER) return `the light lead stalled ${facts.stalls} times`
  if (facts.shipRefusals >= MOVE_UP_AFTER) return `the light lead’s ship was refused ${facts.shipRefusals} times`
  return null
}
