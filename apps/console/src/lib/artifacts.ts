import type { ArtifactList, ReadIssueCard } from '@software-factory/contract'

type Artifact = ArtifactList['artifacts'][number]

/** The kinds the index filters by, in the order of the sidebar; the order of the API's own list. */
export const ARTIFACT_KINDS = ['report', 'spec', 'concept', 'decision'] as const satisfies readonly Artifact['kind'][]

export interface ArtifactFilters {
  kind?: Artifact['kind']
  project?: string
}

/** An artifact with the Issue it hangs on, as far as the Issue cards know it. */
export interface ArtifactRow {
  artifact: Artifact
  /** the Issue's number, as the Issue page's address wants it */
  issue: string
  issueTitle: string | null
  project: string | null
}

const issueNumber = (ref: string): string => ref.replace(/^issue_/, '')

/** Newest first, each with its Issue's title and project; an Issue the cards do not hold leaves both null. */
export function rowsOf(artifacts: readonly Artifact[], cards: readonly ReadIssueCard[]): ArtifactRow[] {
  const byNumber = new Map(cards.map((card) => [String(card.id), card]))
  return artifacts
    .map((artifact): ArtifactRow => {
      const issue = issueNumber(artifact.issueId)
      const card = byNumber.get(issue)
      return { artifact, issue, issueTitle: card?.title ?? null, project: card?.repoName ?? null }
    })
    .sort((a, b) => Date.parse(b.artifact.createdAt) - Date.parse(a.artifact.createdAt))
}

export const visibleRows = (rows: readonly ArtifactRow[], filters: ArtifactFilters): ArtifactRow[] =>
  rows.filter(
    (row) =>
      (!filters.kind || row.artifact.kind === filters.kind) && (!filters.project || row.project === filters.project),
  )

/** How many of each kind, among the rows of the chosen project. */
export function kindCounts(rows: readonly ArtifactRow[], project?: string): Record<Artifact['kind'], number> {
  const counts = { concept: 0, spec: 0, decision: 0, report: 0 }
  for (const row of rows) if (!project || row.project === project) counts[row.artifact.kind] += 1
  return counts
}

/** How many per project, among the rows of the chosen kind; an artifact whose Issue is unknown counts for no project. */
export function projectCounts(rows: readonly ArtifactRow[], kind?: Artifact['kind']): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows)
    if (row.project && (!kind || row.artifact.kind === kind)) counts[row.project] = (counts[row.project] ?? 0) + 1
  return counts
}

/** Every project that has an artifact, sorted; a filter on one that has none stays listed so it can be removed. */
export function projectsOfRows(rows: readonly ArtifactRow[], keep?: string): string[] {
  const projects = new Set(rows.flatMap((row) => (row.project ? [row.project] : [])))
  if (keep) projects.add(keep)
  return [...projects].sort((a, b) => a.localeCompare(b))
}

/** The page's note: how many show, and of how many when a filter cuts the list. */
export function artifactsNote(shown: number, total: number, filtered: boolean): string {
  const noun = (n: number) => `${n} ${n === 1 ? 'artifact' : 'artifacts'}`
  if (total === 0) return 'Every Spec, Concept and Report the leads handed over, newest first.'
  return filtered
    ? `${shown} of ${noun(total)}, newest first.`
    : `${noun(total)}, newest first: Reports to read, Specs and Concepts for a verdict.`
}
