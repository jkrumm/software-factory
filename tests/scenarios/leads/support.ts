import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { TickAnswer } from '@software-factory/contract'
import { readState, statePathOf, type FakeHcState, type FakeTerminal } from '../fakes/hc-state.ts'
import { admitted, fileIssue, hook, must, tick, type Run } from '../flow.ts'
import { type Caller, factory, startServer, startWorld, type ServerProcess, type World } from '../harness.ts'

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

/** A scenario world for the leads: the fakes, a real git repo `example` inside an allowed root, and a server whose project is read. */
export interface LeadsWorld {
  world: World
  server: ServerProcess
  /** the allowed root and the repo inside it */
  root: string
  repo: string
  /** the hook socket and spool of the world's server */
  socket: string
  spool: string
  /** files an Issue with `issue new`, settles it and admits it through capacity; returns its id */
  admitted(title?: string): Promise<string>
  /** the owner's note for the lead (`issue note`), with the answer the CLI printed */
  note(issue: string, text: string, options?: { wake?: boolean }): Promise<Run>
  /** one pass of the leads' loop: it starts the admitted leads, follows lost ones and runs the outbox */
  tick(): Promise<TickAnswer>
  hc(): FakeHcState
  terminals(): FakeTerminal[]
  /** `factory <args>` as the owner, or as another caller */
  cli(args: string[], as?: Caller): ReturnType<typeof factory>
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
  // The leads' worktrees live in the repo (`.claude/worktrees/`). A machine's global gitignore hides them; a clean
  // runner does not, and a scenario's `git add -A` would commit them as paths of the change.
  await Bun.write(join(repo, '.git', 'info', 'exclude'), '.claude/worktrees/\n')
  await Bun.write(join(repo, 'README.md'), '# example\n')
  await Bun.write(join(repo, 'project.yaml'), 'apiVersion: factory/v2\nname: example\nleads: 8\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'init')
  await git(repo, 'remote', 'add', 'origin', origin)
  await git(repo, 'push', '-q', 'origin', 'master')
  await git(repo, 'fetch', '-q', 'origin')

  const server = await startServer(world, {
    env: { FACTORY_REPO_ROOTS: root, FACTORY_GRACE_MS: '0', FACTORY_LEADS_PER_ACCOUNT: '16', ...env },
  })
  const flow = { world, server }
  // Admission is capacity's: the repo is a project with room for several leads, read the way the tick would.
  await must(flow, ['project', 'sync'])
  const socket = join(world.bin, 'hook.sock')
  const spool = join(world.bin, 'spool')
  const statePath = statePathOf(join(world.bin, 'calls.jsonl'))

  return {
    world,
    server,
    root,
    repo,
    socket,
    spool,
    admitted: async (title = 'the probe on /health fails') => {
      const issue = await fileIssue(flow, { repo: 'example', title })
      await admitted(flow, issue)
      return issue
    },
    note: (issue, text, options = {}) =>
      must(flow, ['issue', 'note', issue, text, ...(options.wake ? ['--wake'] : [])]),
    tick: () => tick(flow),
    hc: () => readState(statePath),
    terminals: () => Object.values(readState(statePath).terminals),
    cli: (args, as = 'owner') => factory(world, args, { FACTORY_URL: server.url }, { as }),
    hook: (event, session, input, hookEnv = {}) => hook(world, event, session, input, hookEnv),
    stop: async () => {
      await server.stop()
      await world.stop()
      await rm(root, { recursive: true, force: true })
    },
  }
}
