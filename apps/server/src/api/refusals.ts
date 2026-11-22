import { Elysia } from 'elysia'
import type { Tokens } from '../settings.ts'
import { resolveCaller } from './auth.ts'
import type { Caller } from './policy.ts'

/** One refused request: where the caller went wrong, never what it sent. */
export interface ApiRefusal {
  at: Date
  /** the OpenAPI operation id (`issue.list`), or `unknown` for a path no route has */
  operation: string
  /** `none` when no token resolved */
  caller: Caller | 'none'
  status: number
  /** the names of the fields a validation refused; empty for any other status */
  fields: readonly string[]
}

/** Where a refusal goes. Fire and forget: it returns nothing, reports its own failure, and a throw is swallowed so counting never changes an answer. */
export type RefusalSink = (refusal: ApiRefusal) => void

/** The fields of a validation refusal, by request: `onError` knows them, `onAfterResponse` counts them. */
const named = new WeakMap<Request, readonly string[]>()

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const MAX_FIELDS = 8

/**
 * Remembers which fields a validation refused (the paths Elysia's issues carry). Only the first segment of a path, and only
 * when it looks like a property name, so an array index or a key a caller invented is never stored.
 */
export function noteFields(request: Request, paths: readonly string[]): void {
  const names = paths.map((path) => path.split('/')[0] ?? '').filter((name) => FIELD_NAME.test(name))
  named.set(request, [...new Set(names)].slice(0, MAX_FIELDS))
}

/**
 * Counts every 4xx the server answers, whichever way it came (a handler's own `Response`, a validation, the policy, an
 * unknown route). `operations` maps `<METHOD> <route>` to the operation id and is filled once the routes exist.
 */
export const refusalCounter = (options: {
  tokens: Tokens | undefined
  sink: RefusalSink
  operations: ReadonlyMap<string, string>
  now?: () => Date
}) =>
  new Elysia({ name: 'refusal-counter' }).onAfterResponse({ as: 'global' }, (context) => {
    const { request, response, set } = context
    const status = response instanceof Response ? response.status : Number(set.status ?? 200)
    if (status < 400 || status > 499) return
    const route: unknown = context.route
    const operation =
      typeof route === 'string' && route
        ? (options.operations.get(`${request.method} ${route}`) ?? `${request.method} ${route}`)
        : 'unknown'
    try {
      options.sink({
        at: (options.now ?? (() => new Date()))(),
        operation,
        caller: resolveCaller(options.tokens, request.headers.get('authorization')) ?? 'none',
        status,
        fields: status === 422 ? (named.get(request) ?? []) : [],
      })
    } catch {
      // counting never changes an answer
    }
  })
