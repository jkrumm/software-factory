/**
 * Who may call which route: the one table `auth.ts` checks every request against.
 *
 * **Tokens.** A caller is resolved from `Authorization: Bearer <token>` and nothing else. `FACTORY_TOKEN` is the owner's
 * and is required; `FACTORY_AGENT_TOKEN` (a lead's session), `FACTORY_DOOR_TOKEN` (the alert door) and
 * `FACTORY_READ_TOKEN` are optional, and a caller whose token is not set does not exist. Every token is at least 16
 * characters and all are different (`settings.ts`). A token is compared in constant time. The hook socket is not here:
 * its mode (0600) is its credential.
 *
 * **Fail closed.** A route with no entry is 403 `forbidden` for everyone, so a new route stays shut until it has a row
 * below. No token, or an unknown one, is 401 `unauthorized`; a known caller the row does not list is 403 `forbidden`.
 * The first row that matches wins, so a narrower row goes before a wider one.
 *
 * **The classes** (the owner is on every row but `public`):
 * - public: `GET /health`, the only route without a token.
 * - read: `GET /v1/*`, for owner, agent and read, except `GET /v1/errands` (the owner's hands) and a lead's own session read
 *   (`GET /v1/issues/:id/lead`), which are placed before it. A GET outside `/v1` is the owner's.
 * - lead verbs: what a lead session calls on its own Issue (owner and agent): the `POST /v1/issues/:id/*` verbs, `ship`,
 *   `quality`, a revision, its own session read, a note to a session, the signal it files and the test slots it takes.
 * - owner only: everything else, and every route nobody has listed yet (new, cancel, note, answer, prio, reopen, verdicts, projects, queue,
 *   capacity, loops, the door's registry, the scenarios' test routes). When in doubt, the owner alone.
 * - machine: exactly `POST /signals/alerts` and `POST /door/reports`, the door's two calls (the owner may make them too).
 *
 * Adding a route: add its row here, in the class it belongs to. `test/policy.test.ts` walks the OpenAPI document and
 * fails on a route without a row.
 */
export const CALLERS = ['owner', 'agent', 'machine', 'read'] as const
export type Caller = (typeof CALLERS)[number]

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface Rule {
  method: Method
  /** Elysia's route string (`/v1/issues/:id/close`); a trailing `/*` matches everything under that prefix */
  route: string
  /** who may call it; `public` needs no token */
  callers: readonly Caller[] | 'public'
}

const OWNER: readonly Caller[] = ['owner']
const LEAD: readonly Caller[] = ['owner', 'agent']
const READ: readonly Caller[] = ['owner', 'agent', 'read']
const DOOR: readonly Caller[] = ['owner', 'machine']

const rule = (method: Method, route: string, callers: Rule['callers']): Rule => ({ method, route, callers })

export const POLICY: readonly Rule[] = [
  // -- public ----------------------------------------------------------------------------------------------------------
  rule('GET', '/health', 'public'),

  // -- machine: the door's two calls ---------------------------------------------------------------------------------
  rule('POST', '/signals/alerts', DOOR),
  rule('POST', '/door/reports', DOOR),

  // -- lead verbs ----------------------------------------------------------------------------------------------------
  rule('POST', '/v1/issues/:id/close', LEAD),
  rule('POST', '/v1/issues/:id/defer', LEAD),
  rule('POST', '/v1/issues/:id/block', LEAD),
  rule('POST', '/v1/issues/:id/ask', LEAD),
  rule('POST', '/v1/issues/:id/artifacts', LEAD),
  rule('POST', '/v1/issues/:id/errands', LEAD),
  rule('POST', '/v1/artifacts/:id/revisions', LEAD),
  rule('POST', '/v1/sessions/:session/note', LEAD),
  rule('POST', '/issues/:id/ship', LEAD),
  rule('GET', '/issues/:id/quality', LEAD),
  rule('GET', '/v1/issues/:id/lead', LEAD),
  rule('POST', '/signals', LEAD),
  rule('PUT', '/slots/:id', LEAD),
  rule('DELETE', '/slots/:id', LEAD),

  // -- owner only, inside /v1 where a wider row would let a reader in ------------------------------------------------
  rule('GET', '/v1/errands', OWNER),

  // -- read ----------------------------------------------------------------------------------------------------------
  rule('GET', '/v1/*', READ),

  // -- owner only: everything else that exists today -----------------------------------------------------------------
  rule('POST', '/issues', OWNER),
  rule('POST', '/issues/:id/reopen', OWNER),
  rule('POST', '/issues/:id/cancel', OWNER),
  rule('POST', '/issues/:id/note', OWNER),
  rule('POST', '/issues/:id/answer', OWNER),
  rule('POST', '/issues/:id/prio', OWNER),
  rule('POST', '/v1/decisions/:id/answer', OWNER),
  rule('POST', '/v1/decisions/:id/worth-asking', OWNER),
  rule('POST', '/v1/artifacts/:id/annotations', OWNER),
  rule('POST', '/v1/artifacts/:id/verdict', OWNER),
  rule('POST', '/v1/errands/:id/done', OWNER),
  rule('POST', '/v1/checkpoints/pass', OWNER),
  rule('POST', '/v1/loops/:name/run', OWNER),
  rule('POST', '/signals/:id/promote', OWNER),
  rule('GET', '/door/routes', OWNER),
  rule('POST', '/door/routes', OWNER),
  rule('POST', '/door/routes/remove', OWNER),
  rule('GET', '/projects', OWNER),
  rule('GET', '/projects/:name', OWNER),
  rule('POST', '/projects/sync', OWNER),
  rule('POST', '/planning/pass', OWNER),
  rule('POST', '/planning/settle', OWNER),
  rule('POST', '/planning/after', OWNER),
  rule('GET', '/capacity', OWNER),
  rule('POST', '/capacity/refresh', OWNER),
  rule('POST', '/capacity/admit', OWNER),
  rule('GET', '/queue/order', OWNER),
  rule('GET', '/queue', OWNER),
  rule('PUT', '/queue', OWNER),
  // the scenarios' routes (mounted only with FACTORY_INTERNAL_TEST_ROUTES=1)
  rule('POST', '/internal/test/issues', OWNER),
  rule('POST', '/internal/test/issues/:id/events', OWNER),
  rule('POST', '/internal/test/tick', OWNER),
]

/** `/x/` and `/x` are one route (a group's `/` route carries the prefix's trailing slash). */
const bare = (route: string): string => (route.length > 1 ? route.replace(/\/$/, '') : route)

const matches = (rule: Rule, method: string, route: string): boolean => {
  if (rule.method !== method) return false
  route = bare(route)
  if (rule.route.endsWith('/*')) return route.startsWith(rule.route.slice(0, -1))
  return rule.route === route
}

/** The row for a request, or nothing: a route without a row is refused. */
export const ruleFor = (method: string, route: string): Rule | undefined =>
  POLICY.find((candidate) => matches(candidate, method, route))
