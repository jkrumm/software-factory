import * as z from 'zod'
import { type CiLine, type CiRead, type CiState, ciStateOf } from '../../domains/quality/evidence.ts'
import type { Ci } from '../../domains/quality/ports.ts'
import { statusVerdict } from '../../kernel/checks.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import { CheckRuns, CommitStatus, githubGet } from '../github/checks.ts'
import { parseRemote } from '../intake/github.ts'
import { gitIn } from './git.ts'
import type { Run } from './process.ts'

const HTTP_TIMEOUT_MS = 15_000
const REMOTE_TIMEOUT_MS = 10_000
const PAGE_SIZE = 100
/** A ship names its commits, and a pull request is looked for through the first few only. */
const MAX_COMMITS_ASKED = 3

const Pulls = z.array(
  z.looseObject({
    number: z.number().int(),
    html_url: z.string().nullish(),
    merged_at: z.string().nullish(),
    head: z.looseObject({ sha: z.string().min(1) }),
  }),
)

export interface GithubCiOptions {
  /** `FACTORY_GITHUB_TOKEN`; without it nothing is read */
  token: string | null
  /** the API base (`FACTORY_GITHUB_API_URL`); a scenario points it at a local fake */
  apiUrl: string
  run?: Run
  fetch?: typeof fetch
}

/**
 * CI as GitHub's REST API has it, for the repo's `origin` (named by the raw `remote.origin.url`, so a rewrite of the
 * address for fetching does not hide it). Reads only; a missing token, an origin that is not github.com, a status other
 * than 200 or an unexpected body is an error result naming it. A check run or commit status in a failure state is red,
 * one not finished is running, and at least one success with none of the others is green.
 */
export function githubCi(options: GithubCiOptions): Ci {
  const api = options.apiUrl.replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch

  async function read<T>(url: string, schema: z.ZodType<T>): Promise<Result<T, PortError>> {
    const done = await githubGet(doFetch, options.token, url, schema, HTTP_TIMEOUT_MS)
    if (done.ok) return ok(done.value)
    const { failure } = done
    if (typeof failure === 'number') return err(portError('unreadable', `github ${failure}`))
    if (failure === 'unparsable') return err(portError('unreadable', 'github answered with an unexpected body'))
    return err(portError(failure === 'timeout' ? 'timeout' : 'unreadable', `github did not answer: ${failure}`))
  }

  async function slugOf(repo: string): Promise<Result<string, PortError>> {
    if (!options.token) return err(portError('refused', 'no token'))
    const done = await gitIn(repo, ['config', '--get', 'remote.origin.url'], {
      timeoutMs: REMOTE_TIMEOUT_MS,
      ...(options.run ? { run: options.run } : {}),
    }).catch(() => undefined)
    const remote = done?.exitCode === 0 ? parseRemote(done.stdout.trim()) : undefined
    if (!remote) return err(portError('refused', `${repo} has no github.com origin`))
    return ok(`${remote.owner}/${remote.name}`)
  }

  async function stateOf(slug: string, sha: string): Promise<Result<CiState, PortError>> {
    const ref = `${api}/repos/${slug}/commits/${encodeURIComponent(sha)}`
    const runs = await read(`${ref}/check-runs?filter=latest&per_page=${PAGE_SIZE}`, CheckRuns)
    if (!runs.ok) return runs
    const combined = await read(`${ref}/status?per_page=${PAGE_SIZE}`, CommitStatus)
    if (!combined.ok) return combined
    const lines: CiLine[] = [
      ...runs.value.check_runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion ?? null,
        url: run.html_url ?? null,
      })),
      ...combined.value.statuses.map((status) => {
        const verdict = statusVerdict(status.state)
        return {
          name: status.context,
          status: verdict ? 'completed' : 'pending',
          conclusion: verdict === 'green' ? 'success' : verdict === 'red' ? 'failure' : null,
          url: status.target_url ?? null,
        }
      }),
    ]
    return ok(ciStateOf(lines))
  }

  return {
    async ofShip({ repo, commits }): Promise<Result<CiRead>> {
      const slug = await slugOf(repo)
      if (!slug.ok) return slug
      for (const sha of commits.slice(0, MAX_COMMITS_ASKED)) {
        const pulls = await read(`${api}/repos/${slug.value}/commits/${encodeURIComponent(sha)}/pulls`, Pulls)
        if (!pulls.ok) return pulls
        const pull = pulls.value.find((one) => one.merged_at)
        if (!pull) continue
        const state = await stateOf(slug.value, pull.head.sha)
        if (!state.ok) return state
        return ok({
          ...state.value,
          pr: pull.number,
          headSha: pull.head.sha,
          url: state.value.url ?? pull.html_url ?? null,
        })
      }
      return ok({
        status: 'missing',
        pr: null,
        headSha: null,
        url: null,
        reason: 'no merged pull request found for the named commits (a direct push)',
      })
    },

    async ofCommit({ repo, sha }): Promise<Result<CiState>> {
      const slug = await slugOf(repo)
      if (!slug.ok) return slug
      return stateOf(slug.value, sha)
    },
  }
}
