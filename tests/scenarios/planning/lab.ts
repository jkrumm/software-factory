import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileIncident, fileIssue } from '../flow.ts'
import { factory, type ServerProcess, startServer, startWorld, type World } from '../harness.ts'
import { type AccountRow, setAccounts, setMemory } from '../host.ts'

/** What a repo of the lab has on its default branch. */
export interface RepoFiles {
  /** the text of `project.yaml`; absent: no project file */
  project?: string
  /** the text of `docs/plan.yaml` */
  plan?: string
}

export type { AccountRow }

const git = async (cwd: string, ...args: string[]) => {
  const proc = Bun.spawn(['git', '-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  const [err, code] = await Promise.all([proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${err}`)
}

/** `{ error: … }` of a failed command, as the CLI prints it on stderr. */
export interface CliFailure {
  kind: string
  code: string | null
  message: string
  hint: string
  details: Record<string, unknown>
}

export interface CliResult {
  code: number
  out: string
  err: string
  /** stdout as JSON, when it is */
  json: unknown
  /** the error line on stderr of a failed command */
  failure: CliFailure | null
}

/**
 * A server process with real git repos under a repo root, a fake account picker and a fake `sysctl` it reads memory
 * from, so a scenario sets the windows and the memory the way the host would show them. Nothing here reaches the host's
 * own `hc`, `agw`, accounts or memory.
 */
export interface Lab {
  world: World
  server: ServerProcess
  /** the repo root, after `realpath` */
  root: string
  /** runs `factory <args>` against the server */
  cli(args: string[], env?: Record<string, string>): Promise<CliResult>
  /** files an Issue and returns its id: `issue new` for a feature, a door alert for an incident */
  file(repo: string, title: string, kind?: 'feature' | 'incident'): Promise<string>
  /** replaces the picker's accounts (read at the next poll: `factory capacity refresh`) */
  accounts(rows: AccountRow[]): Promise<void>
  /** sets what the host's memory reads */
  memory(input: { swapUsedMb: number; swapouts?: number }): Promise<void>
  /** commits files to a repo's default branch */
  commit(repo: string, files: Record<string, string>): Promise<void>
  stop(): Promise<void>
}

export async function startLab(options: {
  repos: Record<string, RepoFiles>
  accounts?: AccountRow[]
  env?: Record<string, string>
  /** gives every repo a bare `origin` with its default branch pushed, so a lead can start in a worktree of it */
  leads?: boolean
}): Promise<Lab> {
  const world = await startWorld()
  const base = await mkdtemp('/tmp/factory-lab-')
  const root = await realpath(await mkdir(join(base, 'src'), { recursive: true }).then(() => join(base, 'src')))
  for (const [name, files] of Object.entries(options.repos)) {
    const path = join(root, name)
    await mkdir(path, { recursive: true })
    await git(path, 'init', '-q', '-b', 'main')
    await writeFile(join(path, 'README.md'), name)
    if (files.project) await writeFile(join(path, 'project.yaml'), files.project)
    if (files.plan) {
      await mkdir(join(path, 'docs'), { recursive: true })
      await writeFile(join(path, 'docs', 'plan.yaml'), files.plan)
    }
    await git(path, 'add', '-A')
    await git(path, 'commit', '-q', '-m', 'init')
    if (!options.leads) continue
    const origin = join(base, 'origins', `${name}.git`)
    await mkdir(origin, { recursive: true })
    await git(origin, 'init', '-q', '--bare', '-b', 'main')
    await git(path, 'remote', 'add', 'origin', origin)
    await git(path, 'push', '-q', 'origin', 'main')
    await git(path, 'fetch', '-q', 'origin')
  }

  const accounts = (rows: AccountRow[]) => setAccounts(world.bin, rows)
  const memory = (input: { swapUsedMb: number; swapouts?: number }) => setMemory(world.bin, input)
  await accounts(options.accounts ?? [{ id: 'me' }])
  await memory({ swapUsedMb: 1024 })

  const server = await startServer(world, {
    env: {
      FACTORY_REPO_ROOTS: root,
      // a lost terminal is noticed at the next pass
      FACTORY_GRACE_MS: '0',
      ...options.env,
    },
  })

  const flow = { world, server }

  return {
    world,
    server,
    root,
    cli: async (args, env = {}) => {
      const result = await factory(world, args, { FACTORY_URL: server.url, ...env })
      let json: unknown = null
      try {
        json = result.out.trim() ? JSON.parse(result.out) : null
      } catch {
        // plain output
      }
      let failure: CliFailure | null = null
      try {
        failure = result.err.trim() ? (JSON.parse(result.err) as { error: CliFailure }).error : null
      } catch {
        // not an error line
      }
      return { ...result, json, failure }
    },
    file: (repo, title, kind = 'feature') =>
      kind === 'incident' ? fileIncident(flow, { repo, title }) : fileIssue(flow, { repo, title }),
    accounts,
    memory,
    commit: async (repo, files) => {
      const path = join(root, repo)
      for (const [file, text] of Object.entries(files)) {
        await mkdir(join(path, file, '..'), { recursive: true })
        await writeFile(join(path, file), text)
      }
      await git(path, 'add', '-A')
      await git(path, 'commit', '-q', '-m', 'update')
      if (options.leads) await git(path, 'push', '-q', 'origin', 'main')
    },
    stop: async () => {
      await server.stop()
      await world.stop()
      await rm(base, { recursive: true, force: true })
    },
  }
}
