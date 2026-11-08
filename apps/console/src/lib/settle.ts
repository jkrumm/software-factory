import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiError } from './api.ts'
import { useConnection } from './connection.ts'
import { errorWords } from './needs.ts'

/**
 * One write on an item. It refreshes the list and the item's detail whether it worked or the API said it was settled
 * already (409, which also calls `onConflict`: the card is about to leave), and turns a refusal into the words the card shows. `disabled` is true while it is sent and while the
 * connection chip says Offline.
 */
export function useSettle<V>(options: {
  send: (value: V) => Promise<unknown>
  keys: string[][]
  onSent?: () => void
  onConflict?: () => void
}) {
  const client = useQueryClient()
  const connection = useConnection()
  const refresh = () => Promise.all(options.keys.map((queryKey) => client.invalidateQueries({ queryKey })))
  const mutation = useMutation({
    mutationFn: options.send,
    onSuccess: async () => {
      await refresh()
      options.onSent?.()
    },
    onError: (error) => {
      if (!(error instanceof ApiError) || error.status !== 409) return
      void refresh()
      options.onConflict?.()
    },
  })
  const error = mutation.error
  const words = !error
    ? null
    : error instanceof ApiError
      ? errorWords(error.status, error.detail)
      : errorWords(error instanceof TypeError ? null : 0, null)
  return {
    send: mutation.mutate,
    pending: mutation.isPending,
    disabled: mutation.isPending || connection.offline,
    error: words,
    reset: mutation.reset,
  }
}
