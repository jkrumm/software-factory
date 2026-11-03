import { stat } from 'node:fs/promises'
import {
  REVIEW_ATTEMPTS,
  REVIEWER_ROLE,
  reviewAttemptOf,
  reviewKey,
  type ReviewMeta,
  type RoleTable,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import type { Clock } from '../clock.ts'
import { CannotExecute, childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import type { ReplyReader } from '../fleet/transcript.ts'
import type { Runner } from '../runner.ts'
import { getSession } from '../sessions.ts'
import { createSpawn } from '../spawns.ts'
import { DEFAULT_REVIEW_LIMITS, type ReviewLimits } from './limits.ts'

/**
 * The review transport (docs/design.md §3 "The review transport"): agw prepares a review job and asks for one hidden reviewer session per
 * attempt (`factory spawn create review-<job>-a<n> --role reviewer …`). This is the other half: when the session's turn ends its last reply
 * goes to `agw review submit` verbatim, and the terminal is closed. A refusal gets one more attempt (`a2`) with agw's message in its prompt;
 * the second refusal, or a session that stops writing, is for a person (`needs_human`, an attention line, so an ask on /fleet). The
 * factory judges nothing in the reply; agw does.
 *
 * It runs behind the tick's back (`kick`), never inside a transaction. Every effect has a deterministic key: `agw review submit` is
 * idempotent per (job, attempt), `createSpawn` returns the row an `a2` already has, `Runner.close` finds its terminal by label, and the
 * outcome row is keyed by the attempt's spawn key and written last, so a pass that dies half-way does the rest on the next one.
 */

/** A reply is not looked for until the turn ended this long ago: the transcript may lag the Stop hook by a moment. */
export const REPLY_GRACE_MS = 15_000
/** The longest `agw review submit` may run: a host command that answers at once. */
export const SUBMIT_TIMEOUT_MS = 60_000
/** After agw did not answer (killed, not found) the attempt is asked again no sooner than this. */
export const SUBMIT_RETRY_MS = 30_000
/** What of agw's message goes into the second attempt's prompt. */
export const MAX_ERROR_CHARS = 2_000

export interface SubmitInput {
  jobId: string
  attempt: number
  /** the account the attempt's spawn started on */
  account: string
  /** the session's last reply, byte for byte */
  reply: string
}

export type Submitted =
  | { kind: 'accepted'; output: string }
  /** agw looked at the reply and said no */
  | { kind: 'refused'; error: string }
  /** agw gave no answer (not found, timed out): nothing is known, the same attempt is asked again */
  | { kind: 'unavailable'; error: string }

/** The one call into agw; the tests' fake is another implementation. */
export interface ReviewSubmitter {
  submit(input: SubmitInput): Promise<Submitted>
}

export interface AgwSubmitterOptions {
  /** the `agw` binary (`FACTORY_AGW_BIN`) */
  bin: string
  timeoutMs?: number
  run?: typeof runProcess
}

/** `agw review submit <job> --attempt <n> --account <a> --commit --format json` with the reply on stdin. */
export class AgwSubmitter implements ReviewSubmitter {
  private readonly run: typeof runProcess

  constructor(private readonly options: AgwSubmitterOptions) {
    this.run = options.run ?? runProcess
  }

  async submit({ jobId, attempt, account, reply }: SubmitInput): Promise<Submitted> {
    const command = [
      this.options.bin,
      'review',
      'submit',
      jobId,
      '--attempt',
      String(attempt),
      '--account',
      account,
      '--commit',
      '--format',
      'json',
    ]
    let result: Awaited<ReturnType<typeof runProcess>>
    try {
      result = await this.run(command, this.options.timeoutMs ?? SUBMIT_TIMEOUT_MS, childEnv(), reply, { stderr: true })
    } catch (error) {
      if (error instanceof CannotExecute) return { kind: 'unavailable', error: error.message }
      throw error
    }
    if (result.exitCode === EXIT_TIMEOUT)
      return { kind: 'unavailable', error: 'agw review submit did not answer in time' }
    if (result.exitCode === 0) return { kind: 'accepted', output: result.stdout.trim() }
    const said = (result.stderr ?? '').trim() || result.stdout.trim()
    return { kind: 'refused', error: said || `agw review submit exited ${result.exitCode}` }
  }
}

/** When a transcript was last written; undefined when it cannot be read. */
export type TranscriptClock = (path: string) => Promise<Date | undefined>
export const fileMtime: TranscriptClock = (path) =>
  stat(path).then(
    (s) => s.mtime,
    () => undefined,
  )

export interface ReviewTransportDeps {
  sql: SQL
  clock: Clock
  /** closes a reviewer's terminal by its spawn key */
  runner: Pick<Runner, 'close'>
  roles: RoleTable
  replies: ReplyReader
  submitter: ReviewSubmitter
  /** swapped by the tests; the file's modification time by default */
  mtime?: TranscriptClock
  limits?: ReviewLimits
}

interface Attempt {
  key: string
  repo: string
  space: string
  prompt: string
  account: string
  review: ReviewMeta
  attempt: number
}

export interface ReviewPassResult {
  submitted: string[]
  /** attempts that failed and now have, or had, an `a2` */
  retried: string[]
  needsHuman: string[]
  /** attempts agw no longer wants a reply for (job abandoned, or won by another attempt): closed, nothing more */
  superseded: string[]
  errors: string[]
}

const trim = (text: string): string => text.trim().slice(0, MAX_ERROR_CHARS)

/** The prompt of the second attempt: the first's, and why it is asked again. */
export const retryPrompt = (original: string, why: string): string => `${original}\n\n${why}`

/**
 * agw's ReviewError texts (host/review/submit.ts) for a job nobody waits for any more: a later `prepare` restarted its round
 * ("was abandoned"), or another attempt won it ("is already submitted by attempt N"). Retrying cannot change either.
 */
export const isSuperseded = (error: string): boolean => /\babandoned\b|already submitted by attempt/i.test(error)

const refusedWhy = (error: string): string =>
  `Your previous reply was refused by agw review submit: ${trim(error)}. Reply again with only the JSON.`

export class ReviewTransport {
  private running: Promise<unknown> | undefined
  /** an attempt agw did not answer for: not asked again before this time (in memory: a restart asks at once) */
  private readonly askAgainAt = new Map<string, number>()

  constructor(private readonly deps: ReviewTransportDeps) {}

  /** The tick's call. Never throws and never waits for the pass; one pass at a time. */
  kick(): void {
    if (this.running) return
    this.running = this.pass()
      .then((result) => {
        if (result.errors.length) console.error('review transport', result.errors)
      })
      .catch((error: unknown) =>
        console.error('review transport failed', error instanceof Error ? error.message : error),
      )
      .finally(() => {
        this.running = undefined
      })
  }

  /** Waits for the pass in flight: shutdown and the tests. */
  async settled(): Promise<void> {
    await this.running
  }

  /** One pass over the reviewer sessions that have no outcome yet. */
  async pass(): Promise<ReviewPassResult> {
    const { sql } = this.deps
    const result: ReviewPassResult = { submitted: [], retried: [], needsHuman: [], superseded: [], errors: [] }
    const rows: {
      key: string
      repo: string
      space: string
      prompt: string
      account: string | null
      review_job: string
      review_tier: ReviewMeta['tier']
      review_effort: ReviewMeta['effort']
    }[] = await sql`
      SELECT key, repo, COALESCE(space, repo) AS space, prompt, account, review_job, review_tier, review_effort
      FROM factory.spawns s
      WHERE role = ${REVIEWER_ROLE} AND status = 'started' AND review_job IS NOT NULL AND account IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM factory.review_outcomes o WHERE o.spawn_key = s.key)
      ORDER BY created_at, key`
    for (const row of rows) {
      const attempt = reviewAttemptOf(row.key, row.review_job)
      if (attempt === null || row.account === null) continue
      const review = { jobId: row.review_job, tier: row.review_tier, effort: row.review_effort }
      try {
        await this.one(
          { key: row.key, repo: row.repo, space: row.space, prompt: row.prompt, account: row.account, review, attempt },
          result,
        )
      } catch (error) {
        result.errors.push(`${row.key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return result
  }

  private async one(a: Attempt, result: ReviewPassResult): Promise<void> {
    const { sql, clock } = this.deps
    const now = clock.now()
    const session = await getSession(sql, a.key, now)
    if (!session) return
    // Gone: the terminal is lost (`pane_gone`) or the runner restarted while the turn was open. A reviewer is never resumed (its terminal is not
    // kept, the rules skip it), so its attempt failed and a fresh session takes the next one. A turn that had ended before is still collected.
    const closedTurn =
      session.state === 'idle' ? session.turn >= 1 : session.state === 'dead' && (await this.turnEnded(a.key))
    if (closedTurn) return this.collect(a, session, now, result)
    if (session.state === 'dead' || (await this.restartedSince(a.key))) {
      const why = 'Your previous session was lost before it replied. Reply with only the JSON.'
      return this.failed(a, 'idle', 'the session was lost before its turn ended', why, result)
    }
    // Walled: a usage limit stopped it and nothing resumes a reviewer, so the attempt is over at once (it would hold its slot for ever).
    if (session.state === 'walled') {
      const why = 'Your previous session hit a usage limit and was closed. Reply with only the JSON.'
      return this.failed(a, 'walled', 'the session hit a usage limit', why, result)
    }
    const idleMs = (this.deps.limits ?? DEFAULT_REVIEW_LIMITS).idleMs
    // Silent from the start: no first turn within the idle limit of its last event (or its creation).
    if (session.state === 'starting' || (session.state === 'idle' && session.turn === 0)) {
      if (now.getTime() - Date.parse(session.lastEventAt) < idleMs) return
      const why = `Your previous session never started its turn within ${Math.round(idleMs / 60_000)} minutes and was closed. Reply with only the JSON.`
      return this.failed(a, 'idle', `no turn started within ${Math.round(idleMs / 60_000)} min`, why, result)
    }
    // The turn is open. No wall-clock cap on the work itself: only a transcript that stopped growing is judged.
    if (session.state !== 'working' && session.state !== 'stuck' && session.state !== 'blocked') return
    const written = session.transcriptPath ? await (this.deps.mtime ?? fileMtime)(session.transcriptPath) : undefined
    const last = Math.max(written?.getTime() ?? 0, Date.parse(session.since ?? session.lastEventAt))
    if (now.getTime() - last < idleMs) return
    const why = `Your previous session wrote nothing for ${Math.round(idleMs / 60_000)} minutes and was closed. Reply with only the JSON.`
    await this.failed(a, 'idle', `no output for ${Math.round(idleMs / 60_000)} min`, why, result)
  }

  /** The turn ended (or the session is gone): its last reply goes to agw. */
  private async collect(
    a: Attempt,
    session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
    now: Date,
    result: ReviewPassResult,
  ): Promise<void> {
    const reply = session.transcriptPath ? await this.deps.replies.lastReply(session.transcriptPath) : null
    if (reply === null) {
      const settledMs = now.getTime() - Date.parse(session.since ?? session.lastEventAt)
      if (session.state !== 'dead' && settledMs < REPLY_GRACE_MS) return
      const why = 'Your previous session ended without a reply. Reply with only the JSON.'
      return this.failed(a, 'idle', 'the session ended without a reply in its transcript', why, result)
    }
    if ((this.askAgainAt.get(a.key) ?? 0) > now.getTime()) return
    const answer = await this.deps.submitter.submit({
      jobId: a.review.jobId,
      attempt: a.attempt,
      account: a.account,
      reply,
    })
    if (answer.kind === 'unavailable') {
      this.askAgainAt.set(a.key, now.getTime() + SUBMIT_RETRY_MS)
      result.errors.push(`${a.key}: ${answer.error}`)
      return
    }
    if (answer.kind === 'refused' && isSuperseded(answer.error)) {
      await this.deps.runner.close(a.key)
      await this.record(a, 'superseded', trim(answer.error))
      result.superseded.push(a.key)
      return
    }
    if (answer.kind === 'refused') return this.failed(a, 'refused', answer.error, refusedWhy(answer.error), result)
    await this.deps.runner.close(a.key)
    await this.record(a, 'submitted', answer.output)
    result.submitted.push(a.key)
  }

  /** The attempt did not produce a review: its terminal is closed, then one more attempt, or a person. */
  private async failed(
    a: Attempt,
    outcome: 'refused' | 'idle' | 'walled',
    detail: string,
    why: string,
    result: ReviewPassResult,
  ): Promise<void> {
    await this.deps.runner.close(a.key)
    if (a.attempt >= REVIEW_ATTEMPTS) {
      await this.record(a, 'needs_human', `${outcome}: ${trim(detail)}`)
      result.needsHuman.push(a.key)
      return
    }
    const entry = this.deps.roles.get(REVIEWER_ROLE)
    if (!entry) throw new Error(`the role table has no ${REVIEWER_ROLE}`)
    await createSpawn(
      this.deps.sql,
      {
        key: reviewKey(a.review.jobId, a.attempt + 1),
        repo: a.repo,
        space: a.space,
        prompt: retryPrompt(a.prompt, why),
        role: REVIEWER_ROLE,
        tier: entry.tier,
        effort: entry.effort,
        placement: 'hidden',
        review: a.review,
      },
      this.deps.clock.now(),
      this.deps.limits,
    )
    await this.record(a, outcome, trim(detail))
    result.retried.push(a.key)
  }

  /** Whether the session's last turn event is a `turn_ended`. */
  private async turnEnded(key: string): Promise<boolean> {
    const [row]: { kind: string }[] = await this.deps.sql`
      SELECT kind FROM factory.events WHERE session = ${key} AND kind IN ('turn_started', 'turn_ended') ORDER BY at DESC, id DESC LIMIT 1`
    return row?.kind === 'turn_ended'
  }

  /** Whether the runner (herdr-core) restarted after this session's last start: its terminal, not kept, went with it. */
  private async restartedSince(key: string): Promise<boolean> {
    const [row]: { restarted: boolean }[] = await this.deps.sql`
      SELECT EXISTS (
        SELECT 1 FROM factory.events r
        WHERE r.session = '_runner' AND r.kind = 'runner_restarted'
          AND r.at > (SELECT max(at) FROM factory.events WHERE session = ${key} AND kind = 'session_started')
      ) AS restarted`
    return row?.restarted === true
  }

  private async record(
    a: Attempt,
    outcome: 'submitted' | 'refused' | 'idle' | 'walled' | 'needs_human' | 'superseded',
    detail: string,
  ): Promise<void> {
    await this.deps.sql`
      INSERT INTO factory.review_outcomes (spawn_key, job_id, attempt, outcome, detail, at)
      VALUES (${a.key}, ${a.review.jobId}, ${a.attempt}, ${outcome}, ${detail}, ${this.deps.clock.now()})
      ON CONFLICT (spawn_key) DO NOTHING`
  }
}
