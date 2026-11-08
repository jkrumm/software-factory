import { useSyncExternalStore } from 'react'

/** Whether a media query matches, live. The board switches layout with this at the `lg` breakpoint. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', notify)
      return () => list.removeEventListener('change', notify)
    },
    () => window.matchMedia(query).matches,
  )
}
