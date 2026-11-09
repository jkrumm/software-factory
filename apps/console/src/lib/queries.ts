import { QueryCache, QueryClient, useQuery } from '@tanstack/react-query'
import type { ChainModel } from '@software-factory/contract'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import {
  ApiError,
  ShapeError,
  fetchAccounts,
  fetchArtifact,
  fetchArtifacts,
  fetchChain,
  fetchDecision,
  fetchErrands,
  fetchFlow,
  fetchFindingClasses,
  fetchFixCommits,
  fetchFriction,
  fetchHost,
  fetchIssue,
  fetchIssueCards,
  fetchKpis,
  fetchMachine,
  fetchNeeds,
  fetchSince,
} from './api.ts'
import { useLive } from './live.ts'
import { pollEvery } from './policy.ts'
import { checkForUpdate } from './update.ts'

const DAY_MS = 24 * 60 * 60 * 1000
export const SNAPSHOT_MAX_AGE_MS = 7 * DAY_MS

/** gcTime is not below the snapshot's maxAge: a persisted query must outlive the page to be restored. */
export const queryClient = new QueryClient({
  // a shape mismatch is the server being newer than this bundle: look for the new bundle now instead of retrying
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ShapeError) checkForUpdate()
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      gcTime: SNAPSHOT_MAX_AGE_MS,
      retry: (count, error) => !(error instanceof ShapeError) && count < 1,
    },
  },
})

export const persister = createSyncStoragePersister({ storage: window.localStorage, key: 'console-snapshot' })

/**
 * The "Since you were here" band. Reading it moves the server's visit marker, so only the Needs-you screen mounts this.
 * It does not poll (a tab left open would keep the visit alive for ever): the stream's changes and a focus refetch it.
 * A refetch inside the visit returns the same band. Never persisted (`SNAPSHOT_EXCLUDED` in `main.tsx`).
 */
export function useSince() {
  return useQuery({
    queryKey: ['since'],
    queryFn: ({ signal }) => fetchSince(signal),
    refetchOnWindowFocus: true,
  })
}

/** The options of the two first-screen queries, shared by the hooks and by the prefetch at boot. */
export const needsQuery = { queryKey: ['needs'], queryFn: ({ signal }: { signal: AbortSignal }) => fetchNeeds(signal) }
export const flowQuery = { queryKey: ['flow'], queryFn: ({ signal }: { signal: AbortSignal }) => fetchFlow(signal) }

/** A query polls every 15 s while the stream is not open, and once a minute as a safety while it is. */
export function useNeeds() {
  const live = useLive()
  return useQuery({ ...needsQuery, refetchInterval: pollEvery(live) })
}

export function useFlow() {
  const live = useLive()
  return useQuery({ ...flowQuery, refetchInterval: pollEvery(live) })
}

/** The answer's own timestamp changes on every request; the graph is rebuilt only when what it draws changes. */
const withoutStamp = ({ at: _at, ...model }: ChainModel) => model

/** The dependency chain across projects. */
export function useChain() {
  const live = useLive()
  return useQuery({
    queryKey: ['chain'],
    queryFn: ({ signal }) => fetchChain(signal),
    select: withoutStamp,
    refetchInterval: pollEvery(live),
  })
}

/** The KPIs of the last `days` days. */
export function useKpis(days: number) {
  const live = useLive()
  return useQuery({
    queryKey: ['kpis', days],
    queryFn: ({ signal }) => fetchKpis(days, signal),
    refetchInterval: pollEvery(live),
  })
}

/** The friction counts of the last `days` days. */
export function useFriction(days: number) {
  const live = useLive()
  return useQuery({
    queryKey: ['friction', days],
    queryFn: ({ signal }) => fetchFriction(days, signal),
    refetchInterval: pollEvery(live),
  })
}

/** The finding classes the friction and hygiene loops file, held ones first. */
export function useFindingClasses() {
  const live = useLive()
  return useQuery({
    queryKey: ['finding-classes'],
    queryFn: ({ signal }) => fetchFindingClasses(signal),
    refetchInterval: pollEvery(live),
  })
}

/** Fix commits by class over the last four weeks. */
export function useFixCommits() {
  const live = useLive()
  return useQuery({
    queryKey: ['fix-commits'],
    queryFn: ({ signal }) => fetchFixCommits(signal),
    refetchInterval: pollEvery(live),
  })
}

/** Each account's newest reading: the weekly figure first, the 5-hour window where the account has one. A reading is not a change in the stream, so it polls whether or not the stream is open. */
export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: ({ signal }) => fetchAccounts(signal),
    refetchInterval: pollEvery(false),
  })
}

/** The host's load and swap. A reading is not a change in the stream, so it polls whether or not the stream is open. */
export function useMachine() {
  return useQuery({
    queryKey: ['machine'],
    queryFn: ({ signal }) => fetchMachine(signal),
    refetchInterval: pollEvery(false),
  })
}

/** The host's last 24 hours and busiest processes. Polls every 30 s; a server without the route (404) just has no history. */
export function useHost() {
  return useQuery({
    queryKey: ['host'],
    queryFn: ({ signal }) => fetchHost(signal),
    refetchInterval: 30_000,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
  })
}

/**
 * What the command palette searches. It loads when the palette first opens (`enabled`) and refetches each time it opens,
 * so the lists are as fresh as the stream's last invalidation.
 */
export function useIssueCards(enabled: boolean) {
  return useQuery({
    queryKey: ['issue-cards'],
    enabled,
    staleTime: 0,
    queryFn: ({ signal }) => fetchIssueCards(signal),
  })
}

export function usePaletteArtifacts(enabled: boolean) {
  return useQuery({
    queryKey: ['artifact-list'],
    enabled,
    staleTime: 0,
    queryFn: ({ signal }) => fetchArtifacts(signal),
  })
}

/** The detail of one item that waits: the same invalidation as the lists, so an answer elsewhere shows at once. */
export function useDecision(id: string) {
  const live = useLive()
  return useQuery({
    queryKey: ['decision', id],
    queryFn: ({ signal }) => fetchDecision(id, signal),
    refetchInterval: pollEvery(live),
  })
}

export function useErrands() {
  const live = useLive()
  return useQuery({
    queryKey: ['errands'],
    queryFn: ({ signal }) => fetchErrands(signal),
    refetchInterval: pollEvery(live),
  })
}

/** One artifact revision (the latest when `revision` is undefined); polls like the lists. */
export function useArtifact(id: string, revision?: number, enabled = true) {
  const live = useLive()
  return useQuery({
    queryKey: ['artifact', id, revision ?? 'latest'],
    enabled,
    queryFn: ({ signal }) => fetchArtifact(id, revision, signal),
    refetchInterval: pollEvery(live),
  })
}

/** One Issue's page; polls like the lists. An unknown Issue (404) is not retried. */
export function useIssue(id: string) {
  const live = useLive()
  return useQuery({
    queryKey: ['issue', id],
    queryFn: ({ signal }) => fetchIssue(id, signal),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
    refetchInterval: pollEvery(live),
  })
}
