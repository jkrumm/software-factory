import { useEffect, useState, useSyncExternalStore } from 'react'
import { ageWords } from './age.ts'
import { useLive } from './live.ts'
import { queryClient } from './queries.ts'

const AGE_REFRESH_MS = 30_000
const cache = queryClient.getQueryCache()
const subscribeCache = (listener: () => void) => cache.subscribe(listener)

const subscribeOnline = (listener: () => void) => {
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => {
    window.removeEventListener('online', listener)
    window.removeEventListener('offline', listener)
  }
}

/** The text of the connection chip, and whether the data on screen is only a snapshot. */
export function useConnection(): { label: string; offline: boolean; live: boolean } {
  const live = useLive()
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine)
  const failed = useSyncExternalStore(subscribeCache, () => cache.getAll().some((q) => q.state.status === 'error'))
  const newest = useSyncExternalStore(subscribeCache, () =>
    cache.getAll().reduce((latest, q) => Math.max(latest, q.state.dataUpdatedAt), 0),
  )
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGE_REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  if (!online || failed) {
    const label = newest > 0 ? `Offline - snapshot from ${ageWords(Math.max(0, now - newest))}` : 'Offline'
    return { label, offline: true, live: false }
  }
  return { label: live ? 'Live' : 'Polling', offline: false, live }
}
