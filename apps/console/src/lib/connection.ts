import { useEffect, useState, useSyncExternalStore } from 'react'
import { ageWords } from './age.ts'
import { useLastEventAt, useLive } from './live.ts'
import { queryClient } from './queries.ts'
import { getFailingSince, restartPhase, RESTART_WINDOW_MS, subscribeFailing } from './restart.ts'

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

export const RESTARTING_LABEL = 'Server restarting, reconnecting'

export interface Connection {
  label: string
  offline: boolean
  /** the server is restarting (a deploy): the data on screen stays, the page reconnects by itself */
  restarting: boolean
  live: boolean
  /** epoch ms of the stream's last frame; null before the first */
  lastEventAt: number | null
  /** epoch ms of the newest data any query holds; 0 when none */
  newestDataAt: number
  /** the clock the ages are measured against, refreshed every 30 s */
  now: number
}

/** True while the server restarts: the stream dropped or a fetch got no answer, inside the restart window, browser online. */
export function useRestarting(): boolean {
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine)
  const failingSince = useSyncExternalStore(subscribeFailing, getFailingSince)
  const [, tick] = useState(0)
  useEffect(() => {
    if (failingSince === null) return
    const remaining = failingSince + RESTART_WINDOW_MS - Date.now()
    if (remaining <= 0) return
    const id = setTimeout(() => tick((n) => n + 1), remaining + 1)
    return () => clearTimeout(id)
  }, [failingSince])
  return restartPhase({ failingSince, online, now: Date.now() }) === 'restarting'
}

/** The state of the stream for the Live indicator and its popover, and whether the data on screen is only a snapshot. */
export function useConnection(): Connection {
  const live = useLive()
  const lastEventAt = useLastEventAt()
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine)
  const restarting = useRestarting()
  const failed = useSyncExternalStore(subscribeCache, () => cache.getAll().some((q) => q.state.status === 'error'))
  const newest = useSyncExternalStore(subscribeCache, () =>
    cache.getAll().reduce((latest, q) => Math.max(latest, q.state.dataUpdatedAt), 0),
  )
  const failingSince = useSyncExternalStore(subscribeFailing, getFailingSince)
  const streamLost = failingSince !== null && !live
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGE_REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  if (restarting) {
    return { label: RESTARTING_LABEL, offline: false, restarting, live: false, lastEventAt, newestDataAt: newest, now }
  }
  if (!online || failed || streamLost) {
    const label = newest > 0 ? `Offline - snapshot from ${ageWords(Math.max(0, now - newest))}` : 'Offline'
    return { label, offline: true, restarting: false, live: false, lastEventAt, newestDataAt: newest, now }
  }
  return {
    label: live ? 'Live' : 'Polling',
    offline: false,
    restarting: false,
    live,
    lastEventAt,
    newestDataAt: newest,
    now,
  }
}
