import { queryWords } from './highlight.ts'

/** How many Issues the palette lists; the rest are a "N more" hint. */
export const MAX_ISSUES = 8
const MAX_OTHERS = 5
/** Issues shown for an empty query: the most recently active open ones. */
export const RECENT_ISSUES = 5

export interface IssueEntry {
  number: number
  title: string
  repo: string
  kind: string | null
  state: string
  /** ISO time of the last activity */
  updatedAt: string
}
export interface ProjectEntry {
  name: string
  open: number
}
export interface ArtifactEntry {
  id: string
  title: string
  kind: string
}
export interface CommandEntry {
  id: string
  title: string
  /** more words that find it ("dark" for the dark theme) */
  keywords: string
}

export interface PaletteSource {
  issues: IssueEntry[]
  projects: ProjectEntry[]
  artifacts: ArtifactEntry[]
  commands: CommandEntry[]
}

export interface PaletteResult {
  issues: IssueEntry[]
  /** Issues that match beyond the ones listed */
  moreIssues: number
  projects: ProjectEntry[]
  artifacts: ArtifactEntry[]
  commands: CommandEntry[]
}

const NUMBER_QUERY = /^#?(\d+)$/

const isWordStart = (text: string, at: number): boolean => at === 0 || /[^a-z0-9]/.test(text.charAt(at - 1))

/**
 * How well `title` answers `query`: every word must occur in the title or in `extra` (words that find it but are not
 * shown). The title starting with the whole query ranks above every word starting a word, which ranks above a plain
 * substring. 0 is no match.
 */
export function textScore(title: string, query: string, extra = ''): number {
  const words = queryWords(query)
  if (words.length === 0) return 0
  const haystack = title.toLowerCase()
  const rest = extra.toLowerCase()
  if (!words.every((word) => haystack.includes(word) || rest.includes(word))) return 0
  if (haystack.startsWith(words.join(' '))) return 300
  const startsWords = words.every((word) => {
    for (let at = haystack.indexOf(word); at !== -1; at = haystack.indexOf(word, at + 1))
      if (isWordStart(haystack, at)) return true
    return false
  })
  return startsWords ? 200 : 100
}

/** An Issue's score: its exact number first, a number prefix next, then its title; 0 is no match. */
export function issueScore(issue: IssueEntry, query: string): number {
  const asNumber = NUMBER_QUERY.exec(query.trim())
  const digits = asNumber?.[1]
  if (digits !== undefined) {
    const number = String(issue.number)
    if (number === digits) return 1000
    if (number.startsWith(digits)) return 400
  }
  return textScore(issue.title, query)
}

/** Keeps what matches, best first; equal scores keep the order they came in (newest activity first for Issues). */
function rank<T>(items: readonly T[], score: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, value: score(item) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .map((entry) => entry.item)
}

const byRecent = (a: IssueEntry, b: IssueEntry): number => b.updatedAt.localeCompare(a.updatedAt)

/**
 * What the palette lists. An empty query shows every command and the five most recently active open Issues; a query
 * ranks each kind by its score (see `textScore`, `issueScore`), lists at most eight Issues and counts the rest.
 */
export function searchPalette(query: string, source: PaletteSource): PaletteResult {
  if (queryWords(query).length === 0) {
    const open = source.issues.filter((issue) => issue.state !== 'closed').sort(byRecent)
    return {
      issues: open.slice(0, RECENT_ISSUES),
      moreIssues: 0,
      projects: [],
      artifacts: [],
      commands: source.commands,
    }
  }
  const issues = rank(source.issues, (issue) => issueScore(issue, query))
  return {
    issues: issues.slice(0, MAX_ISSUES),
    moreIssues: Math.max(0, issues.length - MAX_ISSUES),
    projects: rank(source.projects, (project) => textScore(project.name, query)).slice(0, MAX_OTHERS),
    artifacts: rank(source.artifacts, (artifact) => textScore(artifact.title, query, artifact.id)).slice(0, MAX_OTHERS),
    commands: rank(source.commands, (command) => textScore(command.title, query, command.keywords)),
  }
}
