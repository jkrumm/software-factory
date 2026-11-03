import { z } from 'zod'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'

const Tier = z.enum(['none', 'light', 'standard', 'deep'])
export type ReviewTier = z.infer<typeof Tier>

/** One commit the review ledger does not cover, with the tier it needs; `reason` is agw's, set when a review exists but its thread still has open important findings. */
export interface UncoveredCommit {
  sha: string
  subject: string
  required: ReviewTier
  reason?: string
}

/** What review v4 says of a range: the tier it requires and whether every commit in it is reviewed at its own. */
export interface ReviewRead {
  tier: ReviewTier
  covered: boolean
  uncovered: UncoveredCommit[]
}

/** The review ledger is agw's (one router, one coverage judgment): this port only asks. Called outside any transaction. */
export interface Review {
  read(input: { repo: string; base: string; head: string }): Promise<ReviewRead>
}

export class ReviewFailed extends Error {}

const RouteAnswer = z.object({ tier: Tier })
const CoveredAnswer = z.object({
  covered: z.boolean(),
  commits: z.array(
    z.object({ sha: z.string(), subject: z.string(), required: Tier, reason: z.string().optional() }).loose(),
  ),
  uncovered: z.array(z.string()),
})

/** Both are host reads: they answer at once and never exit 10. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 60_000

export interface AgwReviewOptions {
  /** the `agw` binary (`FACTORY_AGW_BIN`) */
  bin: string
  timeoutMs?: number
  /** swapped by the tests */
  run?: typeof runProcess
}

/**
 * `agw review route` and `agw review covered` (`--format json`, no model). Any failure throws `ReviewFailed`: the ship gate refuses on
 * it, it never passes.
 */
export class AgwReview implements Review {
  private readonly run: typeof runProcess

  constructor(private readonly options: AgwReviewOptions) {
    this.run = options.run ?? runProcess
  }

  async read({ repo, base, head }: { repo: string; base: string; head: string }): Promise<ReviewRead> {
    const { tier } = this.parse(
      RouteAnswer,
      'route',
      await this.ask('route', ['--cwd', repo, '--base', base, '--head', head]),
    )
    const covered = this.parse(
      CoveredAnswer,
      'covered',
      await this.ask('covered', ['--cwd', repo, '--range', `${base}..${head}`]),
    )
    const bySha = new Map(covered.commits.map((commit) => [commit.sha, commit]))
    const uncovered = covered.uncovered.map((sha): UncoveredCommit => {
      const commit = bySha.get(sha)
      return {
        sha,
        subject: commit?.subject ?? '',
        required: commit?.required ?? tier,
        ...(commit?.reason ? { reason: commit.reason } : {}),
      }
    })
    return { tier, covered: covered.covered, uncovered }
  }

  private parse<T>(schema: z.ZodType<T>, command: string, body: unknown): T {
    const parsed = schema.safeParse(body)
    if (!parsed.success)
      throw new ReviewFailed(`agw review ${command} answered something unexpected: ${parsed.error.issues[0]?.message}`)
    return parsed.data
  }

  private async ask(command: 'route' | 'covered', args: string[]): Promise<unknown> {
    const result = await this.run(
      [this.options.bin, 'review', command, ...args, '--format', 'json'],
      this.options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
      childEnv(),
    )
    if (result.exitCode === EXIT_TIMEOUT) throw new ReviewFailed(`agw review ${command} did not answer in time`)
    if (result.exitCode !== 0) throw new ReviewFailed(`agw review ${command} exited ${result.exitCode}`)
    try {
      return JSON.parse(result.stdout)
    } catch {
      throw new ReviewFailed(`agw review ${command} printed no JSON`)
    }
  }
}
