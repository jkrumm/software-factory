import { QueryClient, useQuery } from '@tanstack/react-query'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import {
  ApiError,
  fetchAccounts,
  fetchArtifact,
  fetchChain,
  fetchDecision,
  fetchErrands,
  fetchFlow,
  fetchFindingClasses,
  fetchFixCommits,
  fetchFriction,
  fetchIssue,
  fetchKpis,
  fetchMachine,
  fetchNeeds,
} from './api.ts'
import { useLive } from './live.ts'

const DAY_MS = 24 * 60 * 60 * 1000
export const SNAPSHOT_MAX_AGE_MS = 7 * DAY_MS
const POLL_MS = 15_000

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

/** The dependency chain across projects. */
export function useChain() {
  const live = useLive()
  return useQuery({
    queryKey: ['chain'],
    queryFn: ({ signal }) => fetchChain(signal),
    refetchInterval: live ? false : POLL_MS,
  })
}

/** The KPIs of the last `days` days. */
export function useKpis(days: number) {
  const live = useLive()
  return useQuery({
    queryKey: ['kpis', days],
    queryFn: ({ signal }) => fetchKpis(days, signal),
    refetchInterval: live ? false : POLL_MS,
  })
}

/** The friction counts of the last `days` days. */
export function useFriction(days: number) {
  const live = useLive()
  return useQuery({
    queryKey: ['friction', days],
    queryFn: ({ signal }) => fetchFriction(days, signal),
    refetchInterval: live ? false : POLL_MS,
  })
}

/** The finding classes the friction and hygiene loops file, held ones first. */
export function useFindingClasses() {
  const live = useLive()
  return useQuery({
    queryKey: ['finding-classes'],
    queryFn: ({ signal }) => fetchFindingClasses(signal),
    refetchInterval: live ? false : POLL_MS,
  })
}

/** Fix commits by class over the last four weeks. */
export function useFixCommits() {
  const live = useLive()
  return useQuery({
    queryKey: ['fix-commits'],
    queryFn: ({ signal }) => fetchFixCommits(signal),
    refetchInterval: live ? false : POLL_MS,
  })
}

/** Each account's newest reading: the weekly figure first, the 5-hour window where the account has one. A reading is not a change in the stream, so it polls whether or not the stream is open. */
export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: ({ signal }) => fetchAccounts(signal),
    refetchInterval: POLL_MS,
  })
}

/** The host's load and swap. A reading is not a change in the stream, so it polls whether or not the stream is open. */
export function useMachine() {
  return useQuery({
    queryKey: ['machine'],
    queryFn: ({ signal }) => fetchMachine(signal),
    refetchInterval: POLL_MS,
  })
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

/** One Issue's page; polls while the stream is not open. An unknown Issue (404) is not retried. */
export function useIssue(id: string) {
  const live = useLive()
  return useQuery({
    queryKey: ['issue', id],
    queryFn: ({ signal }) => fetchIssue(id, signal),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
    refetchInterval: live ? false : POLL_MS,
  })
}
