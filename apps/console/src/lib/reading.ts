import { useSyncExternalStore } from 'react'

/**
 * The reading size of a rendered artifact, Markdown and HTML alike: smaller, default, larger, remembered per browser. The
 * body size is in px; the measure is the line length the document column is held to.
 */
export type ReadingSize = 'smaller' | 'default' | 'larger'

export const READING_SIZES: readonly ReadingSize[] = ['smaller', 'default', 'larger']
export const READING_PX: Record<ReadingSize, number> = { smaller: 16, default: 18, larger: 20 }
export const READING_LABEL: Record<ReadingSize, string> = {
  smaller: 'Smaller text',
  default: 'Default text size',
  larger: 'Larger text',
}

const KEY = 'console-reading-size'
const listeners = new Set<() => void>()

const isSize = (value: unknown): value is ReadingSize => READING_SIZES.includes(value as ReadingSize)

/** The stored size, the default when none is stored or the browser keeps no storage. */
function storedReadingSize(): ReadingSize {
  try {
    const value = localStorage.getItem(KEY)
    return isSize(value) ? value : 'default'
  } catch {
    return 'default'
  }
}

export function setReadingSize(size: ReadingSize) {
  try {
    if (size === 'default') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, size)
  } catch {
    // a browser without storage keeps the size for this page only
  }
  current = size
  for (const notify of listeners) notify()
}

let current: ReadingSize | undefined

/** The reading size, live: a change in this tab or in another one reaches every artifact on the page. */
export function useReadingSize(): ReadingSize {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify)
      const onStorage = (event: StorageEvent) => {
        if (event.key !== KEY) return
        current = storedReadingSize()
        notify()
      }
      window.addEventListener('storage', onStorage)
      return () => {
        listeners.delete(notify)
        window.removeEventListener('storage', onStorage)
      }
    },
    () => (current ??= storedReadingSize()),
  )
}
