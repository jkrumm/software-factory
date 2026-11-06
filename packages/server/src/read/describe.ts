/** Plain words for the read API: what an Issue's event says, and a text cut at a word. All input is data and is only quoted. */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const field = (payload: unknown, name: string): string | null => {
  if (!isRecord(payload)) return null
  const value = payload[name]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** One line cut at a word (`…` marks the cut). */
export function cut(text: string, max = 140): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  const head = one.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > max / 2 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/, '')}…`
}

/**
 * The first sentence of a text. One that is longer than `max` is cut at its last clause boundary (`;`, ` — `, `: `, `, `) past
 * half of `max`, else at a word; the cut ends in `…`.
 */
export function firstSentence(text: string, max = 160): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const end = /[.!?](\s|$)/.exec(one)
  const sentence = end ? one.slice(0, end.index + 1) : one
  if (sentence.length <= max) return sentence
  const window = sentence.slice(0, max)
  let at = -1
  for (const m of window.matchAll(/[;:,](?=\s)|\s—(?=\s)/g)) {
    if (m.index > max / 2 && m.index < max - 1) at = m.index
  }
  if (at < 0) return cut(sentence, max)
  return `${window.slice(0, at).replace(/[\s,;:.-]+$/, '')}…`
}

const after = (lead: string, quoted: string | null): string => (quoted ? `${lead}: ${cut(quoted)}` : `${lead}.`)

/** A time in the payload as `YYYY-MM-DD HH:MM UTC`, else null. */
const clock = (payload: unknown, name: string): string | null => {
  const raw = field(payload, name)
  const ms = raw ? Date.parse(raw) : NaN
  return Number.isNaN(ms) ? null : `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

const REASON_WORDS: Record<string, string> = {
  wait: 'waiting for a set time',
  blocked: 'blocked',
  decision: 'waiting for a decision',
  wall: 'paused at the usage limit',
  dependency: 'waiting for another Issue to land',
  parked: 'parked',
  unreported: 'stopped without reporting',
  lead_gone: 'without a running lead',
  claim: 'waiting for the repo to be free',
}

/**
 * One `issue_events` row in plain words: a short sentence, the lead's own words quoted where it said them, and no id in the prose
 * (ids live in the fields beside it). A kind this does not know reads as the kind in words, so a new event is never blank.
 */
export function describeEvent(kind: string, from: string | null, to: string | null, payload: unknown): string {
  switch (kind) {
    case 'created':
      return 'Filed and queued.'
    case 'admitted':
      return 'A lead was started.'
    case 'phase':
      return after('The lead moved on', field(payload, 'phase') ?? field(payload, 'note'))
    case 'wait': {
      const until = clock(payload, 'until')
      const why = field(payload, 'why')
      return `Waiting${until ? ` until ${until}` : ''}${why ? `: ${cut(why)}` : '.'}`
    }
    case 'block':
      return after('Blocked', field(payload, 'reason'))
    case 'ask':
      return after('Asked the owner for a decision', field(payload, 'question'))
    case 'answer':
      return after('The question was answered', field(payload, 'answer'))
    case 'ship':
      return after('Shipped, now held for the check', field(payload, 'summary'))
    case 'close':
      return after('Closed as done', field(payload, 'summary'))
    case 'drop':
      return after('Dropped', field(payload, 'reason'))
    case 'stop':
      return after('Stopped by the owner', field(payload, 'reason'))
    case 'unreported':
      return 'The lead stopped without reporting.'
    case 'lead_gone':
      return to === 'queued'
        ? 'The lead ended; a new attempt will start.'
        : 'The lead ended again and no new attempt will start: parked.'
    case 'restart':
      return 'A new attempt was queued after the lead ended.'
    case 'limit_stop':
      return 'Paused: the account reached its usage limit.'
    case 'turn_started':
      return from === 'waiting' ? 'The lead started working again.' : 'The lead started a turn.'
    case 'signal':
      return 'Another report of the same problem came in.'
    case 'regression':
      return to === 'waiting'
        ? 'The check failed again and the Issue was parked.'
        : 'The check failed; the lead works on it again.'
    case 'checkout_blocked':
      return after(
        'The check could not run because the repo checkout is not clean on the default branch',
        field(payload, 'detail'),
      )
    case 'hold_over':
      return 'The holding period is over; checking the result.'
    case 'verified':
      return 'The check passed. Closed as done.'
    case 'wake':
      return 'The wait ended and the lead was woken.'
    case 'lapsed':
      return 'A question passed its expiry with no default.'
    case 'note':
      return after('A note was sent to the lead', field(payload, 'text'))
    case 'prio': {
      const value = isRecord(payload) ? payload.value : null
      return typeof value === 'number' ? `Priority set to ${value}.` : 'Priority changed.'
    }
    case 'retier':
      return 'The lead level was changed.'
    case 'dep':
      return 'Now waits for another Issue.'
    case 'park':
      return 'Parked.'
    case 'reopen':
      return after('Reopened', field(payload, 'reason'))
    case 'healed':
      return 'The problem went away by itself. Closed.'
    case 'settled':
      return 'The problem persisted and the Issue was queued.'
    case 'refused': {
      const what = field(payload, 'event')
      const detail = field(payload, 'detail')
      return `${what ? `A ${what} report` : 'A report'} was not accepted${detail ? `: ${cut(detail)}` : '.'}`
    }
    case 'hold':
      return 'The holding period started.'
    case 'transcript':
      return "The lead's conversation was archived."
    case 'steward_exhausted':
      return 'The factory ran out of automatic retries and needs the owner.'
    case 'ask_judged':
      return field(payload, 'outcome') === 'answered'
        ? 'The question was answered by the factory.'
        : 'The question was left for the owner.'
    case 'escalation':
      return 'The factory handed the case to the owner.'
    default:
      return `${kind.replaceAll('_', ' ')}.`.replace(/^./, (c) => c.toUpperCase())
  }
}

/** A closed Issue's `to` state, and its reason, in words for a card. */
export const reasonWords = (reason: string | null): string => (reason ? (REASON_WORDS[reason] ?? reason) : '')
