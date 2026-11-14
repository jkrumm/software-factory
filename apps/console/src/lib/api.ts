import {
  ArtifactDetail,
  CapacityLoopModel,
  ArtifactList,
  ArtifactReply,
  ChainModel,
  DecisionReply,
  DecisionView,
  ErrandList,
  DeskPushReply,
  ErrandApproveReply,
  ErrandReply,
  ErrorBody,
  FlowModel,
  FindingClassesModel,
  FixCommitsModel,
  FrictionModel,
  HostHistoryModel,
  ProjectDigestsModel,
  KpiModel,
  MachineModel,
  NeedsModel,
  ReadAccountList,
  ReadIssueCards,
  ReadIssueDetail,
  SignalAck,
  SignalDismissed,
  SinceModel,
  ThroughputModel,
  VerdictView,
} from '@software-factory/contract'
import type { VERDICT_WORDS } from './artifact.ts'
import { isNetworkError, markFailing, markRecovered } from './restart.ts'

let newerServer: (() => void) | undefined

/** What happens when an answer carries fields this bundle does not know: the app asks for the new bundle (`queries.ts`). */
export function onNewerServer(handler: () => void): void {
  newerServer = handler
}

/** A non-2xx answer of the API. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    /** what the API said about it (`ErrorBody.error`), when it said anything */
    readonly detail: string | null = null,
  ) {
    super(`${path} answered ${status}`)
    this.name = 'ApiError'
  }
}

/** An answer that does not match the schema this bundle was built with: usually the server was deployed after this page loaded. */
export class ShapeError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path} does not match the contract: ${detail}`)
    this.name = 'ShapeError'
  }
}

interface Schema<T> {
  parse(data: unknown): T
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: readonly { code: string }[] } }
}

/**
 * The answer as the schema reads it. A server newer than this bundle usually only adds a field (the contract's objects are
 * strict, so zod refuses it): an answer whose every issue is an unrecognised key is still this bundle's shape, the
 * screens read the fields they know, and `onNewer` asks for the new bundle in the background. Anything else (a missing or
 * retyped field) is a `ShapeError`.
 */
export function parseShape<T>(path: string, schema: Schema<T>, data: unknown, onNewer?: () => void): T {
  const result = schema.safeParse(data)
  if (result.success) return result.data
  if (result.error.issues.every((issue) => issue.code === 'unrecognized_keys')) {
    onNewer?.()
    return data as T
  }
  throw new ShapeError(path, JSON.stringify(result.error.issues))
}

/** True while a screen has no data because the bundle is older than the server: the new bundle is on its way, the screen shows its skeleton. */
export const awaitsUpdate = (error: Error | null): boolean => error instanceof ShapeError

/** What a page without data says while the server restarts: its skeleton is up and the retries bring the data. */
export const RESTART_NOTE = 'The server is restarting. This page reloads by itself'

/** What a page says in place of its data when the query has none and nothing is coming (`useScreen` says `failed`): for a `ShapeError` only after the new bundle did not arrive in time. */
export function failureNote(error: Error | null, restarting = false): string {
  if (restarting && (!error || isNetworkError(error))) return RESTART_NOTE
  if (error instanceof ShapeError) return 'This Console is older than the server. Reload the page to update it'
  if (error instanceof ApiError) return `The server answered ${error.status}`
  if (error) return 'The server cannot be reached'
  return 'No data yet'
}

/** `fetch` that tells the restart state whether the server answered at all (an HTTP status, even an error, is an answer). */
async function fetchOrMark(path: string, init: RequestInit): Promise<Response> {
  try {
    const response = await fetch(path, init)
    markRecovered()
    return response
  } catch (error) {
    if (isNetworkError(error)) markFailing()
    throw error
  }
}

/** Same-origin GET of a `/v1` path, parsed with the contract's schema: the server's listener adds the credential. */
async function getJson<T>(path: string, schema: Schema<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetchOrMark(path, { signal, cache: 'no-store', headers: { accept: 'application/json' } })
  if (!response.ok) throw new ApiError(response.status, path)
  return parseShape(path, schema, await response.json(), () => newerServer?.())
}

export const fetchNeeds = (signal?: AbortSignal) => getJson('/v1/needs', NeedsModel, signal)
/** What happened since the owner's last visit. The owner's read moves the visit marker: only the Needs-you screen calls it. */
export const fetchSince = (signal?: AbortSignal) => getJson('/v1/since', SinceModel, signal)
export const fetchChain = (signal?: AbortSignal) => getJson('/v1/chain', ChainModel, signal)
export const fetchProjectDigests = (signal?: AbortSignal) =>
  getJson('/v1/projects/digests', ProjectDigestsModel, signal)
export const fetchFlow = (signal?: AbortSignal) => getJson('/v1/flow', FlowModel, signal)
export const fetchKpis = (days: number, signal?: AbortSignal) => getJson(`/v1/kpis?days=${days}`, KpiModel, signal)
export const fetchCapacityLoop = (days: number, signal?: AbortSignal) =>
  getJson(`/v1/capacity-loop?days=${days}`, CapacityLoopModel, signal)
/** Where the host's memory and CPU and the leads' hours went over the last `hours` hours. */
export const fetchThroughput = (hours: number, signal?: AbortSignal) =>
  getJson(`/v1/throughput?hours=${hours}`, ThroughputModel, signal)
export const fetchFriction = (days: number, signal?: AbortSignal) =>
  getJson(`/v1/friction?days=${days}`, FrictionModel, signal)
export const fetchFindingClasses = (signal?: AbortSignal) => getJson('/v1/finding-classes', FindingClassesModel, signal)
export const fetchFixCommits = (signal?: AbortSignal) => getJson('/v1/fix-commits', FixCommitsModel, signal)
export const fetchAccounts = (signal?: AbortSignal) => getJson('/v1/accounts', ReadAccountList, signal)
export const fetchMachine = (signal?: AbortSignal) => getJson('/v1/machine', MachineModel, signal)
/** The host over the last 24 hours, its busiest processes, and the server's version and start time. */
export const fetchHost = (signal?: AbortSignal) => getJson('/v1/host', HostHistoryModel, signal)
/** Issue cards, newest activity first: every one, open and closed, for the command palette (`all`, 550 KB at 500 Issues); only the open ones (a twentieth of that) for a title lookup. */
export const fetchIssueCards = (signal?: AbortSignal, scope: 'all' | 'open' = 'all') =>
  getJson(`/v1/issues?state=${scope}&limit=500`, ReadIssueCards, signal)
/** The artifacts, newest first: what the command palette searches. */
export const fetchArtifacts = (signal?: AbortSignal) => getJson('/v1/artifacts?limit=200', ArtifactList, signal)

/** Same-origin write (POST, PATCH, DELETE) of an optional JSON body to one of the answer verbs the listener forwards; a refusal throws with the API's own words. */
async function sendJson<T>(method: string, path: string, body: unknown, schema: Schema<T>): Promise<T> {
  const response = await fetchOrMark(path, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const refusal = ErrorBody.safeParse(await response.json().catch(() => null))
    throw new ApiError(response.status, path, refusal.success ? refusal.data.error : null)
  }
  return schema.parse(await response.json())
}

const postJson = <T>(path: string, body: unknown, schema: Schema<T>) => sendJson('POST', path, body, schema)

export const fetchDecision = (id: string, signal?: AbortSignal) =>
  getJson(`/v1/decisions/${encodeURIComponent(id)}`, DecisionView, signal)
/** One artifact revision (the latest when none is named) with its annotations and verdicts. */
export const fetchArtifact = (id: string, revision?: number, signal?: AbortSignal) =>
  getJson(
    `/v1/artifacts/${encodeURIComponent(id)}${revision === undefined ? '' : `?revision=${revision}`}`,
    ArtifactDetail,
    signal,
  )
/** One Issue with its history, by number (`12`); a 404 is an `ApiError`. */
export const fetchIssue = (id: string, signal?: AbortSignal) =>
  getJson(`/v1/issues/${encodeURIComponent(id)}`, ReadIssueDetail, signal)
export const fetchErrands = (signal?: AbortSignal) => getJson('/v1/errands', ErrandList, signal)

export const answerDecision = (id: string, answer: string) =>
  postJson(`/v1/decisions/${encodeURIComponent(id)}/answer`, { answer }, DecisionReply)
export const giveVerdict = (id: string, verdict: string, note: string) =>
  postJson(`/v1/artifacts/${encodeURIComponent(id)}/verdict`, { verdict, ...(note ? { note } : {}) }, ArtifactReply)
export const annotateArtifact = (id: string, quote: string, comment: string) =>
  postJson(`/v1/artifacts/${encodeURIComponent(id)}/annotations`, { quote, comment, author: 'owner' }, ArtifactReply)
export const finishErrand = (id: string, note: string, outcome: 'done' | 'not_needed' = 'done') =>
  postJson(
    `/v1/errands/${encodeURIComponent(id)}/done`,
    { ...(note ? { note } : {}), ...(outcome === 'not_needed' ? { outcome } : {}) },
    ErrandReply,
  )
/** The owner's Approve on an `approval` Errand: the server runs its command on the mini; what it came to lands on the Errand. */
export const approveErrand = (id: string) =>
  postJson(`/v1/errands/${encodeURIComponent(id)}/approve`, {}, ErrandApproveReply)
/** The button "Push what waits to my MacBook": the desk pass now, as on his return. */
export const pushDesk = () => postJson('/v1/desk/push', {}, DeskPushReply)
export const turnBackErrand = (id: string, note: string) =>
  postJson(`/v1/errands/${encodeURIComponent(id)}/turn-back`, { note }, ErrandReply)
export const promoteSignal = (id: string, repo: string | null) =>
  postJson(`/signals/${encodeURIComponent(id)}/promote`, repo ? { repo } : {}, SignalAck)

export const dismissSignal = (id: string, reason: string) =>
  postJson(`/signals/${encodeURIComponent(id)}/dismiss`, { reason }, SignalDismissed)

/** The artifact page's own writes: an annotation on the revision shown, with its heading path, and the verdict on it. */
export const postAnnotation = (id: string, body: { revision: number; quote: string; path?: string; comment: string }) =>
  postJson(`/v1/artifacts/${encodeURIComponent(id)}/annotations`, { ...body, author: 'owner' }, ArtifactReply)

export const postVerdict = (
  id: string,
  body: { verdict: keyof typeof VERDICT_WORDS; note?: string; revision: number },
) => postJson(`/v1/artifacts/${encodeURIComponent(id)}/verdict`, body, ArtifactReply)

/** The owner's mark of whether a verdict needed them; it answers with the verdict. */
export const postNeeded = (id: string, body: { needed: boolean; revision?: number }) =>
  postJson(`/v1/artifacts/${encodeURIComponent(id)}/needed`, body, VerdictView)

/** The owner's edit of an annotation's comment, and its removal: both answer with the artifact like a new annotation. */
export const patchAnnotation = (id: string, annotationId: string, comment: string) =>
  sendJson(
    'PATCH',
    `/v1/artifacts/${encodeURIComponent(id)}/annotations/${encodeURIComponent(annotationId)}`,
    { comment },
    ArtifactReply,
  )

export const deleteAnnotation = (id: string, annotationId: string) =>
  sendJson(
    'DELETE',
    `/v1/artifacts/${encodeURIComponent(id)}/annotations/${encodeURIComponent(annotationId)}`,
    undefined,
    ArtifactReply,
  )
