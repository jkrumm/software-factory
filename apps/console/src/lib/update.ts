import { useEffect, useState, useSyncExternalStore } from 'react'
import { registerSW } from 'virtual:pwa-register'
import { updatePhase, UPDATE_STUCK_MS, type UpdatePhase } from './freshness.ts'
import { reloadNow, type ReloadMoment } from './policy.ts'
import { keepScroll } from './scroll-keep.ts'

/** One small request for `sw.js` a minute: a deploy reaches an open window within about a minute even when its stream never dropped. */
const UPDATE_CHECK_MS = 60_000

let registration: ServiceWorkerRegistration | undefined
/** A new worker has taken over: the next page load runs the new bundle. */
let reloadWaiting = false
/** When this window first knew of a new build that it has not loaded yet; null while it runs the newest one. */
let updatingSince: number | null = null
const updateListeners = new Set<() => void>()

function setUpdatingSince(value: number | null): void {
  if (value === updatingSince) return
  updatingSince = value
  for (const listener of updateListeners) listener()
}

const subscribeUpdate = (listener: () => void) => {
  updateListeners.add(listener)
  return () => updateListeners.delete(listener)
}

/** The strip's word for the update: `updating` while a new build is on its way in, `stuck` after `UPDATE_STUCK_MS` of it not taking. */
export function useUpdatePhase(): UpdatePhase {
  const since = useSyncExternalStore(subscribeUpdate, () => updatingSince)
  const [, tick] = useState(0)
  useEffect(() => {
    if (since === null) return
    const remaining = since + UPDATE_STUCK_MS - Date.now()
    if (remaining <= 0) return
    const id = setTimeout(() => tick((n) => n + 1), remaining + 1)
    return () => clearTimeout(id)
  }, [since])
  return updatePhase(since, Date.now())
}

/**
 * The button of the stuck notice: forgets the worker and its caches, which is what a hard reload does by hand, and loads the
 * page from the network. It ignores the idle rule on purpose: the owner pressed it.
 */
export async function updateNow(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.map((registered) => registered.unregister()))
    await Promise.all((await caches.keys()).map((name) => caches.delete(name)))
  } finally {
    reloadPage()
  }
}

/** The page loads again, and the screen comes back where the owner was reading (`scroll-keep.ts`). */
function reloadPage(): void {
  keepScroll()
  location.reload()
}
/** A screen has no data because this bundle is older than the server: it shows its skeleton and has nothing to lose. */
let blocked = false

/** Every answer from a newer server asks for the new bundle: one request a half minute is enough. */
const CHECK_THROTTLE_MS = 30_000
let lastCheckAt = 0

/** Asks the browser for a newer service worker now; a failure (offline) is the next check's business. */
export function checkForUpdate(): void {
  const now = Date.now()
  if (now - lastCheckAt < CHECK_THROTTLE_MS) return
  lastCheckAt = now
  void registration?.update().catch(() => undefined)
}

const hasDraft = (): boolean => [...document.querySelectorAll('textarea')].some((field) => field.value !== '')

function reloadAt(moment: ReloadMoment): boolean {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  if (!reloadNow(moment, { waiting: reloadWaiting, blocked, focused, hasDraft: hasDraft() })) return false
  reloadPage()
  return true
}

/** A screen reports that it waits for the new bundle (`true`) or that it no longer does; the reload then comes as soon as the new worker is in. */
export function awaitUpdate(waiting: boolean): void {
  blocked = waiting
  if (waiting) {
    checkForUpdate()
    reloadAt('activated')
  }
}

/**
 * The page is about to navigate within the app: a new bundle waiting is loaded by the navigation itself (a full load of the
 * target), so the owner never sees a reload in the middle of reading. True when it took the navigation over.
 */
export function reloadOnNavigation(href: string): boolean {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  if (!reloadNow('navigation', { waiting: reloadWaiting, blocked, focused, hasDraft: hasDraft() })) return false
  location.assign(href)
  return true
}

/** The new worker is in control (`skipWaiting` and `clientsClaim` make it so at once): the page loads its bundle at the next quiet moment. */
function activated(): void {
  reloadWaiting = true
  setUpdatingSince(updatingSince ?? Date.now())
  if (!reloadAt('activated') && document.visibilityState === 'hidden') reloadAt('hidden')
}

/**
 * Registers the service worker and keeps a long-lived tab or installed app from running an old bundle against a newer
 * server. A new worker takes over by itself (`skipWaiting`, `clientsClaim` in `vite.config.ts`). It never blocks a screen:
 * the page loads the new bundle at the next navigation or when the tab is hidden (a quiet tab is someone reading, not an
 * idle one), and at once only for a screen that has nothing to show until it does; the reload keeps the reading position. A reload never eats what the owner is typing
 * (`safeToReload`); while the new build waits for such a moment the strip says `updating`, and after `UPDATE_STUCK_MS`
 * it offers the button.
 */
export function startUpdates(): void {
  let controlled = navigator.serviceWorker?.controller != null
  registerSW({
    immediate: true,
    onRegisteredSW: (_url, registered) => {
      registration = registered
      if (!registered) return
      // a first install is no update: the window has no older worker to replace
      if (registered.waiting) setUpdatingSince(Date.now())
      registered.addEventListener('updatefound', () => {
        const worker = registered.installing
        if (!worker || !navigator.serviceWorker.controller) return
        setUpdatingSince(updatingSince ?? Date.now())
        worker.addEventListener('statechange', () => {
          if (worker.state === 'redundant' && !reloadWaiting) setUpdatingSince(null)
        })
      })
    },
    onNeedReload: activated,
  })
  // the plugin's `activated` event is the main path; the controller changing is the same fact seen from the page
  navigator.serviceWorker?.addEventListener('controllerchange', () => {
    // the first claim of a first install is no update
    if (controlled) activated()
    controlled = true
  })
  // a lazy chunk of the old build is gone from the server once the new one is live: its load fails, and only a reload cures it.
  // The event is not cancelled: a cancelled one makes `import()` resolve to nothing, which `React.lazy` cannot render.
  window.addEventListener('vite:preloadError', () => {
    if (!reloadAt('broken')) checkForUpdate()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate()
    else reloadAt('hidden')
  })
  window.addEventListener('online', checkForUpdate)
  setInterval(checkForUpdate, UPDATE_CHECK_MS)
}
