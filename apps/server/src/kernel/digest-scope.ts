import type { IssueId } from './ids.ts'

/**
 * What the project digests share between the digest loop (`domains/loops/digest.ts`) and the read of them
 * (`read/digests.ts`): which Issues belong to which project and what they count to. Pure.
 */

/** The window the digest looks back over, and the age at which a project with no Issue in it is no longer asked about. */
export const DIGEST_WINDOW_MS = 7 * 24 * 3_600_000

/** A project with a `project.yaml` of its own: its name, and its repo's path (a worktree below it is the same project). */
export interface DigestProject {
  name: string
  repo: string
}

export type DigestState = 'settling' | 'queued' | 'working' | 'waiting' | 'watching' | 'closed'

/** One Issue as the digest sees it: every open one, and the ones closed inside the window. */
export interface DigestIssue {
  id: IssueId
  /** the Issue's `repo` as stored: a project name, or an absolute path */
  repo: string
  state: DigestState
  title: string
  kind: string
  /** why a waiting Issue waits */
  waitReason: string | null
  /** how a closed Issue ended */
  outcome: string | null
  /** when it closed, or for an open one when it entered its state */
  at: Date
  /** the Issues an open one still waits for */
  after: IssueId[]
}

/** The project a repo text (a name, a path, a worktree below a path) belongs to: the longest repo wins. */
export function projectOfRepo<P extends DigestProject>(projects: readonly P[], repo: string): P | undefined {
  const byName = projects.find((p) => p.name === repo)
  if (byName) return byName
  return projects
    .filter((p) => repo === p.repo || repo.startsWith(`${p.repo}/`))
    .sort((a, b) => b.repo.length - a.repo.length)[0]
}

/** Issues by the name of their project; an Issue of no listed project is left out. */
export function groupByProject(
  projects: readonly DigestProject[],
  issues: readonly DigestIssue[],
): Map<string, DigestIssue[]> {
  const groups = new Map<string, DigestIssue[]>()
  for (const issue of issues) {
    const project = projectOfRepo(projects, issue.repo)
    if (!project) continue
    const group = groups.get(project.name) ?? []
    group.push(issue)
    groups.set(project.name, group)
  }
  return groups
}

export interface DigestCounts {
  done7d: number
  working: number
  queued: number
  waiting: number
}

const shipped = (issue: DigestIssue): boolean =>
  issue.state === 'closed' && (issue.outcome === 'done' || issue.outcome === 'healed')

/** What the project has, counted from the Issues: never from the model. */
export function countsOf(issues: readonly DigestIssue[], now: Date): DigestCounts {
  const since = now.getTime() - DIGEST_WINDOW_MS
  const counts: DigestCounts = { done7d: 0, working: 0, queued: 0, waiting: 0 }
  for (const issue of issues) {
    if (shipped(issue)) {
      if (issue.at.getTime() >= since) counts.done7d++
    } else if (issue.state === 'working' || issue.state === 'watching') counts.working++
    else if (issue.state === 'queued' || issue.state === 'settling') counts.queued++
    else if (issue.state === 'waiting') counts.waiting++
  }
  return counts
}
