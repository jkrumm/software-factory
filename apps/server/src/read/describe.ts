import { cut, plainText } from './plain.ts'

/** What an Issue's event says in plain words, and what each state and wait means as one sentence. All input is data and is only quoted. */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const field = (payload: unknown, name: string): string | null => {
  if (!isRecord(payload)) return null
  const value = payload[name]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const after = (lead: string, quoted: string | null): string =>
  quoted ? `${lead}: ${cut(plainText(quoted))}` : `${lead}.`

const VERDICT_WORDS: Record<string, string> = {
  looks_good: 'looks good',
  with_notes: 'good with notes',
  changes: 'needs changes',
  no_longer_applies: 'no longer applies',
}

/**
 * One `issue_events` row in plain words: a short sentence, the lead's own words quoted where it said them, and no id in the
 * prose (ids live in the fields beside it). A kind this does not know reads as the kind in words, so a new event is never blank.
 */
export function describeEvent(kind: string, payload: unknown): string {
  switch (kind) {
    case 'filed':
      return 'Filed.'
    case 'settled':
      return 'Settled and queued.'
    case 'admitted':
      return 'A lead was admitted.'
    case 'lead_started':
      return 'A lead started.'
    case 'lead_gone':
      return after('The lead ended', field(payload, 'detail'))
    case 'noted':
      return after('A note reached the lead', field(payload, 'text'))
    case 'asked':
      return 'Asked the owner for a decision.'
    case 'answered':
      return after('The decision was answered', field(payload, 'answer'))
    case 'submitted':
      return 'Handed over for review.'
    case 'verdict_given':
      return `Reviewed: ${VERDICT_WORDS[field(payload, 'verdict') ?? ''] ?? 'a verdict was given'}.`
    case 'errand_raised':
      return 'An errand for the owner was raised.'
    case 'errand_done':
      return 'The errand was done.'
    case 'deferred':
      return 'Deferred.'
    case 'stalled':
      return after('Stalled', field(payload, 'detail'))
    case 'woken':
      return after('Woken', field(payload, 'detail'))
    case 'shipped':
      return 'Shipped; the watch began.'
    case 'watch_passed':
      return 'The watch passed.'
    case 'regressed':
      return after('Regressed', field(payload, 'detail'))
    case 'reopened':
      return after('Reopened', field(payload, 'reason'))
    case 'cancelled':
      return after('Cancelled', field(payload, 'reason'))
    case 'closed':
      return after('Closed', field(payload, 'reason'))
    default:
      return `${kind.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())}.`
  }
}

/** The sentence for an Issue in a state, from its state and wait alone: no ids and no times. */
export function stateSentence(input: { state: string; reason: string | null; outcome: string | null }): string {
  switch (input.state) {
    case 'settling':
      return 'Being settled.'
    case 'queued':
      return 'Queued, waiting for a free account.'
    case 'working':
      return 'The lead is working on it.'
    case 'watching':
      return 'Shipped, held for its check.'
    case 'waiting':
      return (input.reason && WAIT_SENTENCE[input.reason]) || 'Waiting.'
    default:
      return input.outcome === 'dropped'
        ? 'Dropped.'
        : input.outcome === 'healed'
          ? 'Healed by itself.'
          : input.outcome === 'cancelled'
            ? 'Cancelled.'
            : 'Closed as done.'
  }
}

const WAIT_SENTENCE: Record<string, string> = {
  timer: 'Waiting for a set time.',
  dependency: 'Waiting for another Issue to land.',
  wall: "Paused at the account's usage limit.",
  unreported: 'The lead stopped without reporting.',
  blocked: 'Blocked, waiting for the steward to look again.',
  lead_gone: 'The lead ended; a new attempt is due.',
  regressed: 'The change broke something; the steward is looking.',
  decision: 'Waiting for the owner to decide.',
  review: 'Waiting for the owner to review.',
  errand: "Waiting for the owner's hands.",
}

/** A plain word for what the Issue is doing now. */
export function phaseOf(input: { state: string; reason: string | null }): string {
  switch (input.state) {
    case 'settling':
      return 'settling'
    case 'queued':
      return 'queued'
    case 'working':
      return 'building'
    case 'watching':
      return 'watching the ship'
    case 'waiting':
      return input.reason === 'decision'
        ? 'waiting for your answer'
        : input.reason === 'review'
          ? 'waiting for your review'
          : input.reason === 'errand'
            ? 'waiting for your hands'
            : input.reason === 'timer' || input.reason === 'dependency'
              ? 'waiting'
              : 'stalled'
    default:
      return 'closed'
  }
}
