import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stateOf } from '../flow.ts'
import { bearer, freePort, startServer, TOKENS, type ServerProcess, type World } from '../harness.ts'

const ROOT = join(import.meta.dir, '..', '..', '..')
const DOOR_MAIN = join(ROOT, 'apps', 'door', 'src', 'main.ts')
const LAUNCHCTL = join(import.meta.dir, '..', 'fakes', 'launchctl.ts')

export interface ProjectJson {
  repo: string
  work?: boolean
  sources?: string[]
  github?: { label?: string; author?: string | null; since?: string | null; checks?: boolean } | null
  launchd?: string[]
  heal?: { when: string; graceMs: number; runbook?: 'make restart' | null; max?: number }[]
}

/** A directory standing in for ~/SourceRoot: one folder per project, a projects file, an infra file, a launchctl script. */
export interface Estate {
  dir: string
  sourceRoot: string
  projectsFile: string
  infraFile: string
  launchctlFile: string
  env: Record<string, string>
  /** a project folder with a Makefile and, if asked, a git `origin` */
  repo(name: string, options?: { makefile?: string; origin?: string }): Promise<string>
  stop(): Promise<void>
}

export async function makeEstate(
  world: World,
  projects: ProjectJson[],
  hosts: Record<string, { repo: string; local?: boolean }> = { vps: { repo: 'vps' } },
): Promise<Estate> {
  const dir = await mkdtemp('/tmp/factory-estate-')
  const sourceRoot = join(dir, 'SourceRoot')
  await mkdir(sourceRoot, { recursive: true })
  const projectsFile = join(dir, 'projects.json')
  const infraFile = join(dir, 'infra.json')
  const launchctlFile = join(dir, 'launchctl.json')
  await writeFile(projectsFile, JSON.stringify({ projects }))
  await writeFile(infraFile, JSON.stringify({ hosts }))
  await writeFile(launchctlFile, '{}')
  const shim = join(world.bin, 'launchctl')
  // The poller runs launchctl with a scrubbed environment, so the fake's files are named in its shim.
  await writeFile(
    shim,
    `#!/bin/sh\nFACTORY_FAKE_LAUNCHCTL="${launchctlFile}" FACTORY_FAKE_LOG="${join(world.bin, 'calls.jsonl')}" exec "${process.execPath}" "${LAUNCHCTL}" "$@"\n`,
  )
  await chmod(shim, 0o755)
  return {
    dir,
    sourceRoot,
    projectsFile,
    infraFile,
    launchctlFile,
    env: {
      FACTORY_SOURCE_ROOT: sourceRoot,
      FACTORY_INTAKE_PROJECTS_FILE: projectsFile,
      FACTORY_INFRA_FILE: infraFile,
      FACTORY_SETTLE_POLL: '1s',
      FACTORY_GITHUB_POLL: 'off',
      FACTORY_BESZEL_POLL: 'off',
      FACTORY_LAUNCHD_POLL: 'off',
      FACTORY_FAKE_LAUNCHCTL: launchctlFile,
    },
    async repo(name, options = {}) {
      const path = join(sourceRoot, name)
      await mkdir(path, { recursive: true })
      if (options.makefile) await writeFile(join(path, 'Makefile'), options.makefile)
      if (options.origin) {
        const git = async (...args: string[]) => {
          const proc = Bun.spawn(['git', '-C', path, ...args], { stdout: 'ignore', stderr: 'pipe' })
          if ((await proc.exited) !== 0)
            throw new Error(`git ${args.join(' ')}: ${await new Response(proc.stderr).text()}`)
        }
        await git('init', '-q')
        await git('remote', 'add', 'origin', options.origin)
      }
      return path
    },
    stop: () => rm(dir, { recursive: true, force: true }),
  }
}

/** Starts the real server with the estate's intake settings. */
export const startIntakeServer = (
  world: World,
  estate: Estate,
  extra: Record<string, string> = {},
): Promise<ServerProcess> => startServer(world, { env: { ...estate.env, ...extra } })

export async function until<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await probe()
    if (found) return found
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(100)
  }
}

/** What the server answers for a signal (`SignalAck`). */
export interface Ack {
  outcome: string
  detail: string
  issue: string | null
  signal: string | null
  reason: string | null
}

export interface Door {
  url: string
  stop(): Promise<void>
  /** a POST to `/alert/<source>` with the source's bearer token */
  post(source: string, payload: unknown): Promise<{ status: number; body: Ack }>
  /** a POST to `/feedback/<app>` with the app's `feedback-<app>` bearer token */
  feedback(app: string, payload: unknown): Promise<{ status: number; body: Ack }>
}

const DOOR_BOOT_ATTEMPTS = 5

/**
 * The real door process on a free port, with a tokens file of its own and the server as its only way out. A port can be
 * taken between the probe and the door's bind, so a door that exits before it listens is started again on a new port;
 * the last failure carries what the door wrote to stderr.
 */
export async function startDoor(estate: Estate, server: ServerProcess, sources: string[]): Promise<Door> {
  const tokens = Object.fromEntries(sources.map((source) => [source, `${source}-token-0123456789abcdef`]))
  const tokensFile = join(estate.dir, 'door-tokens.json')
  await writeFile(tokensFile, JSON.stringify(tokens), { mode: 0o600 })
  const failures: string[] = []
  for (let attempt = 1; attempt <= DOOR_BOOT_ATTEMPTS; attempt++) {
    const port = await freePort()
    const proc = Bun.spawn([process.execPath, DOOR_MAIN], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        FACTORY_DOOR_PORT: String(port),
        FACTORY_DOOR_TOKENS_FILE: tokensFile,
        FACTORY_URL: server.url,
        FACTORY_DOOR_TOKEN: TOKENS.machine,
      },
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const stderr = new Response(proc.stderr).text()
    const url = `http://127.0.0.1:${port}`
    const listening = await until('the door to listen', async () => {
      if (proc.exitCode !== null) return 'exited' as const
      const answered = await fetch(`${url}/alert/kuma`, { method: 'POST' }).then(
        (response) => response.status === 401,
        () => false,
      )
      return answered ? ('listening' as const) : false
    })
    if (listening === 'exited') {
      failures.push(`attempt ${attempt} on port ${port}: the door exited ${proc.exitCode}\n${await stderr}`)
      continue
    }
    const send = async (path: string, token: string | undefined, payload: unknown) => {
      const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    }
    return {
      url,
      stop: async () => {
        proc.kill('SIGTERM')
        await proc.exited
      },
      post: async (source, payload) => send(`/alert/${source}`, tokens[source], payload),
      feedback: async (app, payload) => send(`/feedback/${app}`, tokens[`feedback-${app}`], payload),
    }
  }
  throw new Error(`the door did not start in ${DOOR_BOOT_ATTEMPTS} attempts:\n${failures.join('\n')}`)
}

/** A Beszel hub that answers with one system at a steady memory level. */
export interface FakeBeszel {
  url: string
  /** memory percent of every sample from now on */
  setMemory(pct: number): void
  stop(): void
}

export function fakeBeszel(system = 'vps'): FakeBeszel {
  let memory = 30
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/auth-with-password')) return Response.json({ token: 'hub-token' })
      if (url.pathname.endsWith('/systems/records')) {
        return Response.json({
          items: [
            { id: 'sys1', name: system, status: 'up', updated: stamp(new Date()), info: { t: 4, c: 4, u: 3600 } },
          ],
        })
      }
      if (url.pathname.endsWith('/system_stats/records')) {
        const now = Date.now()
        const items = Array.from({ length: 30 }, (_, i) => ({
          created: stamp(new Date(now - i * 60_000 - 5_000)),
          stats: { mp: memory, dp: 40, la: [0.4], swap: [8 * 1024 ** 3, 0] },
        }))
        return Response.json({ items })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    setMemory: (pct) => {
      memory = pct
    },
    stop: () => void server.stop(true),
  }
}

const stamp = (at: Date): string => at.toISOString().replace('T', ' ')

export interface GithubIssueJson {
  number: number
  title: string
  body?: string
  login?: string
  labels?: string[]
  created_at?: string
}

/** A GitHub API that serves a repo's open issues and records every request, comments and closes included. */
export interface FakeGithub {
  url: string
  issues: GithubIssueJson[]
  /** `METHOD path?query` of every request, in order */
  requests: string[]
  comments: { number: number; body: string }[]
  closed: number[]
  stop(): void
}

export function fakeGithub(): FakeGithub {
  const state: FakeGithub = { url: '', issues: [], requests: [], comments: [], closed: [], stop: () => undefined }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      state.requests.push(`${req.method} ${url.pathname}${url.search}`)
      const issues = /^\/repos\/[^/]+\/[^/]+\/issues$/.exec(url.pathname)
      if (issues && req.method === 'GET') {
        const label = url.searchParams.get('labels')
        const creator = url.searchParams.get('creator')
        const list = state.issues
          .filter((issue) => (label ? (issue.labels ?? []).includes(label) : true))
          .filter((issue) => (creator ? issue.login?.toLowerCase() === creator.toLowerCase() : true))
          .map((issue) => ({
            number: issue.number,
            title: issue.title,
            body: issue.body ?? '',
            html_url: `https://github.com/o/argo/issues/${issue.number}`,
            created_at: issue.created_at ?? '2026-11-07T10:00:00Z',
            labels: (issue.labels ?? []).map((name) => ({ name })),
            user: { login: issue.login ?? 'someone' },
          }))
        return Response.json(list)
      }
      const comments = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(url.pathname)
      if (comments?.[1] && req.method === 'GET') {
        return Response.json(
          state.comments.filter((c) => c.number === Number(comments[1])).map((c) => ({ body: c.body })),
        )
      }
      if (comments?.[1] && req.method === 'POST') {
        const body = (await req.json()) as { body: string }
        state.comments.push({ number: Number(comments[1]), body: body.body })
        return Response.json({ id: state.comments.length }, { status: 201 })
      }
      const one = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(url.pathname)
      if (one?.[1] && req.method === 'PATCH') {
        state.closed.push(Number(one[1]))
        return Response.json({})
      }
      return new Response('not found', { status: 404 })
    },
  })
  state.url = `http://127.0.0.1:${server.port}`
  state.stop = () => void server.stop(true)
  return state
}

export interface Observed {
  state: string
  outcome: string | null
  version: number
}

/** What an Issue is now, read-only from the world's database. */
export async function observe(world: World, issue: string): Promise<Observed> {
  const { state, outcome, version } = await stateOf(world, issue)
  return { state, outcome, version }
}

/** An answer body the scenarios read by path. */
// oxlint-disable-next-line typescript/no-explicit-any -- a scenario reads JSON by path; the routes' contracts are tested elsewhere
type Body = any

/** POST JSON to the server and return the status and body. */
export async function post(
  server: ServerProcess,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Body }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer() },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

export const get = async (server: ServerProcess, path: string): Promise<{ status: number; body: Body }> => {
  const response = await fetch(`${server.url}${path}`, { headers: bearer() })
  return { status: response.status, body: await response.json() }
}
