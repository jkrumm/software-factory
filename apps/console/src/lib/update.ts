import { registerSW } from 'virtual:pwa-register'
import { reloadNow, IDLE_RELOAD_MS, type ReloadMoment } from './policy.ts'

const UPDATE_CHECK_MS = 10 * 60_000
const IDLE_TICK_MS = 15_000

let registration: ServiceWorkerRegistration | undefined
/** A new worker has taken over: the next page load runs the new bundle. */
let reloadWaiting = false
/** A screen has no data because this bundle is older than the server: it shows its skeleton and has nothing to lose. */
let blocked = false
let lastActivityAt = Date.now()

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
  location.reload()
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

/**
 * Registers the service worker and keeps a long-lived tab or installed app from running an old bundle against a newer
 * server. It never blocks a screen: the new worker is fetched in the background, and the page loads it at the next
 * navigation, when the tab is hidden, or after `IDLE_RELOAD_MS` without input, and at once only for a screen that has
 * nothing to show until it does. A reload never eats what the owner is typing (`safeToReload`).
 */
export function startUpdates(): void {
  registerSW({
    immediate: true,
    onRegisteredSW: (_url, registered) => {
      registration = registered
    },
    onNeedReload: () => {
      reloadWaiting = true
      reloadAt('activated')
    },
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate()
    else reloadAt('hidden')
  })
  const active = () => {
    lastActivityAt = Date.now()
  }
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const)
    document.addEventListener(type, active, { passive: true, capture: true })
  setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - lastActivityAt >= IDLE_RELOAD_MS) reloadAt('idle')
  }, IDLE_TICK_MS)
  window.addEventListener('online', checkForUpdate)
  setInterval(checkForUpdate, UPDATE_CHECK_MS)
}
