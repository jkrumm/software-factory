/** The weekly retro: one signal a week, filed by the friction loop's pass, whose lead writes the review as a Report. */

/** Stable: the fingerprint drops digits and punctuation, so a repeat amends within the intake window. */
export const RETRO_TITLE =
  'Weekly retro: the numbers, the transcripts, and whether last week’s changes moved their number'

export const RETRO_WINDOW_DAYS = 7

/**
 * The signal's text: the ask a lead builds from. Every command is one the factory already has; the bundle
 * (`factory retro`) holds every number, so the lead reads and judges, it does not recount.
 */
export function retroText(input: { to: string; days: number }): string {
  const { to, days } = input
  const date = to.slice(0, 10)
  return [
    `Why: the owner wants a review of the last ${days} days as a repeating hygiene step: it keeps tuning the factory, the CLIs, the briefs and the dotfiles wiring, and checks that earlier changes moved their number.`,
    `What: the event log, the lead transcripts and the earlier retro signals, over the ${days} days ending ${to}.`,
    `Change: write one Report (\`factory artifact submit --kind report\`) with these parts, in this order.`,
    `1. The numbers against last week. Run \`factory retro --days ${days} --digests <a directory under the temp dir> --format json\`. \`kpis.kpis\` holds each figure with its history (the last two points are this window and last week's): a table of those that moved, those with a target and whether it is met, the parts of the breakdowns (queued time by reason, time by state, regressions by cause), then \`transcripts\`: seconds by tool category, idle gaps by what ended them, tool-error classes, \`make check\` runs per Issue.`,
    `2. The sample's patterns. \`samples\` lists Issues that regressed, stalled, were slowest, were refused or were dropped; \`transcripts.digests\` names the digest file of each. Have subagents read the digests (general-purpose, which runs on a cheap tier: one per sample group, each answering with the pattern, the Issue refs and the line that shows it) and verify each pattern against a digest line yourself before it goes in. A pattern without a cited line is not in the Report.`,
    `3. The ledger. \`ledger\` holds every earlier retro signal with its Issue, whether it shipped, the KPI it was filed to move, \`before\`, \`now\` and \`moved\`. State for each: shipped or not, and what the number did. Where \`measured\` is not \`after\`, say the window mixes before and after, and name the date the first clean window starts.`,
    `4. Recommendations: one signal per concrete change (\`factory signal file --from agent:software-factory --repo <the repo it belongs in> --title ... --text ...\`), each with the KPI it should move. The text of each signal ends with a marker line, so the next retro finds it: \`Retro: ${date} kpi=<KPI key> before=<its value now, or none> direction=<up|down>\` on a line of its own. A change for another repo is a signal on that repo; the factory's own friction is a signal on software-factory. Put each signal's title and what it should move in the Report.`,
    `Acceptance: the Report states for every ledger entry whether it shipped and what its number did; every recommendation is a filed signal with a marker line and a KPI; no pattern is named without a digest line; the Report is submitted for review.`,
    `Reproduce: factory retro --days ${days}`,
  ].join('\n')
}
