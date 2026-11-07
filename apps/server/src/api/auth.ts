import { createHash, timingSafeEqual } from 'node:crypto'
import { ErrorBody } from '@software-factory/contract'
import { Elysia } from 'elysia'
import type { Tokens } from '../settings.ts'
import { type Caller, CALLERS, ruleFor } from './policy.ts'

/** A request the policy refuses; `onError` in `app.ts` answers it as an `ErrorBody`. */
export class Refusal extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly body: ErrorBody,
  ) {
    super(body.error)
    this.name = 'Refusal'
  }
}

const refusal = (status: 401 | 403, error: string, code: string): Refusal =>
  new Refusal(status, ErrorBody.parse({ error, code }))

const digest = (text: string): Buffer => createHash('sha256').update(text).digest()

const BEARER = /^Bearer (.+)$/i

/**
 * The caller of a request, by its bearer token. Both sides are hashed first, so the comparison takes the same time for
 * any two tokens, and every configured token is compared, so nothing shows which caller a near miss was close to.
 */
export function resolveCaller(tokens: Tokens | undefined, header: string | null): Caller | null {
  const presented = header ? BEARER.exec(header)?.[1] : undefined
  if (!tokens || !presented) return null
  const wanted = digest(presented)
  let found: Caller | null = null
  for (const caller of CALLERS) {
    const token = tokens[caller]
    if (token !== undefined && timingSafeEqual(digest(token), wanted)) found = caller
  }
  return found
}

const resolved = new WeakMap<Request, Caller>()

/** The caller `auth` let through; only for a handler on a route that is not public. */
export function callerOf(request: Request): Caller {
  const caller = resolved.get(request)
  if (!caller) throw new Error('no caller was resolved for this request: the route is outside the auth plugin')
  return caller
}

/**
 * Authenticates every route registered after it, before the body is read: resolves the caller from the bearer token and
 * checks it against the policy table (`policy.ts`). A route without a row is a 403 for everyone. Routes registered
 * before it (the OpenAPI document, when it is served) stay public.
 */
export const auth = (tokens: Tokens | undefined) =>
  new Elysia({ name: 'auth' }).derive({ as: 'global' }, ({ request, route }) => {
    const rule = ruleFor(request.method, route)
    if (!rule) throw refusal(403, `no caller may use ${request.method} ${route}`, 'forbidden')
    if (rule.callers === 'public') return {}
    const caller = resolveCaller(tokens, request.headers.get('authorization'))
    if (!caller) throw refusal(401, 'a bearer token is required: set FACTORY_TOKEN', 'unauthorized')
    if (!rule.callers.includes(caller)) {
      throw refusal(403, `the ${caller} token may not use ${request.method} ${route}`, 'forbidden')
    }
    resolved.set(request, caller)
    return {}
  })
