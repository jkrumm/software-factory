import { EFFORTS, type Effort, REVIEWER_CHEAP_ROLE, REVIEWER_ROLE, TIERS, type Tier } from '@software-factory/contract'

// The reviewer seat (Issue 2027). Leads run `/review` themselves, so the factory never starts a review: it assigns each
// lead a reviewer row when the lead starts, says so in the brief, and reads the reviews back from agw's ledger at the
// ship. The cheap row (haiku at high effort) takes the reviews of light-seat Issues and of the even-numbered others;
// a deep review stays on the `reviewer` row. Every number below is the owner's of 2026-11-17, see `REVIEWER_*`.

/** The seat of one review: the row it belongs to and the tier and effort it ran on. */
export interface ReviewerSeat {
  role: string
  tier: Tier
  effort: Effort
}

/**
 * The reviewer row a lead gets at its start: the cheap row for a lead on the light seat, for an even Issue number (half of
 * the others, so the two groups are comparable), and for every Issue once the tripwire has handed the cheap row all
 * reviews; the `reviewer` row otherwise.
 */
export function reviewerRoleFor(input: { issueNumber: number; light: boolean; takesAll: boolean }): string {
  return input.light || input.takesAll || input.issueNumber % 2 === 0 ? REVIEWER_CHEAP_ROLE : REVIEWER_ROLE
}

/** The tier words of agw's route table are tier words too; anything else (a model id) is not read. */
const tierWord = (word: string): Tier | null => TIERS.find((tier) => tier === word) ?? null
const effortWord = (word: string): Effort | null => EFFORTS.find((effort) => effort === word) ?? null

/**
 * The seat a review ran on. The cheap row is for the non-deep reviews of an Issue assigned to it; every other review
 * (a deep one, any review of an Issue on the `reviewer` row) ran on the seat agw's `prepare` named, which the brief tells
 * the lead to use as it is. `routed` is agw's seat for the job; where it is not tier and effort words the `reviewer` row stands.
 */
export function reviewSeat(input: {
  assigned: string
  tier: string
  routed: { model: string; effort: string } | null
  rows: { cheap: { tier: Tier; effort: Effort }; reviewer: { tier: Tier; effort: Effort } }
}): ReviewerSeat {
  if (input.assigned === REVIEWER_CHEAP_ROLE && input.tier !== 'deep')
    return { role: REVIEWER_CHEAP_ROLE, ...input.rows.cheap }
  const tier = input.routed ? tierWord(input.routed.model) : null
  const effort = input.routed ? effortWord(input.routed.effort) : null
  return {
    role: REVIEWER_ROLE,
    tier: tier ?? input.rows.reviewer.tier,
    effort: effort ?? input.rows.reviewer.effort,
  }
}

/** What the brief tells a lead about the reviewer agent: which seat to pass `/review`'s Agent call. */
export function reviewerBrief(assigned: string, cheap: { tier: Tier; effort: Effort }): string {
  if (assigned === REVIEWER_CHEAP_ROLE) {
    return `## Your reviewer seat

Your reviews run on the reviewer row \`${REVIEWER_CHEAP_ROLE}\`. \`/review\` tells you to start the reviewer agent with \`model\` = \`seat.model\` and \`effort\` = \`seat.effort\` of \`agw review prepare\`: for a review at tier \`light\` or \`standard\`, pass \`model: ${cheap.tier}\` and \`effort: ${cheap.effort}\` instead and leave everything else as it is. At tier \`deep\` keep prepare's \`seat\`. Never run a review twice to compare seats; the factory reads the seat from its own record.`
  }
  return `## Your reviewer seat

Your reviews run on the seat \`agw review prepare\` names (\`seat.model\`, \`seat.effort\`), as \`/review\` says, at every tier. Do not change it.`
}
