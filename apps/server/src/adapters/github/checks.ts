import * as z from 'zod'

/** The check-runs and combined-status answers of GitHub's REST API, shared by intake and the quality CI read. */
export const CheckRuns = z.looseObject({
  check_runs: z.array(
    z.looseObject({
      name: z.string(),
      head_sha: z.string(),
      status: z.string(),
      conclusion: z.string().nullish(),
      html_url: z.string().nullish(),
    }),
  ),
})

export const CommitStatus = z.looseObject({
  sha: z.string(),
  statuses: z.array(z.looseObject({ context: z.string(), state: z.string(), target_url: z.string().nullish() })),
})

/** The headers of an authenticated GitHub REST call. */
export const githubHeaders = (token: string | null): Record<string, string> => ({
  Authorization: `Bearer ${token ?? ''}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'software-factory',
})

/** Why a read gave no usable answer: the status, or the kind of failure, never a body. */
export type GithubReadFailure = number | 'timeout' | 'error' | 'unparsable'

/** One 200 JSON answer in the shape asked for. */
export async function githubGet<T>(
  doFetch: typeof fetch,
  token: string | null,
  url: string,
  schema: z.ZodType<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; failure: GithubReadFailure }> {
  let response: Response
  try {
    response = await doFetch(url, { headers: githubHeaders(token), signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    return { ok: false, failure: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error' }
  }
  if (response.status !== 200) return { ok: false, failure: response.status }
  const parsed = schema.safeParse(await response.json().catch(() => undefined))
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, failure: 'unparsable' }
}
