import * as z from 'zod'
import { type PrLook, prNumber, type ReviewPort } from '../../domains/loops/reviews.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import { childEnv, type Run, runProcess } from '../quality/process.ts'

const TIMEOUT_MS = 30_000

const Person = z.looseObject({ login: z.string().nullish(), username: z.string().nullish() })
const nameOf = (person: z.infer<typeof Person> | null | undefined): string | null =>
  person?.login ?? person?.username ?? null

/** `gh pr view --json state,reviewDecision,reviews,comments,author`. */
const GithubPr = z.looseObject({
  state: z.string(),
  reviewDecision: z.string().nullish(),
  author: Person.nullish(),
  reviews: z.array(z.looseObject({ author: Person.nullish(), state: z.string().nullish() })).default([]),
  comments: z.array(z.looseObject({ author: Person.nullish() })).default([]),
})

/** `glab mr view -F json`: the merge request as the host's API has it. Approvals are read where the output carries them. */
const MergeRequest = z.looseObject({
  state: z.string(),
  author: Person.nullish(),
  user_notes_count: z.number().int().nullish(),
  approved_by: z.array(z.unknown()).nullish(),
})

function githubLook(raw: unknown): PrLook | null {
  const parsed = GithubPr.safeParse(raw)
  if (!parsed.success) return null
  const pr = parsed.data
  const author = nameOf(pr.author)
  const byOthers = <T extends { author?: z.infer<typeof Person> | null | undefined }>(items: T[]): T[] =>
    items.filter((item) => nameOf(item.author) !== author)
  const reviews = byOthers(pr.reviews)
  const decided = pr.reviewDecision ?? ''
  // A repo that requires no review has no decision: an approval then is an approving review nobody has asked for again
  const decision =
    decided === 'APPROVED'
      ? 'approved'
      : decided === 'CHANGES_REQUESTED'
        ? 'changes_requested'
        : decided === 'REVIEW_REQUIRED'
          ? 'review_required'
          : reviews.some((review) => review.state === 'CHANGES_REQUESTED')
            ? 'changes_requested'
            : reviews.some((review) => review.state === 'APPROVED')
              ? 'approved'
              : 'none'
  const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open'
  return { state, decision, others: reviews.length + byOthers(pr.comments).length }
}

function mergeRequestLook(raw: unknown): PrLook | null {
  const parsed = MergeRequest.safeParse(raw)
  if (!parsed.success) return null
  const mr = parsed.data
  const state = mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open'
  return {
    state,
    decision: (mr.approved_by?.length ?? 0) > 0 ? 'approved' : 'none',
    others: mr.user_notes_count ?? 0,
  }
}

export interface PrReviewOptions {
  run?: Run
  /** the `gh` config directory for a work repo (`FACTORY_GH_CONFIG_DIR_WORK`): its account is not the owner's */
  workGhConfigDir?: string | null
}

/**
 * The review poll's reads, through the host's own tools: `gh pr view` for GitHub, `glab mr view` for merge requests, run in the
 * repo's checkout so the repo and its account come from the checkout. Reads only. A tool that is missing, fails or answers
 * with something else is an error result naming it, never a wake.
 */
export function prReview(options: PrReviewOptions = {}): ReviewPort {
  const run = options.run ?? runProcess

  async function remoteOf(cwd: string): Promise<string> {
    const done = await run(['git', '-C', cwd, 'config', '--get', 'remote.origin.url'], 10_000).catch(() => undefined)
    return done?.exitCode === 0 ? done.stdout.trim() : ''
  }

  return {
    async look({ cwd, ref, work }): Promise<Result<PrLook, PortError>> {
      const named = /^https?:\/\//.test(ref) ? ref : null
      const mergeRequest =
        named !== null
          ? /\/-\/merge_requests\/|gitlab/i.test(named)
          : cwd !== null && /gitlab/i.test(await remoteOf(cwd))
      if (named === null && cwd === null) {
        return err(portError('unreadable', `${ref} names no repo checkout to look in`))
      }
      const target = named ?? prNumber(ref)
      // a ref the tool would read as a flag is never passed on
      if (target.startsWith('-')) return err(portError('refused', `${ref} is not a pull request`))
      const command = mergeRequest
        ? ['glab', 'mr', 'view', target, '-F', 'json']
        : ['gh', 'pr', 'view', target, '--json', 'state,reviewDecision,reviews,comments,author']
      // a URL names its repo; a bare number is the checkout's
      const where = cwd === null ? command : ['sh', '-c', 'cd "$1" && shift && exec "$@"', 'sh', cwd, ...command]
      const env = childEnv(
        !mergeRequest && work && options.workGhConfigDir ? { GH_CONFIG_DIR: options.workGhConfigDir } : {},
      )
      let done
      try {
        done = await run(where, TIMEOUT_MS, { env })
      } catch (cause) {
        return err(portError('unreadable', `${command[0]} did not start: ${String(cause).slice(0, 200)}`))
      }
      if (done.exitCode !== 0)
        return err(portError('unreadable', `${command[0]} exited ${done.exitCode} for ${target}`))
      let raw: unknown
      try {
        raw = JSON.parse(done.stdout)
      } catch {
        return err(portError('unreadable', `${command[0]} did not answer with JSON for ${target}`))
      }
      const look = mergeRequest ? mergeRequestLook(raw) : githubLook(raw)
      return look
        ? ok(look)
        : err(portError('unreadable', `${command[0]} answered with an unexpected body for ${target}`))
    },
  }
}
