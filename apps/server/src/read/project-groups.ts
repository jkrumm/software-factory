import * as z from 'zod'

/**
 * The groups the owner files his Herdr spaces under (the Herdr app's `groups.json`: INFRA, TOOLING, PERSONAL, APPS, WORK),
 * so the Projects table groups as his sidebar does. A group lists repos by name (`members`) or by a directory on their
 * path (`paths`); a repo no group lists is in the fallback. Read on every call, so an edit shows without a restart; a
 * missing or unreadable file puts every project in the fallback.
 */

const GroupsFile = z.object({
  fallback: z.string().prefault('OTHER'),
  groups: z
    .array(
      z.object({
        label: z.string(),
        members: z.array(z.string()).prefault([]),
        paths: z.array(z.string()).prefault([]),
      }),
    )
    .prefault([]),
})

export interface ProjectGroups {
  /** the labels in the file's order, the fallback last */
  order: string[]
  /** the label of a project by its name and repo path */
  of(project: { name: string; repo: string }): string
}

/** `INFRA` → `Infra`: the file's labels are the sidebar's capitals, the table writes words. */
export const groupWord = (label: string): string =>
  label.length === 0 ? label : label.charAt(0).toUpperCase() + label.slice(1).toLowerCase()

export function projectGroupsOf(raw: unknown): ProjectGroups {
  const parsed = GroupsFile.safeParse(raw)
  const file = parsed.success ? parsed.data : { fallback: 'OTHER', groups: [] }
  const fallback = groupWord(file.fallback)
  const order = [...new Set([...file.groups.map((g) => groupWord(g.label)), fallback])]
  return {
    order,
    of: ({ name, repo }) => {
      const segments = repo.split('/')
      const group = file.groups.find((g) => g.members.includes(name) || g.paths.some((p) => segments.includes(p)))
      return group ? groupWord(group.label) : fallback
    },
  }
}

/** The groups of the file at `path`; none (every project in Other) when the path is unset or the file cannot be read. */
export async function readProjectGroups(path: string | undefined): Promise<ProjectGroups> {
  if (!path) return projectGroupsOf(null)
  try {
    return projectGroupsOf(await Bun.file(path).json())
  } catch {
    return projectGroupsOf(null)
  }
}
