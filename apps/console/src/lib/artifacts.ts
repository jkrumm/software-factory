import type { ArtifactList, CollectionList, ReadIssueCard } from '@software-factory/contract'

type Artifact = ArtifactList['artifacts'][number]
export type Collection = CollectionList['collections'][number]

/** The kinds the index filters by, in the order of the sidebar; the order of the API's own list. */
export const ARTIFACT_KINDS = ['report', 'spec', 'concept', 'decision'] as const satisfies readonly Artifact['kind'][]

export interface ArtifactFilters {
  kind?: Artifact['kind']
  project?: string
  /** Show all: the Specs and Decisions of closed Issues and the copies a newer one superseded, hidden by default */
  all?: boolean
}

/** An artifact with the Issue it hangs on, as far as the Issue cards know it; a standalone one has its own repo. */
export interface ArtifactRow {
  artifact: Artifact
  /** the owning Issue's number, as the Issue page's address wants it; null for a standalone artifact */
  issue: string | null
  issueTitle: string | null
  project: string | null
  /** the numbers of the Issues it is linked to */
  linked: string[]
  /** the owning Issue is closed, as far as the Issue cards know it */
  closed: boolean
}

/** The card's name for a project: the last segment of an Issue's repo, which is a whole path for a second directory of a name. */
const basename = (repo: string | null): string | null => repo?.split('/').filter(Boolean).pop() ?? null

const issueNumber = (ref: string): string => ref.replace(/^issue_/, '')

/** Newest first, each with its Issue's title and project; an Issue the cards do not hold leaves both null (a standalone artifact's project is its repo). */
export function rowsOf(artifacts: readonly Artifact[], cards: readonly ReadIssueCard[]): ArtifactRow[] {
  const byNumber = new Map(cards.map((card) => [String(card.id), card]))
  return artifacts
    .map((artifact): ArtifactRow => {
      const issue = artifact.issueId ? issueNumber(artifact.issueId) : null
      const card = issue ? byNumber.get(issue) : undefined
      return {
        artifact,
        issue,
        issueTitle: card?.title ?? null,
        project: card?.repoName ?? artifact.repo ?? basename(artifact.issueRepo),
        linked: artifact.links.map(issueNumber),
        closed: artifact.issueClosed ?? card?.state === 'closed',
      }
    })
    .sort((a, b) => Date.parse(b.artifact.createdAt) - Date.parse(a.artifact.createdAt))
}

/** The rows of the chosen kind and project. */
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

/** The page's note: what it shows, and how many pages the default view leaves out. */
export function artifactsNote(shown: number, total: number, filtered: boolean, hidden = 0): string {
  const noun = (n: number) => `${n} ${n === 1 ? 'artifact' : 'artifacts'}`
  if (total + hidden === 0) return 'Every Spec, Concept and Report the leads handed over.'
  const tail = hidden > 0 ? ` ${noun(hidden)} of finished or replaced work left out: Show all brings them back.` : ''
  return filtered
    ? `${shown} of ${noun(total)}, newest first.${tail}`
    : `${noun(total)}: Reports to read, Specs and Concepts for a verdict.${tail}`
}

/** Why the default view leaves a row out: its Issue is closed (a Spec or Decision only), or a newer copy has its title. */
export type Hidden = 'closed' | 'superseded'

const titleKey = (row: ArtifactRow): string | null =>
  row.project ? `${row.project}\u0000${row.artifact.title.trim().toLowerCase()}` : null

/**
 * What the default view hides, by artifact id. A Spec or Decision whose Issue is closed has been answered and built; an
 * artifact whose title and project a newer artifact shares was superseded by it (the newest of the same title stays;
 * an artifact with no known project is never taken for a copy). Nothing is deleted: `Show all` lists them.
 */
export function hiddenRows(rows: readonly ArtifactRow[]): Map<string, Hidden> {
  const hidden = new Map<string, Hidden>()
  const newest = new Set<string>()
  for (const row of rows) {
    const key = titleKey(row)
    if (key && !newest.has(key)) newest.add(key)
    else if (key) hidden.set(row.artifact.id, 'superseded')
  }
  for (const row of rows) {
    if (row.closed && (row.artifact.kind === 'spec' || row.artifact.kind === 'decision')) {
      hidden.set(row.artifact.id, 'closed')
    }
  }
  return hidden
}

/** The rows the page lists: every one with Show all, else those the default view keeps. */
export const listedRows = (rows: readonly ArtifactRow[], all: boolean): ArtifactRow[] => {
  if (all) return [...rows]
  const hidden = hiddenRows(rows)
  return rows.filter((row) => !hidden.has(row.artifact.id))
}

/** A collection with its pages as rows, oldest first; a page the list does not hold (retired) is left out. */
export interface CollectionEntry {
  collection: Collection
  members: ArtifactRow[]
}

export function entriesOf(collections: readonly Collection[], rows: readonly ArtifactRow[]): CollectionEntry[] {
  const byId = new Map(rows.map((row) => [row.artifact.id, row]))
  return collections.map((collection) => ({
    collection,
    members: collection.members.flatMap((id) => {
      const row = byId.get(id)
      return row ? [row] : []
    }),
  }))
}

/** Whether a collection passes the page's kind and project filters (a kind: one of its pages has it). */
export const entryMatches = (entry: CollectionEntry, filters: ArtifactFilters): boolean =>
  (!filters.project || entry.collection.repo === filters.project) &&
  (!filters.kind || entry.members.some((row) => row.artifact.kind === filters.kind))

export type ShelfItem =
  | { kind: 'collection'; entry: CollectionEntry }
  | { kind: 'artifact'; row: ArtifactRow; hidden: Hidden | null }

export interface Shelf {
  /** the pinned collections, in the order the server gave (latest pin first) */
  pinned: CollectionEntry[]
  /** the rest by project, sorted: an unpinned collection stands for its pages, and a loose artifact for itself */
  groups: { project: string; items: ShelfItem[] }[]
}

export const NO_PROJECT = 'No project'

/**
 * The page: pinned collections first, then what is left by project. An artifact in a collection shows through its
 * collection, never on its own. `rows` are already the ones the page lists; `hidden` marks the ones Show all brought back.
 */
export function shelfOf(
  collections: readonly CollectionEntry[],
  rows: readonly ArtifactRow[],
  filters: ArtifactFilters,
  hidden: ReadonlyMap<string, Hidden>,
): Shelf {
  const shown = collections.filter((entry) => entryMatches(entry, filters))
  const grouped = new Set(collections.flatMap((entry) => entry.collection.members))
  const groups = new Map<string, ShelfItem[]>()
  const add = (project: string, item: ShelfItem) => groups.set(project, [...(groups.get(project) ?? []), item])
  for (const entry of shown) {
    if (!entry.collection.pinnedAt) add(entry.collection.repo, { kind: 'collection', entry })
  }
  for (const row of visibleRows(rows, filters)) {
    if (grouped.has(row.artifact.id)) continue
    add(row.project ?? NO_PROJECT, { kind: 'artifact', row, hidden: hidden.get(row.artifact.id) ?? null })
  }
  return {
    pinned: shown.filter((entry) => entry.collection.pinnedAt),
    groups: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([project, items]) => ({ project, items })),
  }
}
