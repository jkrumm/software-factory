import { QueryClient, useQuery } from '@tanstack/react-query'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { fetchArtifact, fetchDecision, fetchErrands, fetchFlow, fetchNeeds } from './api.ts'
import { useLive } from './live.ts'

const DAY_MS = 24 * 60 * 60 * 1000
export const SNAPSHOT_MAX_AGE_MS = 7 * DAY_MS
export const POLL_MS = 15_000

/** gcTime is not below the snapshot's maxAge: a persisted query must outlive the page to be restored. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, gcTime: SNAPSHOT_MAX_AGE_MS, retry: 1 } },
})

export const persister = createSyncStoragePersister({ storage: window.localStorage, key: 'console-snapshot' })

/** The options of the two first-screen queries, shared by the hooks and by the prefetch at boot. */
export const needsQuery = { queryKey: ['needs'], queryFn: ({ signal }: { signal: AbortSignal }) => fetchNeeds(signal) }
export const flowQuery = { queryKey: ['flow'], queryFn: ({ signal }: { signal: AbortSignal }) => fetchFlow(signal) }

/** The queries poll while the stream is not open. */
export function useNeeds() {
  const live = useLive()
  return useQuery({ ...needsQuery, refetchInterval: live ? false : POLL_MS })
}

export function useFlow() {
  const live = useLive()
  return useQuery({ ...flowQuery, refetchInterval: live ? false : POLL_MS })
}

/** The detail of one item that waits: the same invalidation as the lists, so an answer elsewhere shows at once. */
export function useDecision(id: string) {
  return useQuery({ queryKey: ['decision', id], queryFn: ({ signal }) => fetchDecision(id, signal) })
}

export function useErrands() {
  return useQuery({ queryKey: ['errands'], queryFn: ({ signal }) => fetchErrands(signal) })
}

/** One artifact revision (the latest when `revision` is undefined); polls while the stream is not open. */
export function useArtifact(id: string, revision?: number, enabled = true) {
  const live = useLive()
  return useQuery({
    queryKey: ['artifact', id, revision ?? 'latest'],
    enabled,
    queryFn: ({ signal }) => fetchArtifact(id, revision, signal),
    refetchInterval: live ? false : POLL_MS,
  })
}
