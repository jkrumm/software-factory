import { ChangeList, FlowModel, NeedsModel } from '@software-factory/contract'

/** A non-2xx answer of the API. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
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
