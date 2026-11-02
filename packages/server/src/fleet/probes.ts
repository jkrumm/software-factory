import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { GitReader } from './git.ts'

/**
 * The triage's probes: read-only, bounded, and run in the fleet build (off the tick, in no transaction). A probe answers a question
 * about the world, or `undefined` when it cannot tell (an unreachable machine, a timeout): that is never evidence of anything.
 */
export interface Probes {
  /** Whether a path exists on a machine; `undefined` for a machine that is not configured or does not answer. */
  exists(machine: string, path: string): Promise<boolean | undefined>
  /** Whether the repo's default branch has moved past the commit (a newer deploy of the same repo). */
  newerDeploy(repo: string, sha: string): Promise<{ head: string } | false | undefined>
}

export const PROBE_TIMEOUT_MS = 5_000
/** An answer is reused this long: the build runs every 30 s and a probe can be an ssh round trip. */
export const PROBE_TTL_MS = 5 * 60_000

/** What a probe may be asked about a path: no shell syntax, no glob, no control characters. */
export const SAFE_PATH = /^(?:~\/|\/)[\w@+ ./-]*$/
const HOST = /^[A-Za-z0-9][\w.-]*$/

/** `macbook=<ssh alias>,mini=local` (`FACTORY_PROBE_HOSTS`): the machines a probe may look at; an alias is a Host of the owner's ssh config. */
export function parseProbeHosts(value: string | undefined): Map<string, string> {
  const hosts = new Map<string, string>()
  for (const part of (value ?? '').split(',')) {
    const [name, host] = part.split('=').map((x) => x.trim())
    if (!name || !host) continue
    if (!/^[\w-]+$/.test(name) || (host !== 'local' && !HOST.test(host)))
      throw new Error(`FACTORY_PROBE_HOSTS: "${part.trim()}" is not <name>=<ssh alias|local>`)
    hosts.set(name.toLowerCase(), host)
  }
  return hosts
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

export class ProbeRunner implements Probes {
  private readonly cache = new Map<string, { at: number; value: boolean | undefined }>()

  constructor(
    private readonly options: {
      hosts: ReadonlyMap<string, string>
      home: string
      now?: () => Date
      run?: typeof runProcess
      git?: GitReader
    },
  ) {}

  private get run(): typeof runProcess {
    return this.options.run ?? runProcess
  }

  async exists(machine: string, path: string): Promise<boolean | undefined> {
    const host = this.options.hosts.get(machine.toLowerCase())
    if (!host || !SAFE_PATH.test(path)) return undefined
    const key = `${host}\0${path}`
    const now = (this.options.now?.() ?? new Date()).getTime()
    const hit = this.cache.get(key)
    if (hit && now - hit.at < PROBE_TTL_MS) return hit.value
    const value = host === 'local' ? await this.local(path) : await this.remote(host, path)
    this.cache.set(key, { at: now, value })
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value as string)
    return value
  }

  private async local(path: string): Promise<boolean | undefined> {
    const real = path.startsWith('~/') ? join(this.options.home, path.slice(2)) : path
    try {
      await stat(real)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined
    }
  }

  /** `ssh <alias> test -e <path>`: 0 present, 1 absent, anything else (ssh's 255, a timeout) says nothing. Batch mode: never a prompt. */
  private async remote(host: string, path: string): Promise<boolean | undefined> {
    const target = path.startsWith('~/') ? `"$HOME"/${quote(path.slice(2))}` : quote(path)
    const done = await this.run(
      ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, `test -e ${target}`],
      PROBE_TIMEOUT_MS,
      childEnv(),
    )
    if (done.exitCode === EXIT_TIMEOUT) return undefined
    return done.exitCode === 0 ? true : done.exitCode === 1 ? false : undefined
  }

  newerDeploy(repo: string, sha: string): Promise<{ head: string } | false | undefined> {
    return (this.options.git ?? new GitReader(this.run)).newerThan(repo, sha).catch(() => undefined)
  }
}
