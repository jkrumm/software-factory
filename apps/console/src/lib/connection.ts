import { useEffect, useState, useSyncExternalStore } from 'react'
import { ageWords } from './age.ts'
import { staleReads, type PolledRead, type StaleRead } from './freshness.ts'
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

/**
 * Bumped when a query's data or its set of observers changes: a snapshot a component can compare without holding the array of
 * queries. Not on `observerOptionsUpdated`, which every render of a component with a query fires, so a component that read
 * it and held a query itself would render for ever.
 */
let cacheVersion = 0
const VERSIONED = new Set(['added', 'removed', 'updated', 'observerAdded', 'observerRemoved'])
cache.subscribe((event) => {
  if (VERSIONED.has(event.type)) cacheVersion += 1
})
const getCacheVersion = () => cacheVersion

/** The reads on screen that poll, with the interval each is read at; a read nobody watches, or that does not poll, is not here. */
function polledReads(): PolledRead[] {
  return cache.getAll().flatMap((query) => {
    const intervals = query.observers.flatMap((observer) =>
      observer.options.enabled !== false && typeof observer.options.refetchInterval === 'number'
        ? [observer.options.refetchInterval]
        : [],
    )
    const intervalMs = Math.min(...intervals)
    return Number.isFinite(intervalMs)
      ? [{ key: query.queryKey, updatedAt: query.state.dataUpdatedAt, intervalMs }]
      : []
  })
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
  /** the polled reads whose data is older than their poll interval; none while the tab is hidden (a hidden tab does not poll) */
  stale: StaleRead[]
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
  // re-render when a read lands: staleness is computed from the cache below
  useSyncExternalStore(subscribeCache, getCacheVersion)
  const streamLost = failingSince !== null && !live
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGE_REFRESH_MS)
    return () => clearInterval(id)
  }, [])
  const stale = document.visibilityState === 'hidden' ? [] : staleReads(polledReads(), now)

  if (restarting) {
    return {
      label: RESTARTING_LABEL,
      offline: false,
      restarting,
      live: false,
      lastEventAt,
      newestDataAt: newest,
      now,
      stale,
    }
  }
  if (!online || failed || streamLost) {
    const label = newest > 0 ? `Offline - snapshot from ${ageWords(Math.max(0, now - newest))}` : 'Offline'
    return {
      label,
      offline: true,
      restarting: false,
      live: false,
      lastEventAt,
      newestDataAt: newest,
      now,
      stale,
    }
  }
  return {
    label: live ? 'Live' : 'Polling',
    offline: false,
    restarting: false,
    live,
    lastEventAt,
    newestDataAt: newest,
    now,
    stale,
  }
}
