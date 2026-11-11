import { type TabKey, TAB_KEYS } from '@/lib/issue-page'

/**
 * The peek: an Issue or an artifact opened in a right-side panel over whatever page the owner is on. It lives in the
 * URL (`?peek=issues/12`, `?peek=artifacts/<id>`, with `peekTab` for the Issue's tab and `peekRevision` for the
 * artifact's revision), so a reload and the browser's back button restore it.
 */
export type Peek =
  | { kind: 'issue'; id: string; tab?: Exclude<TabKey, 'overview'> }
  | { kind: 'artifact'; id: string; revision?: number }

export type PeekSearch = Partial<{ peek: string; peekTab: string; peekRevision: number }>

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

const positive = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isInteger(n) && n > 0 ? n : undefined
}

const tabOfPeek = (value: unknown): Exclude<TabKey, 'overview'> | undefined =>
  TAB_KEYS.find((key): key is Exclude<TabKey, 'overview'> => key !== 'overview' && key === value)

/** What a URL's search says is peeked at; null for none or for a value that names nothing we can show. */
export function peekOf(search: Record<string, unknown>): Peek | null {
  const value = text(search.peek)
  if (!value) return null
  const [collection, ...rest] = value.split('/')
  const id = rest.join('/')
  if (!id) return null
  if (collection === 'issues' && /^\d+$/.test(id)) {
    const tab = tabOfPeek(search.peekTab)
    return { kind: 'issue', id, ...(tab ? { tab } : {}) }
  }
  if (collection === 'artifacts') {
    const revision = positive(search.peekRevision)
    return { kind: 'artifact', id, ...(revision ? { revision } : {}) }
  }
  return null
}

/** The search keys of a peek; every key not used is `undefined`, so spreading it over a search clears the old peek. */
export function peekSearch(peek: Peek | null): PeekSearch {
  if (!peek) return { peek: undefined, peekTab: undefined, peekRevision: undefined }
  if (peek.kind === 'issue') return { peek: `issues/${peek.id}`, peekTab: peek.tab, peekRevision: undefined }
  return { peek: `artifacts/${peek.id}`, peekTab: undefined, peekRevision: peek.revision }
}

/** The peek a link to this page stands for: `/issues/12` and `/artifacts/<id>`; every other address, and a view of the page that has no peek form (a comparison), is null. */
export function peekTarget(pathname: string, params: URLSearchParams): Peek | null {
  const [, collection, rawId, ...rest] = pathname.replace(/\/+$/, '').split('/')
  if (!rawId || rest.length > 0) return null
  const id = decodeURIComponent(rawId)
  if (collection === 'issues') return peekOf({ peek: `issues/${id}`, peekTab: params.get('tab') ?? undefined })
  if (collection === 'artifacts') {
    if (params.has('compare')) return null
    return peekOf({ peek: `artifacts/${id}`, peekRevision: params.get('revision') ?? undefined })
  }
  return null
}

/** The page of a peek, for "Open full page". */
export function peekPage(peek: Peek): { to: '/issues/$id' | '/artifacts/$id'; params: { id: string }; search: object } {
  if (peek.kind === 'issue')
    return { to: '/issues/$id', params: { id: peek.id }, search: peek.tab ? { tab: peek.tab } : {} }
  return { to: '/artifacts/$id', params: { id: peek.id }, search: peek.revision ? { revision: peek.revision } : {} }
}

export interface ClickLike {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
}

/** A plain primary click: the one that opens the peek. Any modifier is the browser's own (a new tab) or the full page. */
export const isPlainClick = (event: ClickLike): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented
