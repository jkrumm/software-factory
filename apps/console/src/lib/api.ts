import {
  ArtifactDetail,
  ArtifactReply,
  ChangeList,
  DecisionReply,
  DecisionView,
  ErrandList,
  ErrandReply,
  ErrorBody,
  FlowModel,
  NeedsModel,
  SignalAck,
} from '@software-factory/contract'

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
export async function getJson<T>(path: string, schema: Schema<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) throw new ApiError(response.status, path)
  return schema.parse(await response.json())
}

export const fetchNeeds = (signal?: AbortSignal) => getJson('/v1/needs', NeedsModel, signal)
export const fetchFlow = (signal?: AbortSignal) => getJson('/v1/flow', FlowModel, signal)
export const fetchChanges = (since?: string, signal?: AbortSignal) =>
  getJson(since ? `/v1/changes?since=${encodeURIComponent(since)}` : '/v1/changes', ChangeList, signal)

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
export const fetchArtifact = (id: string, signal?: AbortSignal) =>
  getJson(`/v1/artifacts/${encodeURIComponent(id)}`, ArtifactDetail, signal)
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
