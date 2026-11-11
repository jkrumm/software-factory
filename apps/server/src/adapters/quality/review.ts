import * as z from 'zod'
import type { ReviewRead, UncoveredCommit } from '../../domains/quality/evidence.ts'
import type { Review } from '../../domains/quality/ports.ts'
import { err, ok, portError, type Result } from '../../kernel/result.ts'
import { childEnv, EXIT_STOPPED, EXIT_TIMEOUT, type Run, runProcess } from './process.ts'

const RouteAnswer = z.object({ tier: z.string() })
const CoveredAnswer = z.object({
  covered: z.boolean(),
  commits: z.array(
    z.object({ sha: z.string(), subject: z.string(), required: z.string(), reason: z.string().optional() }).loose(),
  ),
  uncovered: z.array(z.string()),
})

/**
 * `covered` costs seconds per commit (it routes every commit against the recent jobs), so a long range takes minutes.
 * This is a hang guard, not a budget: the ship call waits for it, and a refusal to answer in time is a recorded absence.
 * It is one limit for the whole read of every range (the batches share it), and it sits under the server's 255 s idle
 * limit with room for git and the database, since the review read runs beside the CI read and not before it.
 */
export const REVIEW_TIMEOUT_MS = 225_000

const MAX_RANGES_AT_ONCE = 4

const TIER_ORDER = ['none', 'light', 'standard', 'deep']

/**
 * agw's review commands over the ship's ranges (`agw review route` and `agw review covered`, `--format json`, no
 * model). The ledger is agw's, with one router and one coverage judgment: this only asks. Any failure is an error
 * result, which the ship records as the review's absence and never as a refusal (NL23).
 */
export class AgwReview implements Review {
  constructor(private readonly options: { bin: string; timeoutMs?: number; run?: Run; now?: () => number }) {}

  async read({ repo, ranges }: Parameters<Review['read']>[0]): Promise<Result<ReviewRead>> {
    try {
      const now = this.options.now ?? Date.now
      const deadline = now() + (this.options.timeoutMs ?? REVIEW_TIMEOUT_MS)
      const left = () => Math.max(deadline - now(), 1)
      // A few ranges at a time, two agw processes each: a ship of many ranges must not start them all at once.
      const answers: Result<ReviewRead>[] = []
      for (let at = 0; at < ranges.length; at += MAX_RANGES_AT_ONCE) {
        const batch = ranges.slice(at, at + MAX_RANGES_AT_ONCE)
        answers.push(...(await Promise.all(batch.map((range) => this.readRange(repo, range, left)))))
      }
      for (const answer of answers) if (!answer.ok) return answer
      const reads = answers.flatMap((answer) => (answer.ok ? [answer.value] : []))
      const tier = reads.reduce(
        (top, one) => (TIER_ORDER.indexOf(one.tier) > TIER_ORDER.indexOf(top) ? one.tier : top),
        'none',
      )
      return ok({
        tier,
        covered: reads.every((one) => one.covered),
        uncovered: reads.flatMap((one) => one.uncovered),
      })
    } catch (error) {
      return err(portError('unreadable', error instanceof Error ? error.message : String(error)))
    }
  }

  private async readRange(
    repo: string,
    { base, head }: { base: string; head: string },
    left: () => number,
  ): Promise<Result<ReviewRead>> {
    // Independent reads asked together, so the two limits do not add up inside the one call that waits for them.
    const [routed, covered] = await Promise.all([
      this.ask('route', ['--cwd', repo, '--base', base, '--head', head], left()),
      this.ask('covered', ['--cwd', repo, '--range', `${base}..${head}`], left()),
    ])
    if (!routed.ok) return routed
    if (!covered.ok) return covered
    const route = RouteAnswer.safeParse(routed.value)
    if (!route.success) return unexpected('route', route.error.issues[0]?.message)
    const cover = CoveredAnswer.safeParse(covered.value)
    if (!cover.success) return unexpected('covered', cover.error.issues[0]?.message)
    const bySha = new Map(cover.data.commits.map((commit) => [commit.sha, commit]))
    const uncovered = cover.data.uncovered.map((sha): UncoveredCommit => {
      const commit = bySha.get(sha)
      return {
        sha,
        subject: commit?.subject ?? '',
        required: commit?.required ?? route.data.tier,
        ...(commit?.reason ? { reason: commit.reason } : {}),
      }
    })
    return ok({ tier: route.data.tier, covered: cover.data.covered, uncovered })
  }

  private async ask(command: 'route' | 'covered', args: string[], timeoutMs: number): Promise<Result<unknown>> {
    const run = this.options.run ?? runProcess
    const done = await run([this.options.bin, 'review', command, ...args, '--format', 'json'], timeoutMs, {
      env: childEnv(),
    })
    if (done.exitCode === EXIT_TIMEOUT) return err(portError('timeout', `agw review ${command} did not answer in time`))
    if (done.exitCode === EXIT_STOPPED) return err(portError('gone', 'the server is stopping'))
    if (done.exitCode !== 0) return err(portError('refused', `agw review ${command} exited ${done.exitCode}`))
    try {
      return ok(JSON.parse(done.stdout))
    } catch {
      return err(portError('unreadable', `agw review ${command} printed no JSON`))
    }
  }
}

const unexpected = (command: string, why: string | undefined) =>
  err(portError('unreadable', `agw review ${command} answered something unexpected: ${why ?? 'unparseable'}`))
