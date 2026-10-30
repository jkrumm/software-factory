import type { SQL } from 'bun'
import { z } from 'zod'
import { recordReading } from './capacity.ts'
import type { Clock } from './clock.ts'
import { AccountName, CapacityInput, EventInput, SpawnInput } from './schemas.ts'
import { getSession, recordEvent } from './sessions.ts'
import { createSpawn, getSpawn, listSpawns } from './spawns.ts'

export interface AppDeps {
  sql: SQL
  clock: Clock
  /** what `/health` reports: the release sha in production */
  version: string
}

const json = (body: unknown, status = 200, headers?: Record<string, string>): Response =>
  Response.json(body, { status, headers })

class BadRequest extends Error {}

async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  let body: unknown
  try {
    body = await req.json()
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

function guarded<R extends Request>(handler: (req: R) => Promise<Response>): (req: R) => Promise<Response> {
  return async (req) => {
    try {
      return await handler(req)
    } catch (error) {
      return failure(error)
    }
  }
}

function failure(error: unknown): Response {
  if (error instanceof BadRequest) return json({ error: error.message }, 400)
  console.error(error)
  return json({ error: 'internal error' }, 500)
}

/** The route table for `Bun.serve`. */
export function routes({ sql, clock, version }: AppDeps) {
  return {
    '/health': {
      GET: guarded(async () => {
        await sql`SELECT 1`
        return json({ status: 'ok', version })
      }),
    },
    '/events': {
      POST: guarded(async (req: Request) => {
        const { duplicate } = await recordEvent(sql, await parseBody(req, EventInput))
        return json({ duplicate }, duplicate ? 200 : 201)
      }),
    },
    '/sessions/:id': {
      GET: guarded(async (req: Bun.BunRequest<'/sessions/:id'>) => {
        const session = await getSession(sql, req.params.id)
        return session ? json(session) : json({ error: 'unknown session' }, 404)
      }),
    },
    '/spawns': {
      GET: guarded(async () => json({ spawns: await listSpawns(sql) })),
      POST: guarded(async (req: Request) => {
        const { spawn, created } = await createSpawn(sql, await parseBody(req, SpawnInput), clock.now())
        return json(spawn, created ? 201 : 200)
      }),
    },
    '/spawns/:key': {
      GET: guarded(async (req: Bun.BunRequest<'/spawns/:key'>) => {
        const spawn = await getSpawn(sql, req.params.key)
        return spawn ? json(spawn) : json({ error: 'unknown spawn' }, 404)
      }),
    },
    '/capacity/:account': {
      PUT: guarded(async (req: Bun.BunRequest<'/capacity/:account'>) => {
        const account = parseParam(AccountName, req.params.account)
        const reading = await parseBody(req, CapacityInput)
        await recordReading(sql, account, reading, clock.now())
        return json({ account, ...reading, resetsAt: reading.resetsAt.toISOString() })
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
