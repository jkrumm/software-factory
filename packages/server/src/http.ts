import { createHash, timingSafeEqual } from 'node:crypto'
import { CapacityAck, EventAck, Health, Session, Spawn, SpawnList } from '@software-factory/contract'
import type { SQL } from 'bun'
import { z } from 'zod'
import { recordReading } from './capacity.ts'
import type { Clock } from './clock.ts'
import { AccountName, CapacityInput, EventInput, SpawnInput } from './schemas.ts'
import { getSession, recordEvent } from './sessions.ts'
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

/** The route table for `Bun.serve`. */
export function routes({ sql, clock, version, token, monitor, repoRoots }: AppDeps) {
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
    '/sessions/:id': {
      GET: route(async (req: Bun.BunRequest<'/sessions/:id'>) => {
        const session = await getSession(sql, req.params.id)
        return session ? respond(Session, session) : json({ error: 'unknown session' }, 404)
      }),
    },
    '/spawns': {
      GET: route(async () => respond(SpawnList, { spawns: await listSpawns(sql) })),
      POST: route(async (req: Request) => {
        const input = await parseBody(req, SpawnInput)
        // The policy decides before anything is stored; the row keeps the resolved path.
        const repo = await resolveRepo(input.repo, repoRoots).catch((error) => {
          throw error instanceof RepoRefused ? new Refusal(error.message, 422) : error
        })
        const { spawn, created } = await createSpawn(sql, { ...input, repo }, clock.now())
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
    '/capacity/:account': {
      PUT: route(async (req: Bun.BunRequest<'/capacity/:account'>) => {
        const account = parseParam(AccountName, req.params.account)
        const reading = await parseBody(req, CapacityInput)
        await recordReading(sql, account, reading, clock.now())
        return respond(CapacityAck, { account, ...reading, resetsAt: reading.resetsAt.toISOString() })
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
