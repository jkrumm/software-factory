import { type IssueId, issueNumber } from '../../kernel/ids.ts'

/** A lead's claim in a repo: while it holds one, it counts against the repo's `leads: N` and its account's cap. */
export interface Claim {
  issue: IssueId
  repo: string
  /** a fix: it may use the one place beyond `leads` */
  urgent: boolean
  account: string | null
  takenAt: Date
}

export interface Claimant {
  issue: IssueId
  urgent: boolean
  /** when the wait that gave the claim up ended (an owed lead); unknown sorts after every known time */
  since?: Date | null
}

const sinceMs = (c: Claimant): number => c.since?.getTime() ?? Number.POSITIVE_INFINITY

/** Urgent first, then the earliest wait end, then the older Issue (the lower number): a total order, the same on every try. */
export const claimOrder = (a: Claimant, b: Claimant): number => {
  const byUrgent = Number(b.urgent) - Number(a.urgent)
  if (byUrgent !== 0) return byUrgent
  const aSince = sinceMs(a)
  const bSince = sinceMs(b)
  if (aSince !== bSince) return aSince < bSince ? -1 : 1
  return issueNumber(a.issue) - issueNumber(b.issue)
}

export type Room = { granted: true } | { granted: false; message: string; heldBy: IssueId[] }

/**
 * Whether `candidate` takes a claim in a repo that admits `leads` leads and one more for a fix: ordinary holders are at
 * most `leads`, all holders at most `leads + 1`, so a fix never uses up an ordinary place. `owed` are Issues that
 * work in the repo without a claim (a wait that gave it up has ended): they were admitted before, so they are served
 * first, in claim order, and a new lead never takes the place a resumed one is waiting for. A resumed candidate is
 * held up only by the owed leads ahead of it in that order, never by itself or one behind it: with a place free, the
 * first owed lead always takes it.
 */
export function claimRoom(input: {
  leads: number
  holders: readonly Claimant[]
  owed: readonly Claimant[]
  candidate: Claimant
}): Room {
  const { leads, candidate } = input
  const total = leads + 1
  let ordinary = input.holders.filter((h) => !h.urgent).length
  let all = input.holders.length
  const self = input.owed.find((o) => o.issue === candidate.issue)
  const ahead = input.owed
    .filter((o) => o.issue !== candidate.issue && (self === undefined || claimOrder(o, self) < 0))
    .sort(claimOrder)
  for (const claimant of [...ahead, candidate]) {
    const fits = all < total && (claimant.urgent || ordinary < leads)
    if (claimant.issue === candidate.issue) {
      if (fits) return { granted: true }
      const held = input.holders.map((h) => h.issue)
      const list = held.map((id) => `Issue ${issueNumber(id)}`).join(', ')
      const owedList = ahead.length > 0 ? `; ${ahead.length} resumed lead(s) are served first` : ''
      return {
        granted: false,
        message: `the repo runs ${all} of ${leads}${candidate.urgent ? '+1' : ''} leads (${list || 'none'})${owedList}`,
        heldBy: held,
      }
    }
    if (fits) {
      all++
      if (!claimant.urgent) ordinary++
    }
  }
  return { granted: true }
}
/**
 * A wait that needs no lead at work gives the claim back: a person's wait (a Decision, a review, an Errand), a timer and
 * a dependency. A dependency matters most: a lead that waits for another Issue of the same repo must not hold the one
 * place that Issue needs. A stall (a wall, an unreported stop, a block, a regression) keeps it: the lead is alive and
 * the steward ends the stall.
 */
export const CLAIM_FREEING_WAITS: ReadonlySet<string> = new Set(['timer', 'dependency', 'decision', 'review', 'errand'])

/** Whether an Issue in this state is a lead working in its repo, so it holds a claim. */
export function holdsClaim(state: string, waitReason: string | null): boolean {
  if (state === 'working' || state === 'watching') return true
  return state === 'waiting' && waitReason !== null && !CLAIM_FREEING_WAITS.has(waitReason)
}
