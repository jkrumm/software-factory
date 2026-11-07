import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { InternalTestEventAnswer, type InternalTestEventBody } from '@software-factory/contract'
import { bearer, factory, type ServerProcess, startServer, startWorld, type World } from '../harness.ts'

/** What a repo of the lab has on its default branch. */
export interface RepoFiles {
  /** the text of `project.yaml`; absent: no project file */
  project?: string
  /** the text of `docs/plan.yaml` */
  plan?: string
}

export interface AccountRow {
  id: string
  five_hour?: number
  seven_day?: number
  enabled?: boolean
}

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
  /** files an Issue through the internal test route (until package 8) and returns its id */
  file(repo: string, title: string, kind?: 'feature' | 'bug' | 'incident'): Promise<string>
  /** records an event on an Issue through the internal test route */
  event(
    issue: string,
    name: string,
    kind: string,
    payload: object,
    actor?: InternalTestEventBody['actor'],
  ): Promise<string>
  /** replaces the picker's accounts (read at the next poll: `factory capacity refresh`) */
  accounts(rows: AccountRow[]): Promise<void>
  /** sets what the host's memory reads */
  memory(input: { swapUsedMb: number; swapouts?: number }): Promise<void>
  /** commits files to a repo's default branch */
  commit(repo: string, files: Record<string, string>): Promise<void>
  stop(): Promise<void>
}

const SYSCTL = (dir: string) => `#!/bin/sh
case "$2" in
  hw.pagesize) echo 16384;;
  vm.compressor.swapper.swapouts_total) cat "${dir}/swapouts";;
  hw.memsize) echo 34359738368;;
  vm.swapusage) echo "total = 40960.00M  used = $(cat "${dir}/swapused").00M  free = 1.00M  (encrypted)";;
esac
`

const PICKER = (dir: string) => `#!/bin/sh
cat "${dir}/accounts.json"
`

export async function startLab(options: {
  repos: Record<string, RepoFiles>
  accounts?: AccountRow[]
  env?: Record<string, string>
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
  }
  const picker = join(base, 'claude-account')
  const sysctl = join(base, 'sysctl')
  await writeFile(picker, PICKER(base))
  await writeFile(sysctl, SYSCTL(base))
  await chmod(picker, 0o755)
  await chmod(sysctl, 0o755)

  const accounts = async (rows: AccountRow[]) => {
    const now = Math.floor(Date.now() / 1000)
    await writeFile(
      join(base, 'accounts.json'),
      JSON.stringify({
        accounts: rows.map((r) => ({
          id: r.id,
          enabled: r.enabled ?? true,
          auth_ok: true,
          five_hour: r.five_hour ?? 10,
          seven_day: r.seven_day ?? 20,
          five_hour_resets_at: now + 3600,
          seven_day_resets_at: now + 3 * 86_400,
          // sampled at the poll itself: a later poll is a later sample, which is what frees an account for a new lead
          age_s: 0,
          exhausted_until: null,
        })),
      }),
    )
  }
  const memory = async (input: { swapUsedMb: number; swapouts?: number }) => {
    await writeFile(join(base, 'swapused'), String(input.swapUsedMb))
    await writeFile(join(base, 'swapouts'), String(input.swapouts ?? 1000))
  }
  await accounts(options.accounts ?? [{ id: 'me' }])
  await memory({ swapUsedMb: 1024 })

  const server = await startServer(world, {
    env: {
      FACTORY_INTERNAL_TEST_ROUTES: '1',
      FACTORY_REPO_ROOTS: root,
      FACTORY_CLAUDE_ACCOUNT_BIN: picker,
      FACTORY_SYSCTL_BIN: sysctl,
      FACTORY_MEMORY_SAMPLE_MS: '0',
      ...options.env,
    },
  })

  const post = async (path: string, body: InternalTestEventBody) => {
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer() },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (response.status !== 200) throw new Error(`${path} answered ${response.status}: ${text}`)
    return InternalTestEventAnswer.parse(JSON.parse(text))
  }
  let counter = 0

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
    file: async (repo, title, kind = 'feature') => {
      counter++
      const answer = await post('/internal/test/issues', {
        key: `lab:filed:${counter}`,
        kind: 'filed',
        payload: { repo, title, kind, origin: 'you' },
        actor: 'factory',
      })
      return answer.issue.id
    },
    event: async (issue, name, kind, payload, actor = 'factory') => {
      const answer = await post(`/internal/test/issues/${issue}/events`, {
        key: `lab:${issue}:${name}`,
        kind,
        payload,
        actor,
      })
      return answer.issue.state
    },
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
    },
    stop: async () => {
      await server.stop()
      await world.stop()
      await rm(base, { recursive: true, force: true })
    },
  }
}
