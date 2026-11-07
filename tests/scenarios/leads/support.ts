import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { InternalTestEventAnswer, InternalTestEventBody, TickAnswer } from '@software-factory/contract'
import { readState, statePathOf, type FakeHcState, type FakeTerminal } from '../fakes/hc-state.ts'
import { bearer, factory, startServer, startWorld, type ServerProcess, type World } from '../harness.ts'

const ROOT = join(import.meta.dir, '..', '..', '..')
const CLI = join(ROOT, 'apps', 'cli', 'bin', 'factory.ts')

async function git(cwd: string, ...args: string[]): Promise<string> {
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
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${err}`)
  return out.trim()
}

/** A scenario world for the leads: the fakes, a real git repo `example` inside an allowed root, and a server with the test routes on. */
export interface LeadsWorld {
  world: World
  server: ServerProcess
  /** the allowed root and the repo inside it */
  root: string
  repo: string
  /** the hook socket and spool of the world's server */
  socket: string
  spool: string
  post(path: string, body: InternalTestEventBody): Promise<InternalTestEventAnswer>
  /** files an Issue, settles it and admits it; returns its id */
  admitted(title?: string): Promise<string>
  record(issue: string, name: string, kind: string, payload: unknown, actor: string): Promise<InternalTestEventAnswer>
  tick(): Promise<TickAnswer>
  hc(): FakeHcState
  terminals(): FakeTerminal[]
  cli(args: string[]): ReturnType<typeof factory>
  /** runs `factory hook <event>` the way Claude Code does: JSON on stdin, the session in the environment */
  hook(
    event: string,
    session: string,
    input: Record<string, unknown>,
    env?: Record<string, string>,
  ): Promise<{ code: number; out: string; err: string }>
  stop(): Promise<void>
}

export async function startLeadsWorld(env: Record<string, string> = {}): Promise<LeadsWorld> {
  const world = await startWorld()
  const root = await mkdtemp('/tmp/factory-roots-')
  const origin = join(root, '.origin.git')
  const repo = join(root, 'example')
  await mkdir(origin)
  await git(origin, 'init', '-q', '--bare', '-b', 'master')
  await mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'master')
  await Bun.write(join(repo, 'README.md'), '# example\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'init')
  await git(repo, 'remote', 'add', 'origin', origin)
  await git(repo, 'push', '-q', 'origin', 'master')
  await git(repo, 'fetch', '-q', 'origin')

  const server = await startServer(world, {
    env: { FACTORY_INTERNAL_TEST_ROUTES: '1', FACTORY_REPO_ROOTS: root, FACTORY_GRACE_MS: '0', ...env },
  })
  const socket = join(world.bin, 'hook.sock')
  const spool = join(world.bin, 'spool')
  const statePath = statePathOf(join(world.bin, 'calls.jsonl'))

  async function post(path: string, body: InternalTestEventBody): Promise<InternalTestEventAnswer> {
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer() },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (response.status !== 200) throw new Error(`${path} answered ${response.status}: ${text}`)
    return JSON.parse(text) as InternalTestEventAnswer
  }
  const record = (issue: string, name: string, kind: string, payload: unknown, actor: string) =>
    post(`/internal/test/issues/${issue}/events`, {
      key: `${issue}:${name}`,
      kind,
      payload,
      actor: actor as InternalTestEventBody['actor'],
    })

  return {
    world,
    server,
    root,
    repo,
    socket,
    spool,
    post,
    record,
    admitted: async (title = 'the probe on /health fails') => {
      const filed = await post('/internal/test/issues', {
        key: `filed:${Math.random().toString(36).slice(2)}`,
        kind: 'filed',
        payload: { repo: 'example', title, kind: 'bug', origin: 'infrastructure' },
        actor: 'factory',
      })
      const issue = filed.issue.id
      await record(issue, 'settled', 'settled', {}, 'factory')
      await record(issue, 'admitted:1', 'admitted', {}, 'factory')
      return issue
    },
    tick: async () => {
      const response = await fetch(`${server.url}/internal/test/tick`, { method: 'POST', headers: bearer() })
      const text = await response.text()
      if (response.status !== 200) throw new Error(`tick answered ${response.status}: ${text}`)
      return JSON.parse(text) as TickAnswer
    },
    hc: () => readState(statePath),
    terminals: () => Object.values(readState(statePath).terminals),
    cli: (args) => factory(world, args, { FACTORY_URL: server.url }),
    hook: async (event, session, input, hookEnv = {}) => {
      const proc = Bun.spawn([process.execPath, CLI, 'hook', event], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '/tmp',
          FACTORY_SESSION: session,
          FACTORY_SOCKET: socket,
          FACTORY_SPOOL_DIR: spool,
          ...hookEnv,
        },
        stdin: new Blob([JSON.stringify(input)]),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
      return { code, out, err }
    },
    stop: async () => {
      await server.stop()
      await world.stop()
      await rm(root, { recursive: true, force: true })
    },
  }
}
