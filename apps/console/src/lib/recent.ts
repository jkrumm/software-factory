import { useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { pageViewOf, viewOf } from './palette.ts'

export type RecentType = 'issue' | 'artifact' | 'collection' | 'project'
export interface RecentEntry {
  type: RecentType
  id: string
  /** epoch ms of the visit */
  at: number
}

const KEY = 'console-recent'
const LIMIT = 8

const isEntry = (value: unknown): value is RecentEntry => {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    (entry.type === 'issue' || entry.type === 'artifact' || entry.type === 'collection' || entry.type === 'project') &&
    typeof entry.id === 'string' &&
    typeof entry.at === 'number'
  )
}

/** The last visited things, newest first; empty when storage is missing or holds something else. */
export function readRecent(): RecentEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, LIMIT) : []
  } catch {
    return []
  }
}

/** Puts a visit first, replacing an earlier visit of the same thing; keeps the last eight. */
export function recordVisit(entry: RecentEntry): void {
  try {
    const rest = readRecent().filter((old) => old.type !== entry.type || old.id !== entry.id)
    localStorage.setItem(KEY, JSON.stringify([entry, ...rest].slice(0, LIMIT)))
  } catch {
    // storage full or blocked: recents are a convenience
  }
}

/** Records the Issue, artifact, collection or project a page or its peek shows, as the address changes. Call it once, in the shell. */
export function useRecordVisits(): void {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const peekKey = useRouterState({
    select: (s) => {
      const peek = (s.location.search as Record<string, unknown>).peek
      return typeof peek === 'string' ? peek : ''
    },
  })
  useEffect(() => {
    const at = Date.now()
    const page = pageViewOf(pathname)
    const peeked = peekKey ? viewOf('/', { peek: peekKey }) : null
    // the page first, so the peeked thing, which is on top, ends up newest
    for (const view of [page, peeked]) {
      if (!view) continue
      recordVisit({ type: view.type, id: view.type === 'project' ? view.name : view.id, at })
    }
  }, [pathname, peekKey])
}
