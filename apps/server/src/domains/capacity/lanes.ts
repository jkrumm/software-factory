import { type IssueId, issueNumber } from '../../kernel/ids.ts'

/** The lane a candidate would take: its name, the repo's cap on it, and the Issues already running in it. */
export interface LaneInput {
  name: string
  cap: number
  holders: readonly IssueId[]
}

export type LaneRoom = { granted: true } | { granted: false; message: string; heldBy: IssueId[] }

/**
 * Whether a lead may start in its lane: fewer than `cap` leads of the lane run in the repo. A lane the repo does not
 * cap, or a candidate with no lane, is never kept out here (`leads` still holds). A fix (`urgent`) is never kept out:
 * production is red and the fix has its own place beyond `leads`.
 */
export function laneRoom(input: { lane: LaneInput | null; urgent: boolean }): LaneRoom {
  const { lane } = input
  if (lane === null || input.urgent || lane.holders.length < lane.cap) return { granted: true }
  const list = lane.holders.map((id) => `Issue ${issueNumber(id)}`).join(', ')
  return {
    granted: false,
    message: `lane ${lane.name} is full (${lane.holders.length} of ${lane.cap}): ${list}`,
    heldBy: [...lane.holders],
  }
}
