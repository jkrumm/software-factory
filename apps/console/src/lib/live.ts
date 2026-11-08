import { CHANGE_KINDS } from '@software-factory/contract'
import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { nextBackoff, trailingDebounce } from './debounce.ts'

export const INVALIDATE_DEBOUNCE_MS = 250
const STREAM_PATH = '/v1/stream'

let live = false
const listeners = new Set<() => void>()

function setLive(value: boolean) {
  if (live === value) return
  live = value
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** True while the event stream is open; the queries poll while it is not. */
export const useLive = (): boolean => useSyncExternalStore(subscribe, () => live)

/**
 * Keeps one `EventSource` on the change stream: every change invalidates the active queries (debounced). A drop reconnects
 * with backoff, and on `online` and when the tab shows again. It resumes from the last cursor; a connection that fails
 * before its first frame drops the cursor, which is how a 410 `cursor_gone` (invisible to `EventSource`) starts over.
 * Returns the function that stops it.
 */
export function startLive(queryClient: QueryClient): () => void {
  const invalidate = trailingDebounce(() => void queryClient.invalidateQueries(), INVALIDATE_DEBOUNCE_MS)
  let source: EventSource | null = null
  let cursor: string | undefined
  let greeted = false
  let delay: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const close = () => {
    source?.close()
    source = null
    setLive(false)
  }

  const open = () => {
    clearTimeout(timer)
    close()
    greeted = false
    const es = new EventSource(cursor ? `${STREAM_PATH}?since=${encodeURIComponent(cursor)}` : STREAM_PATH)
    source = es
    es.addEventListener('hello', (event) => {
      greeted = true
      delay = undefined
      cursor = event.lastEventId || cursor
      setLive(true)
      invalidate.call()
    })
    for (const kind of CHANGE_KINDS) {
      es.addEventListener(kind, (event) => {
        cursor = event.lastEventId || cursor
        invalidate.call()
      })
    }
    es.onerror = () => {
      close()
      if (!greeted) cursor = undefined
      delay = nextBackoff(delay)
      timer = setTimeout(open, delay)
    }
  }

  const reconnectNow = () => {
    if (source?.readyState === EventSource.OPEN) return
    delay = undefined
    open()
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') reconnectNow()
  }

  open()
  window.addEventListener('online', reconnectNow)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    window.removeEventListener('online', reconnectNow)
    document.removeEventListener('visibilitychange', onVisible)
    clearTimeout(timer)
    invalidate.cancel()
    close()
  }
}
