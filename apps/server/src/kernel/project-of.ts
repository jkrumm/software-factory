/**
 * The project a repo text (a project name, a path, a worktree below a path) belongs to: the longest repo wins. The one
 * rule planning, capacity and the project digests share.
 */
export function projectOf<P extends { name: string; repo: string }>(
  projects: readonly P[],
  repo: string,
): P | undefined {
  const byName = projects.find((p) => p.name === repo)
  if (byName) return byName
  return projects
    .filter((p) => repo === p.repo || repo.startsWith(`${p.repo}/`))
    .sort((a, b) => b.repo.length - a.repo.length)[0]
}
