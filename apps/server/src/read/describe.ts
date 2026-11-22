import { workOf } from '@software-factory/contract'
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
  const role = field(seat, 'role')
  if (!tier || !effort) return null
  return role === 'light' ? `${tier} at ${effort} effort (the light seat)` : `${tier} at ${effort} effort`
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
      return 'Settled; not started yet.'
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
      const resolved = field(payload, 'resolved')
      const ran = field(payload, 'ran')
      if (ran) return `An errand was run on the MacBook by the factory: ${cut(plainText(ran))}`
      if (resolved) return `An errand was no longer needed: ${cut(plainText(resolved))}`
      return turnedAway ? `An errand was turned away: ${cut(plainText(turnedAway))}` : 'The errand was done.'
    }
    case 'errand_turned_back':
      return `An errand was turned back: ${cut(plainText(field(payload, 'note') ?? ''))}`
    case 'paused':
      return after('Paused by the owner', field(payload, 'reason'))
    case 'deferred': {
      const review = field(payload, 'review')
      return review ? `Paused on the review of ${cut(plainText(review))}.` : 'Deferred.'
    }
    case 'stalled':
      return after('Stalled', field(payload, 'detail'))
    case 'moved_up':
      return after(
        field(payload, 'to')
          ? 'Moved up from the lead seat to the stronger seat'
          : 'Moved up from the light seat to the lead seat',
        field(payload, 'why'),
      )
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
      return 'Held: being settled.'
    case 'queued':
      return queueSentence(input.queue ?? null)
    case 'working':
      return 'Running: a lead is on it.'
    case 'watching':
      return 'Checking: shipped, its check is pending.'
    case 'waiting':
      return (input.reason && WAIT_SENTENCE[input.reason]) || 'Paused: named wait unknown.'
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

/**
 * One sentence for a not-started Issue, opening with its word: Held when nothing but another Issue, a line, a drain or a
 * Spec keeps it out, else Ready with the limit that binds it (the queue order's own words, or room in the allowance).
 */
function queueSentence(
  queue: { kind: string; message: string; repoName?: string; heldBy?: number | null } | null,
): string {
  const work = workOf({ state: 'queued', queueKind: queue?.kind ?? null })
  const word = work?.word === 'held' ? 'Held' : 'Ready'
  if (!queue) return 'Ready: waits only for room in the allowance.'
  switch (queue.kind) {
    case 'drain':
      return `Held: ${cut(queue.message, 200)}.`
    case 'claim': {
      const repo = queue.repoName ? ` ${queue.repoName}` : ' its repo'
      return queue.heldBy
        ? `Ready: another Issue holds${repo}, it starts when that claim frees.`
        : `Ready: the claims on${repo} are full, so it starts when one frees.`
    }
    default: {
      const message = cut(plainText(queue.message))
      return message
        ? `${word}: ${message.charAt(0).toLowerCase()}${message.slice(1)}.`
        : `${word}: see the queue order.`
    }
  }
}

const WAIT_SENTENCE: Record<string, string> = {
  timer: 'Paused: until a set time.',
  dependency: 'Paused: for another Issue to land.',
  wall: "Paused: at the account's usage limit.",
  unreported: 'Paused: the lead stopped without reporting.',
  blocked: 'Paused: blocked, the steward looks again.',
  lead_gone: 'Paused: the lead ended, a new attempt is due.',
  regressed: 'Paused: the change broke something, the steward is looking.',
  decision: 'Paused: on the owner to decide.',
  review: 'Paused: on the owner to review.',
  errand: "Paused: on the owner's hands.",
  external: "Paused: on someone else's review of its pull request.",
  paused: 'Paused: you paused it; it resumes on your word, or at the time you gave.',
}

/** A plain word for what the Issue is doing now. */
export function phaseOf(input: { state: string; reason: string | null }): string {
  switch (input.state) {
    case 'settling':
      return 'being settled'
    case 'queued':
      return 'not started'
    case 'working':
      return 'building'
    case 'watching':
      return 'checking the ship'
    case 'waiting':
      return input.reason === 'decision'
        ? 'paused on your answer'
        : input.reason === 'review'
          ? 'paused on your review'
          : input.reason === 'errand'
            ? 'paused on your hands'
            : input.reason === 'timer' ||
                input.reason === 'dependency' ||
                input.reason === 'external' ||
                input.reason === 'paused'
              ? 'paused'
              : 'stalled'
    default:
      return 'closed'
  }
}
