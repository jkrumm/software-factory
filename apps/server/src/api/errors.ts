import { ErrorBody } from '@software-factory/contract'

/** The statuses a route adds to the always-declared 401, 403 and 500. */
export type ErrorStatus = 400 | 404 | 409 | 422 | 503

/**
 * The error bodies a route declares in its OpenAPI `response` map, so the CLI and the Console know every refusal is an
 * `ErrorBody`. 401, 403 (the auth plugin) and 500 are on every route; name the others the route can answer:
 * `...errorResponses(404, 409, 503)`.
 */
export function errorResponses<const Codes extends readonly ErrorStatus[]>(
  ...codes: Codes
): Record<401 | 403 | 500 | Codes[number], typeof ErrorBody> {
  const out: Partial<Record<number, typeof ErrorBody>> = { 401: ErrorBody, 403: ErrorBody, 500: ErrorBody }
  for (const code of codes) out[code] = ErrorBody
  return out as Record<401 | 403 | 500 | Codes[number], typeof ErrorBody>
}
