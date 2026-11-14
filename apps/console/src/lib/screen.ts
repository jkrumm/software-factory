import { useEffect, useState } from 'react'
import { awaitsUpdate, failureNote } from './api.ts'
import { useRestarting } from './connection.ts'
import { awaitUpdate } from './update.ts'

/** How long a screen shows its skeleton for a new bundle that does not come before it says so. */
export const UPDATE_STALL_MS = 20_000

export type Screen = 'ready' | 'loading' | 'failed'

/**
 * What a screen shows for its main query: its content once it has data, its skeleton while it loads (and while the
 * Console is older than the server and the new bundle is on its way: never a banner before content), and only when
 * nothing can come of waiting the failure's words.
 */
export function useScreen({
  data,
  isPending,
  error,
}: {
  data: unknown
  isPending: boolean
  error: Error | null
}): Screen {
  const waitingForUpdate = !data && awaitsUpdate(error)
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    if (!waitingForUpdate) {
      setStalled(false)
      return
    }
    awaitUpdate(true)
    const timer = setTimeout(() => {
      awaitUpdate(false)
      setStalled(true)
    }, UPDATE_STALL_MS)
    return () => {
      clearTimeout(timer)
      awaitUpdate(false)
    }
  }, [waitingForUpdate])
  if (data) return 'ready'
  if (isPending || (waitingForUpdate && !stalled)) return 'loading'
  return 'failed'
}

/** What a screen says under its title: the restart's note on the skeleton, the failure's words once it failed. */
export function useScreenNote(screen: Screen, error: Error | null): string | undefined {
  const restarting = useRestarting()
  if (screen === 'loading' && restarting) return failureNote(null, true)
  return screen === 'failed' ? failureNote(error, restarting) : undefined
}
