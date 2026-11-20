import type { ZodType } from 'zod'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import { gitIn, type Run } from '../process.ts'
import { githubGet, type GithubReadFailure } from './checks.ts'

/** GitHub's REST API; the one place its address is written. */
export const GITHUB_API = 'https://api.github.com'

const HTTP_TIMEOUT_MS = 15_000
const REMOTE_TIMEOUT_MS = 10_000
const NAME = /^[A-Za-z0-9._-]+$/

export const plainName = (name: string): boolean => NAME.test(name) && !/^\.+$/.test(name)

/**
 * `owner/name` of an `origin` that is github.com over https (a `user@` or `user:token@` part is allowed and dropped) or
 * ssh; anything else is not ours to poll.
 */
export function parseRemote(url: string): { owner: string; name: string } | undefined {
  const found =
    /^https:\/\/(?:[^/@\s]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
  const [, owner, name] = found ?? []
  if (!owner || !name || !plainName(owner) || !plainName(name)) return undefined
  return { owner, name }
}

export interface GithubReaderOptions {
  /** `FACTORY_GITHUB_TOKEN`; without it nothing is read */
  token: string | null
  /** the API base (`FACTORY_GITHUB_API_URL`); a scenario points it at a local fake */
  apiUrl: string
  /** the repo's main checkout, whose `origin` names the GitHub repository; the repo itself is a path when absent */
  locate?(repo: string): Promise<Result<string>>
  run?: Run
  fetch?: typeof fetch
}

/**
 * A failed read as the error it is, naming only the status or the kind of failure, never a body. A rate limit passes by
 * itself; a 403 or 404 is the token not seeing the repo: it stays so until the token or the repo changes.
 */
function readError(failure: GithubReadFailure, limited: boolean): PortError {
  if (typeof failure === 'number') {
    if (limited) return portError('timeout', `github ${failure} (rate limited)`)
    return portError(failure === 403 || failure === 404 ? 'refused' : 'unreadable', `github ${failure}`)
  }
  if (failure === 'unparsable') return portError('unreadable', 'github answered with an unexpected body')
  return portError(failure === 'timeout' ? 'timeout' : 'unreadable', `github did not answer: ${failure}`)
}

/** The one GitHub REST read: a GET with the token, a timeout and PortError results, and the `owner/name` of a repo's origin. */
export function githubReader(options: GithubReaderOptions) {
  const api = options.apiUrl.replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch

  async function read<T>(url: string, schema: ZodType<T>): Promise<Result<T, PortError>> {
    const done = await githubGet(doFetch, options.token, url, schema, HTTP_TIMEOUT_MS)
    return done.ok ? ok(done.value) : err(readError(done.failure, done.limited === true))
  }

  /** `owner/name` of the repo's `origin`, read from the raw `remote.origin.url` so a rewrite for fetching does not hide it. */
  async function slugOf(repo: string): Promise<Result<string, PortError>> {
    if (!options.token) return err(portError('refused', 'no token'))
    const located = options.locate ? await options.locate(repo) : ok(repo)
    if (!located.ok) return located
    const done = await gitIn(located.value, ['config', '--get', 'remote.origin.url'], {
      timeoutMs: REMOTE_TIMEOUT_MS,
      ...(options.run ? { run: options.run } : {}),
    }).catch(() => undefined)
    const remote = done?.exitCode === 0 ? parseRemote(done.stdout.trim()) : undefined
    if (!remote) return err(portError('refused', `${repo} has no github.com origin`))
    return ok(`${remote.owner}/${remote.name}`)
  }

  return { api, read, slugOf }
}
