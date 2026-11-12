import type { ProjectSyncAnswer, ProjectView, ReadIssueCards, ShipAnswer } from '@software-factory/contract'

// `data` is the answer runOperation already parsed with the operation's response schema.

/** `issue list --format plain`: one line per Issue, `<ref>\t<state>\t<repoName>\t<title>`; no Issue, no output. */
export function issueListPlain(data: unknown): string {
  return (data as ReadIssueCards).issues
    .map((card) => [card.ref, card.state, card.repoName, card.title].join('\t'))
    .join('\n')
}

/** `project show --format plain`: a header, the plan's error and warnings, then one line per plan row. */
export function projectShowPlain(data: unknown): string {
  const project = data as ProjectView
  const lines = [
    `${project.name} branch=${project.branch ?? '-'} leads=${project.leads} synced=${project.syncedAt ?? '-'}`,
  ]
  if (project.planError) lines.push(`planError: ${project.planError}`)
  if (!project.plan) return [...lines, 'no plan'].join('\n')
  for (const warning of project.plan.warnings) lines.push(`warning: ${warning}`)
  for (const row of project.plan.rows) lines.push([row.key, row.state, row.issue ?? '-', row.reason ?? '-'].join('\t'))
  return lines.join('\n')
}

/**
 * `issue ship`: a ship the review does not cover is recorded, never refused, so the answer is the only place the lead
 * hears it. One line per range: the command that reviews it. A review agw could not read is named with its reason.
 */
export function shipNotice(data: unknown): string {
  const review = (data as ShipAnswer).evidence.find((line) => line.kind === 'review')
  if (!review || review.status === 'covered' || review.status === 'not_required') return ''
  if (review.status === 'unknown') return `review: not read (${review.reason ?? 'no reason given'})`
  const named = review.uncovered.map((c) => `${c.sha.slice(0, 12)} needs ${c.required}`).join(', ')
  const ranges = review.ranges.map((r) => `${r.base.slice(0, 12)}..${r.head.slice(0, 12)}`).join(' ')
  return `review: uncovered${named ? ` (${named})` : ''}. Recorded as uncovered. Run /review on ${ranges || 'the shipped range'}, or say in the report why it has none.`
}

/** `project sync`: a file that does not parse is named on stderr, one line each, so the session that pushed it sees it at once. */
export function syncNotice(data: unknown): string {
  return (data as ProjectSyncAnswer).broken
    .map((file) => `broken: ${file.project} ${file.file}: ${file.message}`)
    .join('\n')
}
