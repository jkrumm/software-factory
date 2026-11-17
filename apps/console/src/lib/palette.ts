import { queryWords } from './highlight.ts'
import { peekOf } from './peek.ts'
import type { RecentEntry } from './recent.ts'

/** How many Issues the palette lists; the rest are a "N more" hint. */
export const MAX_ISSUES = 8
const MAX_OTHERS = 5
/** Issues shown for an empty query: the most recently active open ones. */
const RECENT_ISSUES = 5

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
export interface CollectionEntry {
  id: string
  title: string
  repo: string
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
  collections: CollectionEntry[]
  commands: CommandEntry[]
  /** actions on the thing in view (`contextActions`), shown as "This page" */
  context?: ContextAction[]
}

export interface PaletteResult {
  issues: IssueEntry[]
  /** Issues that match beyond the ones listed */
  moreIssues: number
  projects: ProjectEntry[]
  artifacts: ArtifactEntry[]
  collections: CollectionEntry[]
  commands: CommandEntry[]
  context: ContextAction[]
  /** a number was typed and no listed Issue has it: the row "Open Issue #n" still opens it */
  openNumber: number | null
  /** the query is a project's whole name: that project leads the list and is what Enter opens, ahead of Issues whose titles start with it */
  projectFirst: boolean
  /** the last visited things, newest first, resolved to titles; empty for a query */
  recent: RecentRow[]
}

/** A visited thing as the palette shows it: its title when the loaded lists know it, else its reference. */
export interface RecentRow extends RecentEntry {
  title: string
  reference: string
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

function resolveRecent(recent: readonly RecentEntry[], source: PaletteSource): RecentRow[] {
  return recent.map((entry): RecentRow => {
    if (entry.type === 'issue') {
      const found = source.issues.find((issue) => String(issue.number) === entry.id)
      return { ...entry, title: found?.title ?? `Issue #${entry.id}`, reference: `#${entry.id}` }
    }
    if (entry.type === 'artifact') {
      const found = source.artifacts.find((artifact) => artifact.id === entry.id)
      return { ...entry, title: found?.title ?? `Artifact ${entry.id}`, reference: entry.id }
    }
    if (entry.type === 'collection') {
      const found = source.collections.find((collection) => collection.id === entry.id)
      return { ...entry, title: found?.title ?? `Collection ${entry.id}`, reference: entry.id }
    }
    const found = source.projects.find((project) => project.name === entry.id)
    return { ...entry, title: entry.id, reference: found ? `${found.open} open` : '' }
  })
}

/** The Issue number a query names when it is only a number, else null. */
function numberOf(query: string): number | null {
  const digits = NUMBER_QUERY.exec(query.trim())?.[1]
  if (digits === undefined) return null
  const n = Number(digits)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * What the palette lists. An empty query shows the recent visits first, the actions on the page in view, the five most
 * recently active open Issues that are not already recent, and every command; a query ranks each kind by its score
 * (see `textScore`, `issueScore`), lists at most eight Issues and counts the rest. A bare number no Issue in the list
 * has comes back as `openNumber`, so an Issue by number opens before the list has loaded.
 */
export function searchPalette(
  query: string,
  source: PaletteSource,
  recent: readonly RecentEntry[] = [],
): PaletteResult {
  const context = source.context ?? []
  if (queryWords(query).length === 0) {
    const seen = new Set(recent.filter((entry) => entry.type === 'issue').map((entry) => entry.id))
    const open = source.issues
      .filter((issue) => issue.state !== 'closed' && !seen.has(String(issue.number)))
      .sort(byRecent)
    return {
      issues: open.slice(0, RECENT_ISSUES),
      moreIssues: 0,
      projects: [],
      artifacts: [],
      collections: [],
      commands: source.commands,
      context,
      openNumber: null,
      projectFirst: false,
      recent: resolveRecent(recent, source),
    }
  }
  const issues = rank(source.issues, (issue) => issueScore(issue, query))
  const number = numberOf(query)
  const projects = rank(source.projects, (project) => textScore(project.name, query)).slice(0, MAX_OTHERS)
  const named = query.trim().toLowerCase()
  return {
    issues: issues.slice(0, MAX_ISSUES),
    moreIssues: Math.max(0, issues.length - MAX_ISSUES),
    projects,
    artifacts: rank(source.artifacts, (artifact) => textScore(artifact.title, query, artifact.id)).slice(0, MAX_OTHERS),
    collections: rank(source.collections, (collection) => textScore(collection.title, query, collection.id)).slice(
      0,
      MAX_OTHERS,
    ),
    commands: rank(source.commands, (command) => textScore(command.title, query, command.keywords)),
    context: rank(context, (command) => textScore(command.title, query, command.keywords)),
    openNumber: number !== null && !source.issues.some((issue) => issue.number === number) ? number : null,
    projectFirst: projects[0]?.name.toLowerCase() === named,
    recent: [],
  }
}

/** The thing a page or its peek shows. */
export type PaletteView =
  | { type: 'issue'; id: string }
  | { type: 'artifact'; id: string }
  | { type: 'collection'; id: string }
  | { type: 'project'; name: string }

/** The thing in view: a peek wins over the page under it; null on any other page. */
export function viewOf(pathname: string, search: Record<string, unknown>): PaletteView | null {
  const peek = peekOf(search)
  if (peek) return { type: peek.kind, id: peek.id }
  return pageViewOf(pathname)
}

/** The thing a page's own address names. */
export function pageViewOf(pathname: string): PaletteView | null {
  const [, first, second, third] = pathname.replace(/\/+$/, '').split('/')
  if (!first || !second) return null
  const id = decodeURIComponent(second)
  if (first === 'issues' && /^\d+$/.test(id)) return { type: 'issue', id }
  if (first === 'projects') return { type: 'project', name: id }
  if (first !== 'artifacts') return null
  if (id !== 'collections') return { type: 'artifact', id }
  return third ? { type: 'collection', id: decodeURIComponent(third) } : null
}

/** What the palette knows about the thing in view beyond its id. */
export interface ViewFacts {
  /** `location.origin`, for links */
  origin: string
  /** an Issue's project, when the card list has it */
  repo?: string | null | undefined
  /** the Needs you item that waits on this Issue */
  needItem?: string | null | undefined
  /** a collection's pinned state; null or absent while the list has not loaded */
  pinned?: boolean | null | undefined
}

/** An action on the thing in view; `copy` is the text it puts on the clipboard. */
export interface ContextAction extends CommandEntry {
  copy?: string
}

/** The actions that exist for the thing in view; the palette maps each id to its effect. */
export function contextActions(view: PaletteView | null, facts: ViewFacts): ContextAction[] {
  if (!view) return []
  const link = (title: string, path: string): ContextAction => ({
    id: 'context-copy-link',
    title,
    keywords: 'url share copy',
    copy: `${facts.origin}${path}`,
  })
  const cli = (command: string): ContextAction => ({
    id: 'context-copy-cli',
    title: `Copy CLI command: ${command}`,
    keywords: 'terminal shell copy',
    copy: command,
  })
  if (view.type === 'issue') {
    const n = view.id
    return [
      link(`Copy link to Issue ${n}`, `/issues/${n}`),
      cli(`factory issue show ${n}`),
      ...(facts.repo
        ? [{ id: 'context-chain', title: `Open Issue ${n}'s project in the Chain`, keywords: facts.repo }]
        : []),
      ...(facts.needItem ? [{ id: 'context-answer', title: `Answer Issue ${n}`, keywords: 'needs you reply' }] : []),
    ]
  }
  if (view.type === 'artifact')
    return [
      link('Copy link to this artifact', `/artifacts/${encodeURIComponent(view.id)}`),
      cli(`factory artifact show ${view.id}`),
    ]
  if (view.type === 'collection')
    return [
      ...(facts.pinned === null || facts.pinned === undefined
        ? []
        : [
            {
              id: 'context-pin',
              title: facts.pinned ? 'Unpin collection' : 'Pin collection',
              keywords: 'pin unpin',
            },
          ]),
      link('Copy link to this collection', `/artifacts/collections/${encodeURIComponent(view.id)}`),
    ]
  const name = view.name
  return [
    { id: 'context-chain', title: `Open ${name} in the Chain`, keywords: 'graph' },
    { id: 'context-overview', title: `Show ${name}'s Issues on the Overview`, keywords: 'flow filter' },
    link(`Copy link to ${name}`, `/projects/${encodeURIComponent(name)}`),
    cli(`factory project plan ${name}`),
  ]
}
