/** A plain sentence for a wait: who the Issue is paused on, or why it stalled. */
const PAUSED_REASON: Record<string, string> = {
  decision: 'On you: a Decision',
  review: 'On you: a review',
  errand: 'On you: an Errand',
  timer: 'Until a set time',
  dependency: 'For another Issue',
  external: "On someone else's review",
  paused: 'Paused by you',
  wall: 'Stalled: the account hit its limit',
  unreported: 'Stalled: the lead reported nothing',
  blocked: 'Stalled: the lead is blocked',
  lead_gone: 'Stalled: the lead is gone',
  regressed: 'Stalled: it regressed after shipping',
}

export const pausedReason = (waitReason: string | null): string | null =>
  waitReason === null ? null : (PAUSED_REASON[waitReason] ?? waitReason.replaceAll('_', ' '))
