import { createHash, timingSafeEqual } from 'node:crypto'
import {
  EventAck,
  Health,
  Quota,
  QuotaList,
  QueueView,
  type RoleTable,
  Session,
  SessionList,
  Spawn,
  SpawnList,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import { z } from 'zod'
import { isFresh, latestReadings, type Reading, recordReading } from './capacity.ts'
import type { Clock } from './clock.ts'
import { QuotaError, type QuotaPoller } from './quota.ts'
import { getQueue, setQueue } from './queue.ts'
import { AccountName, EventInput, QueueInput, QuotaInput, SpawnInput, WaitInput } from './schemas.ts'
import { declareWait, getSession, listSessions, recordEvent } from './sessions.ts'
import type { TickMonitor } from './health.ts'
import { RepoRefused, resolveRepo } from './repos.ts'
import { createSpawn, getSpawn, listSpawns, requeueSpawn } from './spawns.ts'

export interface AppDeps {
  sql: SQL
  clock: Clock
  /** what `/health` reports: the release sha in production */
  version: string
  /** the bearer token every route except `GET /health` requires */
  token: string
  /** what the ticker reports; `/health` is unhealthy when it goes quiet */
  monitor: TickMonitor
  /** the directories a spawn's repo must be inside */
  repoRoots: readonly string[]
  /** the role table: a spawn's role must be in it, and it gives the spawn's tier and effort */
  roles: RoleTable
  /** reads the account picker on demand (`POST /quota/refresh`) */
  quota: QuotaPoller
}

/** Largest request body the server reads. */
export const MAX_BODY_BYTES = 64 * 1024

const json = (body: unknown, status = 200, headers?: Record<string, string>): Response =>
  Response.json(body, { status, headers })

/** The body goes through the contract's schema on its way out: a server that drifts from it fails here, not in a client. */
const respond = <S extends z.ZodType>(schema: S, body: z.input<S>, status = 200): Response =>
  json(schema.parse(body), status)

class BadRequest extends Error {}

/** A refusal with its own status, decided before any handler runs. */
class Refusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers?: Record<string, string>,
  ) {
    super(message)
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** DNS rebinding sends the victim's browser to a loopback address under an attacker's name: only loopback names pass. */
function assertLoopbackHost(req: Request): void {
  const host = req.headers.get('host')?.toLowerCase()
  const name = host?.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host?.split(':')[0]
  if (!name || !LOOPBACK_HOSTS.has(name)) throw new Refusal('host is not loopback', 421)
}

const digest = (value: string) => createHash('sha256').update(value).digest()

function assertBearer(req: Request, token: string): void {
  const match = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')
  // Equal-length digests keep the comparison constant-time whatever the caller sent.
  if (!match?.[1] || !timingSafeEqual(digest(match[1]), digest(token))) {
    throw new Refusal('missing or wrong bearer token', 401, { 'www-authenticate': 'Bearer' })
  }
}

/** A cross-origin form or `fetch` can send `text/plain` without a preflight; JSON it cannot. */
function assertJsonContentType(req: Request): void {
  if (req.method === 'GET' || req.method === 'HEAD') return
  const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/json') throw new Refusal('content-type must be application/json', 415)
}

/** The body as text, never more than the cap: `Content-Length` is checked first, and the stream is counted for the rest. */
async function readBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get('content-length'))
  if (declared > MAX_BODY_BYTES) throw new Refusal(`body is larger than ${MAX_BODY_BYTES} bytes`, 413)
  const chunks: Uint8Array[] = []
  let size = 0
  if (req.body) {
    for await (const chunk of req.body) {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) throw new Refusal(`body is larger than ${MAX_BODY_BYTES} bytes`, 413)
      chunks.push(chunk)
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  const text = await readBody(req)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new BadRequest('body is not valid JSON')
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new BadRequest(z.prettifyError(parsed.error))
  return parsed.data
}

function parseParam<S extends z.ZodType>(schema: S, value: string): z.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new BadRequest(z.prettifyError(parsed.error))
  return parsed.data
}

/**
 * Every route goes through here: a loopback Host, then (unless `open`) the bearer token, then a JSON content type for
 * anything that sends a body. The handler runs only after all three.
 */
function guarded<R extends Request>(
  token: string,
  handler: (req: R) => Promise<Response>,
  options: { open?: boolean } = {},
): (req: R) => Promise<Response> {
  return async (req) => {
    try {
      assertLoopbackHost(req)
      if (!options.open) assertBearer(req, token)
      assertJsonContentType(req)
      return await handler(req)
    } catch (error) {
      return failure(error)
    }
  }
}

function failure(error: unknown): Response {
  if (error instanceof Refusal) return json({ error: error.message }, error.status, error.headers)
  if (error instanceof BadRequest) return json({ error: error.message }, 400)
  console.error(error)
  return json({ error: 'internal error' }, 500)
}

/** `POST /sessions/:id/wait`: declares or closes a wait, answers with the session. */
const waitHandler =
  (sql: SQL, clock: Clock) =>
  async (req: Bun.BunRequest<'/sessions/:id/wait'>): Promise<Response> => {
    const wait = await parseBody(req, WaitInput)
    const now = clock.now()
    if (!(await declareWait(sql, req.params.id, wait, now))) return json({ error: 'unknown session' }, 404)
    const session = await getSession(sql, req.params.id, now)
    return session ? respond(Session, session) : json({ error: 'unknown session' }, 404)
  }

const quotaView = (r: Reading, now: Date): Quota => ({
  account: r.account,
  enabled: r.enabled,
  authOk: r.authOk,
  fiveHourUsed: r.fiveHourUsed,
  weeklyUsed: r.weeklyUsed,
  fiveHourResetsAt: r.fiveHourResetsAt?.toISOString() ?? null,
  weeklyResetsAt: r.weeklyResetsAt?.toISOString() ?? null,
  exhaustedUntil: r.exhaustedUntil?.toISOString() ?? null,
  sampledAt: r.sampledAt?.toISOString() ?? null,
  readAt: r.readAt.toISOString(),
  fresh: isFresh(r, now),
})

/** The project of a queue request, as a spawn's repo is: a real directory inside the allowed roots. */
const resolveProject = (project: string, repoRoots: readonly string[]): Promise<string> =>
  resolveRepo(project, repoRoots).catch((error) => {
    throw error instanceof RepoRefused ? new Refusal(error.message, 422) : error
  })

/** The route table for `Bun.serve`. */
export function routes({ sql, clock, version, token, monitor, repoRoots, roles, quota }: AppDeps) {
  const route = <R extends Request>(handler: (req: R) => Promise<Response>) => guarded(token, handler)
  return {
    '/health': {
      GET: guarded(
        token,
        async () => {
          await sql`SELECT 1`
          const health = { version, ...monitor.snapshot() }
          return respond(Health, health, health.status === 'ok' ? 200 : 503)
        },
        { open: true },
      ),
    },
    '/events': {
      POST: route(async (req: Request) => {
        const { duplicate } = await recordEvent(sql, await parseBody(req, EventInput))
        return respond(EventAck, { duplicate }, duplicate ? 200 : 201)
      }),
    },
    '/sessions': {
      GET: route(async (req: Request) => {
        const all = new URL(req.url).searchParams.get('all') === '1'
        return respond(SessionList, { sessions: await listSessions(sql, clock.now(), { all }) })
      }),
    },
    '/sessions/:id': {
      GET: route(async (req: Bun.BunRequest<'/sessions/:id'>) => {
        const session = await getSession(sql, req.params.id, clock.now())
        return session ? respond(Session, session) : json({ error: 'unknown session' }, 404)
      }),
    },
    '/sessions/:id/wait': { POST: route(waitHandler(sql, clock)) },
    '/spawns': {
      GET: route(async () => respond(SpawnList, { spawns: await listSpawns(sql) })),
      POST: route(async (req: Request) => {
        const input = await parseBody(req, SpawnInput)
        const entry = roles.get(input.role)
        if (!entry) throw new Refusal(`unknown role ${input.role} (${[...roles.keys()].join(', ')})`, 422)
        // The policy decides before anything is stored; the row keeps the resolved path.
        const repo = await resolveProject(input.repo, repoRoots)
        const { spawn, created } = await createSpawn(
          sql,
          { ...input, repo, tier: entry.tier, effort: entry.effort },
          clock.now(),
        )
        return respond(Spawn, spawn, created ? 201 : 200)
      }),
    },
    '/spawns/:key': {
      GET: route(async (req: Bun.BunRequest<'/spawns/:key'>) => {
        const spawn = await getSpawn(sql, req.params.key)
        return spawn ? respond(Spawn, spawn) : json({ error: 'unknown spawn' }, 404)
      }),
    },
    '/spawns/:key/requeue': {
      POST: route(async (req: Bun.BunRequest<'/spawns/:key/requeue'>) => {
        const result = await requeueSpawn(sql, req.params.key)
        if ('spawn' in result) return respond(Spawn, result.spawn)
        if (result.problem === 'unknown') return json({ error: 'unknown spawn' }, 404)
        return json({ error: `spawn is ${result.status}; only a failed spawn can be re-queued` }, 409)
      }),
    },
    '/quota': {
      GET: route(async () => {
        const now = clock.now()
        return respond(QuotaList, { quota: (await latestReadings(sql)).map((r) => quotaView(r, now)) })
      }),
    },
    '/quota/refresh': {
      POST: route(async () => {
        await quota.poll().catch((error) => {
          throw error instanceof QuotaError ? new Refusal(error.message, 502) : error
        })
        const now = clock.now()
        return respond(QuotaList, { quota: (await latestReadings(sql)).map((r) => quotaView(r, now)) })
      }),
    },
    // A reading by hand, for tests and operators; the next poll of the picker supersedes it.
    '/quota/accounts/:account': {
      PUT: route(async (req: Bun.BunRequest<'/quota/accounts/:account'>) => {
        const account = parseParam(AccountName, req.params.account)
        const now = clock.now()
        await recordReading(sql, { account, ...(await parseBody(req, QuotaInput)) }, now)
        const stored = (await latestReadings(sql)).find((r) => r.account === account)
        return stored ? respond(Quota, quotaView(stored, now)) : json({ error: 'reading not stored' }, 500)
      }),
    },
    '/queue': {
      GET: route(async (req: Request) => {
        const project = new URL(req.url).searchParams.get('project')
        return respond(
          QueueView,
          await getQueue(sql, project === null ? null : await resolveProject(project, repoRoots)),
        )
      }),
      PUT: route(async (req: Request) => {
        const { state, project } = await parseBody(req, QueueInput)
        const scope = project === undefined ? null : await resolveProject(project, repoRoots)
        return respond(QueueView, await setQueue(sql, scope, state, clock.now()))
      }),
    },
  } as const
}

/** The methods each route pattern answers, as a matcher for the paths `fetch` receives. */
function allowedMethods(table: Record<string, object>): (pathname: string) => string[] {
  const patterns = Object.entries(table).map(([pattern, handlers]) => ({
    regex: new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`),
    methods: Object.keys(handlers),
  }))
  return (pathname) => patterns.find((p) => p.regex.test(pathname))?.methods ?? []
}

export function serve(deps: AppDeps & { port: number }) {
  const table = routes(deps)
  const allowed = allowedMethods(table)
  return Bun.serve({
    hostname: '127.0.0.1',
    port: deps.port,
    routes: table,
    // Bun routes per method: a known path with another method lands here, and must not read as "no such resource".
    fetch: (req) => {
      const methods = allowed(new URL(req.url).pathname)
      if (methods.length === 0) return json({ error: 'not found' }, 404)
      return json({ error: 'method not allowed' }, 405, { allow: methods.join(', ') })
    },
    error: failure,
  })
}

/**
 * The sessions' way in: a unix socket in the owner's directory, with `POST /events` and `POST /sessions/:id/wait` and
 * nothing else. A session has no token (the runner keeps secrets out of the panes), and the socket's mode 0600 is
 * what only the owner's processes can pass.
 */
export function serveHooks(deps: { sql: SQL; clock: Clock; token: string; socketPath: string }) {
  const open = { open: true }
  const post = guarded(
    deps.token,
    async (req: Request) => {
      const { duplicate } = await recordEvent(deps.sql, await parseBody(req, EventInput))
      return respond(EventAck, { duplicate }, duplicate ? 200 : 201)
    },
    open,
  )
  const wait = guarded(deps.token, waitHandler(deps.sql, deps.clock), open)
  return Bun.serve({
    unix: deps.socketPath,
    routes: { '/events': { POST: post }, '/sessions/:id/wait': { POST: wait } },
    fetch: () => json({ error: 'not found' }, 404),
    error: failure,
  })
}
