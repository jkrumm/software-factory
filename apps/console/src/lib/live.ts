import { CHANGE_KINDS } from '@software-factory/contract'
import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { nextBackoff, trailingDebounce } from './debounce.ts'
import {
  affectedByAny,
  isAggregate,
  parseChange,
  silentWhileHidden,
  sleptBetween,
  WATCHDOG_TICK_MS,
  type Change,
} from './policy.ts'
import { fetchMachine } from './api.ts'
import { markRecovered } from './restart.ts'
import { checkForUpdate } from './update.ts'

const INVALIDATE_DEBOUNCE_MS = 250
/** A steady stream still refetches the lists this often. */
const INVALIDATE_MAX_WAIT_MS = 1_000
/** The aggregates (KPIs, friction, finding classes, fix commits) move slowly: they wait for a longer pause. */
const AGGREGATE_DEBOUNCE_MS = 2_000
const AGGREGATE_MAX_WAIT_MS = 10_000
const STREAM_PATH = '/v1/stream'

let live = false
let lastEventAt: number | null = null
const listeners = new Set<() => void>()

function setLive(value: boolean) {
  if (live === value) return
  live = value
  for (const listener of listeners) listener()
}

function markEvent() {
  lastEventAt = Date.now()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** True while the event stream is open; the queries poll while it is not. */
export const useLive = (): boolean => useSyncExternalStore(subscribe, () => live)

/** When the stream last delivered a frame (its greeting or a change), as epoch ms; null before the first. */
export const useLastEventAt = (): number | null => useSyncExternalStore(subscribe, () => lastEventAt)

/**
 * Keeps one `EventSource` on the change stream: the changes that arrive inside the debounce window invalidate, once, the
 * queries they can alter (`affected`): the lists after a short pause, the aggregates after a longer one. The first
 * `hello` of the page joins the boot's requests instead of cancelling them. A drop reconnects
 * with backoff, and on `online` and when the tab shows again. It resumes from the last cursor; a connection that fails
 * before its first frame drops the cursor, which is how a 410 `cursor_gone` (invisible to `EventSource`) starts over.
 * The keepalive is an SSE comment `EventSource` cannot see, so a half-open socket looks open: a watchdog replaces the
 * connection after a sleep of the machine, or after the tab was hidden for a while without a single frame.
 * Returns the function that stops it.
 */
export function startLive(queryClient: QueryClient): () => void {
  let arrived: (Change | null)[] = []
  let arrivedForAggregates: (Change | null)[] = []
  const flush = (aggregates: boolean) => {
    const changes = aggregates ? arrivedForAggregates : arrived
    if (aggregates) arrivedForAggregates = []
    else arrived = []
    const alters = affectedByAny(changes)
    void queryClient.invalidateQueries({
      predicate: ({ queryKey }) => isAggregate(queryKey) === aggregates && alters(queryKey),
    })
  }
  const invalidate = trailingDebounce(() => flush(false), INVALIDATE_DEBOUNCE_MS, undefined, INVALIDATE_MAX_WAIT_MS)
  const invalidateAggregates = trailingDebounce(
    () => flush(true),
    AGGREGATE_DEBOUNCE_MS,
    undefined,
    AGGREGATE_MAX_WAIT_MS,
  )
  const note = (change: Change | null) => {
    arrived.push(change)
    arrivedForAggregates.push(change)
    invalidate.call()
    invalidateAggregates.call()
  }
  let firstHello = true
  let source: EventSource | null = null
  let cursor: string | undefined
  let greeted = false
  let delay: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastFrameAt = Date.now()
  let hiddenAt: number | null = null

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
      lastFrameAt = Date.now()
      markEvent()
      checkForUpdate()
      delay = undefined
      cursor = event.lastEventId || cursor
      setLive(true)
      markRecovered()
      if (firstHello) {
        firstHello = false
        void queryClient.invalidateQueries(undefined, { cancelRefetch: false })
        return
      }
      // after a drop (a restart): every query refetches, those in error state too; `invalidateQueries` does not skip them
      note(null)
    })
    for (const kind of CHANGE_KINDS) {
      es.addEventListener(kind, (event) => {
        lastFrameAt = Date.now()
        cursor = event.lastEventId || cursor
        markEvent()
        note(parseChange(event.data))
      })
    }
    es.onerror = () => {
      // A dropped stream is a restart only if the server does not answer either: the probe's network error marks it, an answer clears it.
      if (greeted) void fetchMachine().catch(() => undefined)
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
  const replaceNow = () => {
    source?.close()
    reconnectNow()
  }
  const onVisible = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      return
    }
    const silent = silentWhileHidden(hiddenAt, lastFrameAt, Date.now())
    hiddenAt = null
    if (silent) replaceNow()
    else reconnectNow()
  }
  let lastTick = Date.now()
  const watchdog = setInterval(() => {
    const now = Date.now()
    const slept = sleptBetween(lastTick, now)
    lastTick = now
    // a hidden tab's timers are throttled to about a minute: that gap is not a sleep, and `onVisible` covers the return
    if (slept && live && document.visibilityState === 'visible') replaceNow()
  }, WATCHDOG_TICK_MS)

  open()
  window.addEventListener('online', reconnectNow)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    window.removeEventListener('online', reconnectNow)
    document.removeEventListener('visibilitychange', onVisible)
    clearTimeout(timer)
    clearInterval(watchdog)
    invalidate.cancel()
    invalidateAggregates.cancel()
    close()
  }
}
