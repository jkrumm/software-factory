import {
  ArtifactDetail,
  ArtifactReply,
  ChainModel,
  DecisionReply,
  DecisionView,
  ErrandList,
  ErrandReply,
  ErrorBody,
  FlowModel,
  FrictionModel,
  KpiModel,
  MachineModel,
  NeedsModel,
  ReadAccountList,
  ReadIssueDetail,
  SignalAck,
  SignalDismissed,
} from '@software-factory/contract'
import type { VERDICT_WORDS } from './artifact.ts'

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

interface Schema<T> {
  parse(data: unknown): T
}

/** Same-origin GET of a `/v1` path, parsed with the contract's schema: the server's listener adds the credential. */
async function getJson<T>(path: string, schema: Schema<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) throw new ApiError(response.status, path)
  return schema.parse(await response.json())
}

export const fetchNeeds = (signal?: AbortSignal) => getJson('/v1/needs', NeedsModel, signal)
export const fetchChain = (signal?: AbortSignal) => getJson('/v1/chain', ChainModel, signal)
export const fetchFlow = (signal?: AbortSignal) => getJson('/v1/flow', FlowModel, signal)
export const fetchKpis = (days: number, signal?: AbortSignal) => getJson(`/v1/kpis?days=${days}`, KpiModel, signal)
export const fetchFriction = (days: number, signal?: AbortSignal) =>
  getJson(`/v1/friction?days=${days}`, FrictionModel, signal)
export const fetchAccounts = (signal?: AbortSignal) => getJson('/v1/accounts', ReadAccountList, signal)
export const fetchMachine = (signal?: AbortSignal) => getJson('/v1/machine', MachineModel, signal)

/** Same-origin POST of a JSON body to one of the answer verbs the listener forwards; a refusal throws with the API's own words. */
async function postJson<T>(path: string, body: unknown, schema: Schema<T>): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const refusal = ErrorBody.safeParse(await response.json().catch(() => null))
    throw new ApiError(response.status, path, refusal.success ? refusal.data.error : null)
  }
  return schema.parse(await response.json())
}

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
export const finishErrand = (id: string, note: string) =>
  postJson(`/v1/errands/${encodeURIComponent(id)}/done`, note ? { note } : {}, ErrandReply)
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
