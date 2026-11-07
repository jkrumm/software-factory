import { factory, type Caller } from '../harness.ts'
import { startVerbsWorld, type Run, type VerbsWorld } from '../verbs/support.ts'

export { type Run, type VerbsWorld }

/** The world every client scenario runs in: the verbs world (fake hc and agw, a real repo `example`, the real server). */
export const startClientsWorld = (env: Record<string, string> = {}): Promise<VerbsWorld> => startVerbsWorld(env)

export interface Called {
  code: number
  out: string
  err: string
  json: unknown
  /** the JSON error line a failure printed last on stderr, or null */
  error: { kind: string; code: string | null; message: string; details: Record<string, unknown> } | null
}

const parse = (text: string): unknown => {
  try {
    return text.trim() ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/**
 * `factory <args>` as a client calls it: its own environment on top of the world's (a lead has `FACTORY_SESSION`), the token
 * of a caller. The error line is the last line of stderr.
 */
export async function call(
  v: VerbsWorld,
  args: string[],
  as: Caller | 'none' = 'owner',
  env: Record<string, string> = {},
): Promise<Called> {
  const raw = await factory(v.w.world, args, { FACTORY_URL: v.w.server.url, ...env }, { as })
  const last = parse(raw.err.trim().split('\n').at(-1) ?? '') as { error?: Called['error'] } | null
  return { ...raw, json: parse(raw.out), error: raw.code === 0 ? null : (last?.error ?? null) }
}

/** The names of the keys of an object, with the kind of each value, for "the field and its type" assertions. */
export function shapeOf(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item,
    ]),
  )
}

/**
 * Asserts a body carries each named field with the type the client reads. A type is `string`, `number`, `boolean`, `array`,
 * `object` or `null`; `a|b` allows either (a nullable field).
 */
export function fieldsOf(body: unknown, fields: Record<string, string>): string[] {
  const shape = shapeOf(body)
  return Object.entries(fields).flatMap(([name, type]) => {
    const got = shape[name]
    return got !== undefined && type.split('|').includes(got) ? [] : [`${name}: want ${type}, got ${got ?? 'missing'}`]
  })
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [err, code] = await Promise.all([proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${err}`)
}

/**
 * A work repo: a git repo inside the allowed root with an `origin` and no `project.yaml`. Once an Issue names it,
 * `project sync` stores it on the defaults, which is what makes its text private to the read token.
 */
export async function addWorkRepo(v: VerbsWorld, name: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const origin = join(v.w.root, `.${name}-origin.git`)
  const repo = join(v.w.root, name)
  await mkdir(origin)
  await git(origin, 'init', '-q', '--bare', '-b', 'master')
  await mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'master')
  await Bun.write(join(repo, 'README.md'), `# ${name}\n`)
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'init')
  await git(repo, 'remote', 'add', 'origin', origin)
  await git(repo, 'push', '-q', 'origin', 'master')
  await git(repo, 'fetch', '-q', 'origin')
}
