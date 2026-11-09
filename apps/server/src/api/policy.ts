/**
 * Who may call which route: the one table `auth.ts` checks every request against.
 *
 * **Tokens.** A caller is resolved from `Authorization: Bearer <token>` and nothing else. `FACTORY_TOKEN` is the owner's
 * and is required; `FACTORY_AGENT_TOKEN` (a lead's session), `FACTORY_DOOR_TOKEN` (the alert door),
 * `FACTORY_SIGNAL_TOKEN` (Hermes' filing), `FACTORY_ORCHESTRATOR_TOKEN` (the owner's delegate agent) and `FACTORY_READ_TOKEN` are optional, and a caller whose token is not set does not exist. Every token is at least 16
 * characters and all are different (`settings.ts`). A token is compared in constant time. The hook socket is not here:
 * its mode (0600) is its credential.
 *
 * **Fail closed.** A route with no entry is 403 `forbidden` for everyone, so a new route stays shut until it has a row
 * below. No token, or an unknown one, is 401 `unauthorized`; a known caller the row does not list is 403 `forbidden`.
 * The first row that matches wins, so a narrower row goes before a wider one.
 *
 * **The classes** (the owner is on every row but `public`; the orchestrator is on every row the owner is, bar the eight `PERSON` rows):
 * - public: `GET /health`, the only route without a token.
 * - read: `GET /v1/*`, for owner, agent and read, except `GET /v1/errands` (the owner's hands) and a lead's own session read
 *   (`GET /v1/issues/:id/lead`), which are placed before it. A GET outside `/v1` is the owner's.
 * - lead verbs: what a lead session calls on its own Issue (owner and agent): the `POST /v1/issues/:id/*` verbs, `ship`,
 *   `quality`, a revision, its own session read, a note to a session, the signal it files, the test slots it takes and the
 *   door routes it sets or removes for its own Issue's repo (`POST /door/routes`, `/door/routes/remove`; `app/intake.ts` holds the repo check).
 * - owner only: everything else, and every route nobody has listed yet (new, cancel, note, answer, prio, reopen, verdicts, projects, queue,
 *   capacity, loops, reading the door's registry). When in doubt, the owner alone.
 * - person: the owner's own judgment and hands, never the orchestrator's: `POST /v1/decisions/:id/worth-asking`,
 *   `POST /v1/artifacts/:id/verdict`, `POST /v1/artifacts/:id/annotations` and its `PATCH`/`DELETE /v1/artifacts/:id/annotations/:annotationId`, `POST /v1/errands/:id/done`, and
 *   `POST /signals/:id/promote` and `/dismiss` (releasing or refusing quarantined outside text).
 * - orchestrator: the owner's delegate agent. It has the owner's rights on every other row (it steers, cancels, reopens, files and
 *   answers) so the log and the owner-touch counts can tell it from the owner; its token is the only difference.
 * - machine: exactly `POST /signals/alerts`, `POST /signals/feedback` and `POST /door/reports`, the door's three calls (the owner may make them too).
 * - signal: exactly `POST /signals`, and only as `owner:hermes` (`app/intake.ts`): the narrow caller that files the owner's
 *   words, so no surface holds the owner's token.
 *
 * Adding a route: add its row here, in the class it belongs to. `test/policy.test.ts` walks the OpenAPI document and
 * fails on a route without a row.
 */
export const CALLERS = ['owner', 'orchestrator', 'agent', 'machine', 'signal', 'read'] as const
export type Caller = (typeof CALLERS)[number]

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface Rule {
  method: Method
  /** Elysia's route string (`/v1/issues/:id/close`); a trailing `/*` matches everything under that prefix */
  route: string
  /** who may call it; `public` needs no token */
  callers: readonly Caller[] | 'public'
}

const PERSON: readonly Caller[] = ['owner']
const OWNER: readonly Caller[] = ['owner', 'orchestrator']
const LEAD: readonly Caller[] = ['owner', 'orchestrator', 'agent']
const READ: readonly Caller[] = ['owner', 'orchestrator', 'agent', 'read']
const DOOR: readonly Caller[] = ['owner', 'orchestrator', 'machine']
const FILE: readonly Caller[] = ['owner', 'orchestrator', 'agent', 'signal']

const rule = (method: Method, route: string, callers: Rule['callers']): Rule => ({ method, route, callers })

export const POLICY: readonly Rule[] = [
  // -- public ----------------------------------------------------------------------------------------------------------
  rule('GET', '/health', 'public'),

  // -- machine: the door's three calls -------------------------------------------------------------------------------
  rule('POST', '/signals/alerts', DOOR),
  rule('POST', '/signals/feedback', DOOR),
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
  rule('POST', '/signals', FILE),
  rule('PUT', '/slots/:id', LEAD),
  rule('DELETE', '/slots/:id', LEAD),

  // -- inside /v1 where a wider row would let a reader in -----------------------------------------------------------
  // Whole texts and contents (a Decision's form, an artifact's revisions, the owner's pages, the Errands): the read token
  // sees them only through the read models, which hide a work repo's words.
  rule('GET', '/v1/errands', OWNER),
  rule('GET', '/v1/decisions', LEAD),
  rule('GET', '/v1/decisions/:id', LEAD),
  rule('GET', '/v1/artifacts', LEAD),
  rule('GET', '/v1/artifacts/:id', LEAD),
  rule('GET', '/v1/pages', LEAD),

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
  rule('POST', '/v1/decisions/:id/worth-asking', PERSON),
  rule('POST', '/v1/artifacts/:id/annotations', PERSON),
  rule('PATCH', '/v1/artifacts/:id/annotations/:annotationId', PERSON),
  rule('DELETE', '/v1/artifacts/:id/annotations/:annotationId', PERSON),
  rule('POST', '/v1/artifacts/:id/verdict', PERSON),
  rule('POST', '/v1/errands/:id/done', PERSON),
  rule('POST', '/v1/checkpoints/pass', OWNER),
  rule('POST', '/v1/loops/:name/run', OWNER),
  rule('POST', '/signals/:id/promote', PERSON),
  rule('POST', '/signals/:id/dismiss', PERSON),
  rule('GET', '/door/routes', OWNER),
  rule('POST', '/door/routes', LEAD),
  rule('POST', '/door/routes/remove', LEAD),
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
