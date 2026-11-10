import type { ProjectView, ReadIssueCards } from '@software-factory/contract'

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
