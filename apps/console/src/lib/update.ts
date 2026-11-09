import { registerSW } from 'virtual:pwa-register'
import { safeToReload } from './policy.ts'

const UPDATE_CHECK_MS = 10 * 60_000

let registration: ServiceWorkerRegistration | undefined
let reloadWaiting = false

/** Asks the browser for a newer service worker now; a failure (offline) is the next check's business. */
export function checkForUpdate(): void {
  void registration?.update().catch(() => undefined)
}

const hasDraft = (): boolean => [...document.querySelectorAll('textarea')].some((field) => field.value !== '')

function reloadIfSafe(): void {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  if (!reloadWaiting || !safeToReload(focused, hasDraft())) return
  location.reload()
}

/**
 * Registers the service worker and keeps a long-lived tab or installed app from running an old bundle against a newer
 * server: it asks for a new worker whenever the page could have missed a deploy, and reloads once one has taken over, at
 * a moment that loses nothing the owner is typing.
 */
export function startUpdates(): void {
  registerSW({
    immediate: true,
    onRegisteredSW: (_url, registered) => {
      registration = registered
    },
    onNeedReload: () => {
      reloadWaiting = true
      reloadIfSafe()
    },
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate()
    else reloadIfSafe()
  })
  document.addEventListener('focusout', () => setTimeout(reloadIfSafe, 0))
  window.addEventListener('online', checkForUpdate)
  setInterval(checkForUpdate, UPDATE_CHECK_MS)
}
