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
 * - lead verbs: what a lead session calls on its own Issue (owner and agent): `POST /issues/:id/withdraw` (the filer of the Issue's signals takes it back while no lead has it; the server checks the state and that `from` is the only source, and records `cancelled` as the factory, never as an owner touch), the `POST /v1/issues/:id/*` verbs (`replan` included: the server gates it on the Replan's approved Spec and its own project's Issues, while `/planning/after|unafter` and `cancel` stay owner only), `ship`,
 *   `quality`, a revision, a standalone Report (`POST /v1/artifacts`), an artifact's link to an Issue (`POST /v1/artifacts/:id/links`), and a Report's retire and restore (`POST /v1/artifacts/:id/retire|restore`; none is scoped to the caller's own Issue: an agent may file a Report under any repo inside the roots and link or retire any artifact), a collection of artifacts and its pin (`POST /v1/artifact-collections[/:id[/pin|/unpin]]`), its answer to an annotation (`POST /v1/artifacts/:id/annotations/:annotationId/reply`; the server gates it on the Issue's current attempt when an Issue owns the artifact), a request for the owner's hands that no Issue raised (`POST /v1/errands/requests`: its `check` is a shell command the `errands` loop runs, so only a caller that can run shell itself may set one), an Errand's check run now (`POST /v1/errands/:id/check`: it runs the command the Errand already carries), its own session read, a note to a session, a note on an Issue (`POST /issues/:id/note`: recorded as the factory's and fenced as data, `wake` refused; a closed Issue answers 409), the signal it files, the test slots it takes, a repo's relearn point (`POST /capacity/relearn`: an Issue's own ship step may set one, any repo; the actor is recorded as `agent`) and the
 *   door routes it sets or removes for its own Issue's repo (`POST /door/routes`, `/door/routes/remove`; `app/intake.ts` holds the repo check).
 * - owner only: everything else, and every route nobody has listed yet (new, cancel, seat, answer, prio, reopen, verdicts, projects, queue,
 *   capacity writes, loops, reading the door's registry; `GET /capacity` is the one capacity read a lead has). When in doubt, the owner alone.
 * - person: the owner's own judgment and hands, never the orchestrator's: `POST /v1/decisions/:id/worth-asking`,
 *   `POST /v1/artifacts/:id/needed` (his "needed me" mark), `POST /v1/artifacts/:id/annotations` and its `PATCH`/`DELETE /v1/artifacts/:id/annotations/:annotationId`, `POST /v1/errands/:id/approve` (his yes: the server runs the Errand's command on the mini), and
 *   `POST /signals/:id/promote` and `/dismiss` (releasing or refusing quarantined outside text).
 * - Errand done (`POST /v1/errands/:id/done`) is an owner row: the orchestrator may close an Errand its operator confirmed, with `confirmedBy`
 *   and only as `done` (the server refuses the rest, 422), recorded as `orchestrator`, never `owner`. A `not_needed` stays the owner's.
 * - verdict: `POST /v1/artifacts/:id/verdict` is an owner row. The orchestrator's verdict is recorded as its own (`by: orchestrator`), on a Spec that is no owner gate only, and his verdict on the same revision replaces it.
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
  rule('POST', '/v1/decisions/:id/take-default', LEAD),
  rule('POST', '/v1/issues/:id/replan', LEAD),
  rule('POST', '/v1/issues/:id/artifacts', LEAD),
  rule('POST', '/v1/issues/:id/errands', LEAD),
  rule('POST', '/v1/errands/requests', LEAD),
  rule('POST', '/v1/errands/:id/check', LEAD),
  rule('POST', '/v1/artifacts', LEAD),
  rule('POST', '/v1/artifacts/:id/links', LEAD),
  rule('POST', '/v1/artifacts/:id/retire', LEAD),
  rule('POST', '/v1/artifacts/:id/restore', LEAD),
  rule('POST', '/v1/artifacts/:id/revisions', LEAD),
  rule('POST', '/v1/artifact-collections', LEAD),
  rule('POST', '/v1/artifact-collections/:id', LEAD),
  rule('POST', '/v1/artifacts/:id/annotations/:annotationId/reply', LEAD),
  rule('POST', '/v1/sessions/:session/note', LEAD),
  rule('POST', '/issues/:id/ship', LEAD),
  rule('POST', '/issues/:id/withdraw', LEAD),
  // an agent's note is recorded as the factory's, fenced as data, and may not wake; any Issue, as a session note reaches any lead
  rule('POST', '/issues/:id/note', LEAD),
  rule('GET', '/issues/:id/quality', LEAD),
  rule('GET', '/v1/issues/:id/lead', LEAD),
  rule('POST', '/signals', FILE),
  rule('PUT', '/slots/:id', LEAD),
  rule('DELETE', '/slots/:id', LEAD),
  rule('POST', '/slots/:id/cost', LEAD),
  rule('POST', '/merge-windows', LEAD),

  // -- inside /v1 where a wider row would let a reader in -----------------------------------------------------------
  // Whole texts and contents (a Decision's form, an artifact's revisions, the owner's pages, the Errands): the read token
  // sees them only through the read models, which hide a work repo's words.
  rule('GET', '/v1/errands', OWNER),
  rule('GET', '/v1/decisions', LEAD),
  rule('GET', '/v1/decisions/:id', LEAD),
  rule('GET', '/v1/artifacts', LEAD),
  rule('GET', '/v1/artifact-collections', LEAD),
  rule('GET', '/v1/artifact-collections/:id', LEAD),
  rule('GET', '/v1/artifacts/:id', LEAD),
  // the screen request carries the owner's verdict notes on other projects' Specs as precedents: his and his delegate's only
  rule('GET', '/v1/artifacts/:id/screen', OWNER),
  rule('GET', '/v1/pages', LEAD),
  // tenant and repo names of work repos: the read token never sees them; a lead reads the figures with those names redacted
  rule('GET', '/v1/throughput', LEAD),

  // -- read ----------------------------------------------------------------------------------------------------------
  rule('GET', '/v1/projects/digests', READ),
  rule('GET', '/v1/projects', READ),
  rule('GET', '/v1/projects/:name', READ),
  rule('GET', '/v1/projects/:name/hygiene', READ),
  rule('GET', '/v1/projects/:name/setup', READ),
  rule('GET', '/v1/schema/project', READ),
  rule('GET', '/v1/*', READ),

  // -- owner only: everything else that exists today -----------------------------------------------------------------
  rule('POST', '/issues', OWNER),
  rule('POST', '/issues/:id/reopen', OWNER),
  rule('POST', '/issues/:id/cancel', OWNER),
  rule('POST', '/issues/:id/seat', OWNER),
  rule('POST', '/issues/:id/answer', OWNER),
  rule('POST', '/issues/:id/prio', OWNER),
  rule('POST', '/v1/decisions/:id/answer', OWNER),
  rule('POST', '/v1/decisions/:id/worth-asking', PERSON),
  rule('POST', '/v1/artifacts/:id/annotations', PERSON),
  rule('PATCH', '/v1/artifacts/:id/annotations/:annotationId', PERSON),
  rule('DELETE', '/v1/artifacts/:id/annotations/:annotationId', PERSON),
  // his delegate may give a Spec's verdict for him (not an owner gate's: `giveVerdict` refuses it), recorded as `orchestrator`; his own verdict replaces it
  rule('POST', '/v1/artifacts/:id/verdict', OWNER),
  rule('POST', '/v1/artifacts/:id/needed', PERSON),
  // the orchestrator closes an Errand only with evidence, as `done`, recorded as itself (`finishErrand`); approve stays his
  rule('POST', '/v1/errands/:id/done', OWNER),
  rule('POST', '/v1/errands/:id/approve', PERSON),
  rule('POST', '/v1/errands/:id/turn-back', OWNER),
  // a pin is one reversible timestamp, and an Issue may be filed for the owner to have one pinned: a lead pins like it retires
  rule('POST', '/v1/artifact-collections/:id/pin', LEAD),
  rule('POST', '/v1/artifact-collections/:id/unpin', LEAD),
  rule('POST', '/v1/checkpoints/pass', OWNER),
  rule('POST', '/v1/loops/:name/run', OWNER),
  rule('POST', '/v1/desk/push', OWNER),
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
  rule('POST', '/planning/unafter', OWNER),
  rule('POST', '/planning/replan', OWNER),
  // the settings in force (an acceptance line names `factory capacity get`): a lead reads them, the read token does not
  rule('GET', '/capacity', LEAD),
  rule('POST', '/capacity/refresh', OWNER),
  // a mode override on an account (docs/accounts.md §Modes): owner and orchestrator, written through packages/accounts so claude-account sees it
  rule('POST', '/v1/accounts/:id/mode', OWNER),
  rule('DELETE', '/v1/accounts/:id/mode', OWNER),
  rule('POST', '/capacity/admit', OWNER),
  rule('POST', '/capacity/relearn', LEAD),
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
