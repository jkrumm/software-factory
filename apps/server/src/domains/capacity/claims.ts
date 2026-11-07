import { type IssueId, issueNumber } from '../../kernel/ids.ts'

/** A lead's seat in a repo: while it holds one, it counts against the repo's `leads: N` and its account's cap. */
export interface Seat {
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
}

/** Urgent first, then the older Issue (the lower number). */
export const claimOrder = (a: Claimant, b: Claimant): number =>
  Number(b.urgent) - Number(a.urgent) || issueNumber(a.issue) - issueNumber(b.issue)

export type Room = { granted: true } | { granted: false; message: string; heldBy: IssueId[] }

/**
 * Whether `candidate` takes a seat in a repo that admits `leads` leads and one more for a fix: ordinary holders are at
 * most `leads`, all holders at most `leads + 1`, so a fix never uses up an ordinary place. `owed` are Issues that
 * work in the repo without a seat (a wait that gave it up has ended): they were admitted before, so they are served
 * first, in claim order, and a new lead never takes the place a resumed one is waiting for.
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
  const ahead = input.owed.filter((o) => o.issue !== candidate.issue).sort(claimOrder)
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
