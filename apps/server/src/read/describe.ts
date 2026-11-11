import { cut, plainText } from './plain.ts'

/** What an Issue's event says in plain words, and what each state and wait means as one sentence. All input is data and is only quoted. */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const field = (payload: unknown, name: string): string | null => {
  if (!isRecord(payload)) return null
  const value = payload[name]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** `opus at high effort` from a payload's seat, or null when it carries none. */
function seatWords(payload: unknown): string | null {
  const seat = isRecord(payload) ? payload.seat : null
  const tier = field(seat, 'tier')
  const effort = field(seat, 'effort')
  return tier && effort ? `${tier} at ${effort} effort` : null
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
      return seatWords(payload) ? `A lead started on ${seatWords(payload)}.` : 'A lead started.'
    case 'lead_gone':
      return after('The lead ended', field(payload, 'detail'))
    case 'seated': {
      const seat = seatWords({ seat: payload })
      return seat ? `The lead seat was set to ${seat}.` : 'The lead seat was set.'
    }
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
    case 'errand_done': {
      const turnedAway = field(payload, 'turnedAway')
      return turnedAway ? `An errand was turned away: ${cut(plainText(turnedAway))}` : 'The errand was done.'
    }
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
export function stateSentence(input: {
  state: string
  reason: string | null
  outcome: string | null
  /** why a queued Issue stays queued, from the queue order; `repoName` and `heldBy` (set when another Issue holds the repo's claim; the number itself stays in its own field) sharpen a claim */
  queue?: { kind: string; message: string; repoName?: string; heldBy?: number | null } | null
}): string {
  switch (input.state) {
    case 'settling':
      return 'Being settled.'
    case 'queued':
      return queueSentence(input.queue ?? null)
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

/** One sentence for a queued Issue: the real reason when the queue order gives one, else the account it waits for. */
function queueSentence(
  queue: { kind: string; message: string; repoName?: string; heldBy?: number | null } | null,
): string {
  if (!queue) return 'Queued, waiting for a free account.'
  switch (queue.kind) {
    case 'drain':
      return 'Queued: the queue is draining, so no new work starts.'
    case 'claim': {
      const repo = queue.repoName ? ` ${queue.repoName}` : ' its repo'
      return queue.heldBy
        ? `Queued behind another Issue that holds${repo}.`
        : `Queued: the claims on${repo} are full, so it starts when one frees.`
    }
    default: {
      const message = cut(plainText(queue.message))
      return message
        ? `Queued: ${message.charAt(0).toLowerCase()}${message.slice(1)}.`
        : 'Queued, waiting for a free account.'
    }
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
