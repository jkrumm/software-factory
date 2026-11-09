import { useEffect, useState, useSyncExternalStore } from 'react'
import { ageWords } from './age.ts'
import { useLastEventAt, useLive } from './live.ts'
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

export interface Connection {
  label: string
  offline: boolean
  live: boolean
  /** epoch ms of the stream's last frame; null before the first */
  lastEventAt: number | null
  /** epoch ms of the newest data any query holds; 0 when none */
  newestDataAt: number
  /** the clock the ages are measured against, refreshed every 30 s */
  now: number
}

/** The state of the stream for the Live indicator and its popover, and whether the data on screen is only a snapshot. */
export function useConnection(): Connection {
  const live = useLive()
  const lastEventAt = useLastEventAt()
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
    return { label, offline: true, live: false, lastEventAt, newestDataAt: newest, now }
  }
  return { label: live ? 'Live' : 'Polling', offline: false, live, lastEventAt, newestDataAt: newest, now }
}
