import type { SQL } from "bun";
import { z } from "zod";
import { recordReading } from "./capacity.ts";
import type { Clock } from "./clock.ts";
import { CapacityInput, EventInput, SpawnInput } from "./schemas.ts";
import { getSession, recordEvent } from "./sessions.ts";
import { createSpawn, getSpawn } from "./spawns.ts";

export interface AppDeps {
  sql: SQL;
  clock: Clock;
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new BadRequest("body is not valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequest(z.prettifyError(parsed.error));
  return parsed.data;
}

class BadRequest extends Error {}

function guarded<R extends Request>(handler: (req: R) => Promise<Response>): (req: R) => Promise<Response> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, 400);
      console.error(error);
      return json({ error: "internal error" }, 500);
    }
  };
}

/** The route table for `Bun.serve`. */
export function routes({ sql, clock }: AppDeps) {
  return {
    "/events": {
      POST: guarded(async (req: Request) => {
        const { duplicate } = await recordEvent(sql, await parseBody(req, EventInput));
        return json({ duplicate }, duplicate ? 200 : 201);
      }),
    },
    "/sessions/:id": {
      GET: guarded(async (req: Bun.BunRequest<"/sessions/:id">) => {
        const session = await getSession(sql, req.params.id);
        return session ? json(session) : json({ error: "unknown session" }, 404);
      }),
    },
    "/spawns": {
      POST: guarded(async (req: Request) => {
        const { spawn, created } = await createSpawn(sql, await parseBody(req, SpawnInput), clock.now());
        return json(spawn, created ? 201 : 200);
      }),
    },
    "/spawns/:key": {
      GET: guarded(async (req: Bun.BunRequest<"/spawns/:key">) => {
        const spawn = await getSpawn(sql, req.params.key);
        return spawn ? json(spawn) : json({ error: "unknown spawn" }, 404);
      }),
    },
    "/capacity/:account": {
      PUT: guarded(async (req: Bun.BunRequest<"/capacity/:account">) => {
        const reading = await parseBody(req, CapacityInput);
        await recordReading(sql, req.params.account, reading);
        return json({ account: req.params.account, ...reading, resetsAt: reading.resetsAt.toISOString() });
      }),
    },
  } as const;
}

export function serve(deps: AppDeps & { port: number }) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: deps.port,
    routes: routes(deps),
    fetch: () => json({ error: "not found" }, 404),
  });
}
