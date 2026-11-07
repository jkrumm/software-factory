import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { factory, type Caller } from '../harness.ts'
import { type LeadsWorld, startLeadsWorld } from '../leads/support.ts'

export interface Run {
  code: number
  out: string
  err: string
  /** the JSON a success printed, or null */
  json: Record<string, unknown> | null
  /** the error line a failure printed on stderr, or null */
  error: { kind: string; code: string | null; message: string; details: Record<string, unknown> } | null
}

export interface VerbsWorld {
  w: LeadsWorld
  /** `factory <args>` as a caller (the owner by default), the way a person, a lead or a client would call it */
  run(args: string[], as?: Caller): Promise<Run>
  /** the events of an Issue of a kind, oldest first */
  events(issue: string, kind: string): Promise<{ actor: string; payload: Record<string, unknown>; result: string }[]>
  issueCount(): Promise<number>
  stop(): Promise<void>
}

function parse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function startVerbsWorld(env: Record<string, string> = {}): Promise<VerbsWorld> {
  const w = await startLeadsWorld(env)
  // A link inside the root that leads out of it: realpath must see through it.
  await symlink('/tmp', join(w.root, 'escape'))
  return {
    w,
    async run(args, as = 'owner') {
      const raw = await factory(w.world, args, { FACTORY_URL: w.server.url }, { as })
      const failed = raw.code === 0 ? null : parse(raw.err.trim().split('\n').at(-1) ?? '')
      return {
        ...raw,
        json: parse(raw.out),
        error: (failed?.error as Run['error']) ?? null,
      }
    },
    async events(issue, kind) {
      const rows = await w.world.db.sql`
        SELECT actor, payload, result FROM factory.issue_events WHERE issue_id = ${issue} AND kind = ${kind} ORDER BY at, id`
      return rows as { actor: string; payload: Record<string, unknown>; result: string }[]
    },
    async issueCount() {
      const [row] = await w.world.db.sql`SELECT count(*)::int AS n FROM factory.issues`
      return (row as { n: number }).n
    },
    stop: () => w.stop(),
  }
}
