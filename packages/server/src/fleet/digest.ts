import { createHash } from 'node:crypto'
import type { FleetDigest } from '@software-factory/contract'
import { NO_DIGEST } from '@software-factory/contract'
import type { SQL } from 'bun'
import { z } from 'zod'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { getSession } from '../sessions.ts'
import { boundReply, cleanHeading, head, LIMIT, line, tail, wellFormed } from './digest-text.ts'
import { plainText } from '../read/plain.ts'
import { FileReplies, type ReplyReader } from './transcript.ts'

/**
 * The digest (docs/design.md §11 "The fleet view"): short titles for plan headings, a headline per session and "does the last
 * message ask the owner something?" per settled turn. The factory never calls a model (SF2): this is one `agw digest` call per
 * pass for what changed, off the tick and outside any transaction, and a cache table that the snapshot reads.
 *
 * Nothing of a visible (IuRoot) repo, plan or session is ever an item: the feed (`DigestFeed`) is built without them, and no
 * other path reaches `collect`.
 */

/** What `agw digest` takes: at most 64 items and 120,000 characters of text in a call; more is refused, never cut. */
export const MAX_ITEMS = 64
export const MAX_BATCH_CHARS = 120_000

export const DEFAULT_EVERY_MS = 5 * 60_000
/**
 * A hang guard on one `agw` process, not a budget (`rules/agent-limits.md`: a single LLM request is never cut short; the guard is at
 * least 30 minutes). `agw` itself waits for a run for its own budget and then answers "pending" with the run's id (exit 10).
 */
export const HANG_GUARD_MS = 30 * 60_000
/** Whatever is wrong with a whole call, its items are asked about again after this long. */
export const CALL_RETRY_MS = 15 * 60_000
/** An item whose own answer came back as an error: this long, doubled with every error in a row, at most a day. */
const ERROR_BASE_MS = 5 * 60_000
const ERROR_MAX_MS = 24 * 3_600_000
const errorBackoffMs = (errors: number): number => Math.min(ERROR_BASE_MS * 2 ** (errors - 1), ERROR_MAX_MS)
/** A batch that failed twice in a row is retried in halves, so one poison item ends up alone. */
const batchCap = (failures: number, failedBatch: number): number =>
  failures < 2 ? MAX_ITEMS : Math.max(1, Math.floor(failedBatch / 2))
/** Waits for a pending run that fail in a row (without `agw` saying the run failed) before the run is let go. */
export const WAITS_FAILED_MAX = 3
/** A cache row that no current item wants is dropped after this long. */
const KEEP_UNWANTED_MS = 7 * 24 * 3_600_000
const KEEP_RUNS_MS = 14 * 24 * 3_600_000
const EXCERPT = 1_200
const DAYS_SHOWN = 7
const REASON_MAX = 500

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const hash = (text: string, length = 16): string => createHash('sha256').update(text).digest('hex').slice(0, length)
export const reasonText = (reason: string): string => head(wellFormed(reason), REASON_MAX)

export type ItemKind = 'heading' | 'session' | 'reply' | 'line' | 'about'

export const headingKey = (text: string): string => `heading:${hash(text, 12)}`
export const sessionKey = (id: string): string => `session:${id}`
export const replyKey = (id: string): string => `reply:${id}`
export const lineKey = (sent: string): string => `line:${hash(sent, 12)}`
/** One row per Issue: a changed title or goal replaces the answer (the fingerprint is the text that was sent). */
export const aboutKey = (issue: number): string => `about:${issue}`

/** Longest goal text that is kept and sent for an Issue's `about`. */
const GOAL_MAX = 800

/**
 * The filed goal of each of these Issues, head-capped: the first of `facts.goal | request | text | description` that is a string.
 * Facts are free-form data, so an Issue with none has no entry. Read in the database, so a 32 KiB facts column is never loaded.
 */
export async function loadGoals(sql: SQL, ids: readonly number[]): Promise<Map<number, string>> {
  const goals = new Map<number, string>()
  if (ids.length === 0) return goals
  const rows: { id: number; goal: string | null }[] = await sql`
    SELECT id, left(COALESCE(facts->>'goal', facts->>'request', facts->>'text', facts->>'description'), ${GOAL_MAX * 2}) AS goal
    FROM factory.issues WHERE id IN ${sql(ids)}`
  for (const row of rows) {
    const goal = row.goal?.replace(/\s+/g, ' ').trim()
    if (goal) goals.set(row.id, head(wellFormed(goal), GOAL_MAX))
  }
  return goals
}

/**
 * What is sent for an Issue's `about`: the filed title and goal under a context line. agw reads it as a `session`, and the answer's
 * `headline` is the sentence on what the Issue is for. It depends on the filed text alone, so the read API finds the answer again.
 */
export const aboutText = (title: string, goal: string | null): string =>
  head(
    wellFormed(`Role: Issue request\nLast message: ${cleanHeading(title)}${goal ? `\n${head(goal, GOAL_MAX)}` : ''}`),
    LIMIT.session,
  )

/**
 * What is sent for an ask or a health line: its plain words (no ids) under a context line. It depends on the raw text alone, so the
 * read API finds the answer from the same text, and one text is one answer for every line that has it. agw reads it as a `session`.
 * An elapsed time (`for 17 min`, `for 3 h`) is rebuilt into a line at every build: it is left out, or each minute would be a new
 * item and a new call, and the stored answer would never be found again (the model's own `lineKey` leaves it out for the same reason).
 */
export const lineText = (raw: string): string =>
  head(
    wellFormed(
      `Role: ask or health line\nLast message: ${plainText(raw).replace(/\b\d+(\.\d+)? (h|min)\b/g, 'a while')}`,
    ),
    LIMIT.session,
  )

// --- the feed: what the builder offers ---------------------------------------------------------------------------

/** A session the digest may read: its repo, plan and place are all ordinary (the builder leaves every visible one out). */
export interface FeedSession {
  id: string
  /** turns started: only a session the factory knows is offered (a terminal only hc knows has no turn count or transcript on record, and no digest headline) */
  turn: number
  /** the turn has ended: idle or waiting */
  settled: boolean
  transcriptPath: string | null
  /** since when it is in this state: the time of a reply ask */
  since: string | null
  title: string | null
  role: string | null
  repo: string
  plan: string | null
  wave: string | null
}

export interface DigestFeed {
  /** plan and wave headings with no `<!-- short: … -->`, of ordinary repos only */
  headings: string[]
  sessions: FeedSession[]
  /** the raw text of an ask or a health line the digest may read (`scopeOf` decides); none when absent */
  lines?: readonly string[]
  /** the filed title and goal of the open Issues of ordinary repos (`scopeOf` decides): their `about` */
  abouts?: readonly { issue: number; title: string; goal: string | null }[]
  /** every source was read in the build that made this feed; a partial one (hc down, a plan unreadable) must not make the cache forget rows */
  complete: boolean
}

// --- the answers, as stored and as agw gives them ------------------------------------------------------------------

const Short = line(120)
const Headline = line(240)
const HeadingAnswer = z.object({ short: Short })
const SessionAnswer = z.object({ short: Short, headline: Headline })
const ReplyAnswer = z.object({
  asks: z.boolean(),
  kind: z.enum(['blocker', 'question', 'permission', 'note']),
  short: Short,
  confidence: z.enum(['high', 'medium', 'low']),
})

/** What a row of `factory.fleet_digest` holds in `answer`: agw's answer plus the turn it was made for. */
const StoredHeading = HeadingAnswer
const StoredSession = SessionAnswer.extend({ turn: z.number().int().nullable() })
const StoredLine = SessionAnswer
const StoredReply = ReplyAnswer.extend({ turn: z.number().int(), at: z.string(), text: z.string() })
export type StoredReply = z.infer<typeof StoredReply>

interface CacheRow {
  fingerprint: string
  answer: unknown
  at: Date
}

/** What the snapshot reads: the cache, parsed. A row that does not parse is as if it were not there. */
export class DigestView {
  constructor(
    private readonly rows: ReadonlyMap<string, CacheRow> = new Map(),
    readonly stats: FleetDigest = NO_DIGEST,
  ) {}

  heading(text: string): string | null {
    const parsed = StoredHeading.safeParse(this.rows.get(headingKey(cleanHeading(text)))?.answer)
    return parsed.success ? parsed.data.short : null
  }

  headline(sessionId: string): string | null {
    const parsed = StoredSession.safeParse(this.rows.get(sessionKey(sessionId))?.answer)
    return parsed.success ? parsed.data.headline : null
  }

  /** The words of an ask or a health line, from its raw text: `summary` is the digest's headline. */
  line(raw: string): { short: string; summary: string } | null {
    const parsed = StoredLine.safeParse(this.rows.get(lineKey(lineText(raw)))?.answer)
    return parsed.success ? { short: parsed.data.short, summary: parsed.data.headline } : null
  }

  /** What the Issue is for, when the stored answer is for its current title and goal. */
  about(issue: number, title: string, goal: string | null): string | null {
    const row = this.rows.get(aboutKey(issue))
    if (row?.fingerprint !== hash(aboutText(title, goal))) return null
    const parsed = StoredLine.safeParse(row.answer)
    return parsed.success ? parsed.data.headline : null
  }

  reply(sessionId: string): StoredReply | null {
    const parsed = StoredReply.safeParse(this.rows.get(replyKey(sessionId))?.answer)
    return parsed.success ? parsed.data : null
  }
}

/** The cache alone, for a reader that makes no build (the read API): the answers as stored, no spend figures, never a call. */
export async function readDigestCache(sql: SQL): Promise<DigestView> {
  const rows: { key: string; fingerprint: string; answer: unknown; at: Date }[] =
    await sql`SELECT key, fingerprint, answer, at FROM factory.fleet_digest`
  return new DigestView(new Map(rows.map((r) => [r.key, { fingerprint: r.fingerprint, answer: r.answer, at: r.at }])))
}

// --- the items ----------------------------------------------------------------------------------------------------

/** One item of a batch: what was sent (`id`, `kind`, `text`), and what its answer is stored under. Kept as is while its run is pending. */
const BatchItem = z.object({
  id: z.string(),
  key: z.string(),
  kind: z.enum(['heading', 'session', 'reply', 'line', 'about']),
  text: z.string(),
  /** the content that was sent: what the cache compares */
  fingerprint: z.string(),
  /** the session's turn the answer is for; headings have none */
  turn: z.number().int().nullable(),
  at: z.string().nullable(),
})
type BatchItem = z.infer<typeof BatchItem>

interface Item extends Omit<BatchItem, 'id'> {
  /** calls in a row that failed with it (`fleet_digest_backoff`): a suspect is asked about with fewer companions */
  failures: number
  /** the most companions a call with it may have */
  cap: number
}

/** A cached answer whose content did not change but whose turn did: only the turn (and the ask's time) moves, no model. */
interface Touch {
  key: string
  patch: { turn: number; at?: string }
}

/** Why an item is waiting before it is asked about again; for the turn it was for (a newer turn starts over). */
interface BackoffRow {
  turn: number | null
  /** calls in a row that failed with it */
  failures: number
  /** the size of the batch it last failed in */
  batch: number
  /** answers in a row that came back as an error */
  errors: number
  retryAt: Date
}

function sessionText(s: FeedSession, last: string): string {
  const lines = [
    s.title ? `Tab title: ${s.title}` : '',
    s.role ? `Role: ${s.role}` : '',
    `Repo: ${s.repo}`,
    s.plan ? `Plan: ${s.plan}` : '',
    s.wave ? `Wave: ${s.wave}` : '',
    `Last message: ${tail(wellFormed(last).trim(), EXCERPT)}`,
  ].filter(Boolean)
  return head(wellFormed(lines.join('\n')), LIMIT.session)
}

// --- the call -----------------------------------------------------------------------------------------------------

/** `agw` exits 10 for a run that is still going, 4 for a run it does not know. */
export const EXIT_PENDING = 10
export const EXIT_NOT_FOUND = 4
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{5,127}$/

/** The id of a pending run, from the JSON `agw` printed with exit 10. */
export function runIdOf(stdout: string): string | undefined {
  try {
    const body = JSON.parse(stdout) as Record<string, unknown>
    const run = body.run as Record<string, unknown> | undefined
    const id = body.runId ?? body.run_id ?? run?.id ?? body.id
    return typeof id === 'string' && RUN_ID.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

/** A run's status as `agw` reports it: `pending | running | done | failed | cancelled`. */
export const statusOf = (stdout: string): string | undefined => {
  try {
    const status = (JSON.parse(stdout) as { status?: unknown }).status
    return typeof status === 'string' ? status : undefined
  } catch {
    return undefined
  }
}
export const isTerminal = (status: string | undefined): boolean => status === 'failed' || status === 'cancelled'

export const Envelope = z.object({
  output: z.object({ results: z.array(z.object({ id: z.string() }).loose()) }).loose(),
  cost: z.number().nullish(),
})

type Reply =
  | { kind: 'done'; answers: Map<string, Record<string, unknown>>; cost: number | null }
  | { kind: 'pending'; runId: string | undefined }
  | { kind: 'hung' }

/**
 * A call that failed. `terminal`: `agw` says the run itself failed or was cancelled, which is the only thing that makes the retry a
 * new run. `unknown`: `agw` does not know the run. Anything else (an exit with no status) says nothing about the run.
 */
export class CallFailed extends Error {
  constructor(
    message: string,
    readonly kind: 'terminal' | 'unknown' | 'unclear' = 'unclear',
  ) {
    super(message)
  }
}

export interface DigestDeps {
  sql: SQL
  now: () => Date
  /** the `agw` binary (`FACTORY_AGW_BIN`) */
  bin: string
  /** a pass at most this often */
  everyMs?: number
  /** the hang guard of one `agw` process; past it the process is killed (`HANG_GUARD_MS`) */
  hangGuardMs?: number
  /** swapped by the tests */
  run?: typeof runProcess
  replies?: ReplyReader
  /** a session's turn and whether it has ended, as of now: asked again after its transcript was read */
  session?: (id: string) => Promise<{ turn: number; settled: boolean } | undefined>
}

export interface PassResult {
  /** `agw digest` was called */
  called: boolean
  /** items in the call */
  sent: number
  /** answers stored */
  stored: number
  /** items that came back as an error */
  failedItems: number
  /** changed items left for the next pass */
  waiting: number
  /** a run is pending: the batch is fixed to it and no other call is made until it ends */
  pending?: boolean
  /** the call failed: the model stays as it was */
  error?: string
}

interface Journal {
  ok: boolean
  items: number
  failedItems?: number
  cost?: number | null
  error?: string | null
  /** the batch's hash and whether `agw` ended its run for good: they decide the next call's idempotency key */
  batchHash?: string
  terminal?: boolean
}

/** What a failed call does besides backing its items off. */
interface Failure {
  waiting?: number
  /** the run was pending: let it go */
  clearPending?: boolean
  terminal?: boolean
}

const batchHashOf = (batch: readonly BatchItem[]): string =>
  hash(JSON.stringify(batch.map(({ id, kind, text }) => ({ id, kind, text }))), 24)

/**
 * The digest's one writer. `kick(feed)` is the builder's call after a snapshot: a pass starts behind its back when one is due
 * and none runs. A pass keeps a fingerprint per item (the content it would send) and asks about the changed ones only, at most
 * 64, oldest answers first, in one call.
 *
 * The call is one `agw` run. Its idempotency key is the batch's hash and the count of that batch's runs `agw` ended for good, so a
 * hang, a kill or an exit that says nothing about the run asks again for the same run, never a second paid one. A run `agw` has not
 * finished (exit 10) is kept with its batch (`fleet_digest_pending`) and the following passes only wait for it (`agw run wait`).
 * What goes wrong with a whole call gives its items a flat wait, and a batch that failed twice in a row is retried in halves; what
 * goes wrong with one item's answer gives that item an exponential wait. The model stays as it was.
 */
export class Digest {
  private running: Promise<unknown> | undefined
  private lastStart = 0
  private readonly run: typeof runProcess
  private readonly replies: ReplyReader

  constructor(private readonly deps: DigestDeps) {
    this.run = deps.run ?? runProcess
    this.replies = deps.replies ?? new FileReplies()
  }

  /** The cache and the spend, for a build. */
  async view(): Promise<DigestView> {
    const { sql } = this.deps
    const rows: { key: string; fingerprint: string; answer: unknown; at: Date }[] =
      await sql`SELECT key, fingerprint, answer, at FROM factory.fleet_digest`
    const days: { day: string; calls: number; failed: number; items: number; cost: string | null }[] = await sql`
      SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS calls,
             count(*) FILTER (WHERE NOT ok)::int AS failed, COALESCE(sum(items), 0)::int AS items, sum(cost_usd)::text AS cost
      FROM factory.fleet_digest_runs GROUP BY 1 ORDER BY 1 DESC LIMIT ${DAYS_SHOWN}`
    const [last]: { at: Date; ok: boolean; error: string | null }[] = await sql`
      SELECT at, ok, error FROM factory.fleet_digest_runs ORDER BY id DESC LIMIT 1`
    const [pending]: { run_id: string }[] = await sql`SELECT run_id FROM factory.fleet_digest_pending WHERE id = 1`
    return new DigestView(
      new Map(rows.map((r) => [r.key, { fingerprint: r.fingerprint, answer: r.answer, at: r.at }])),
      {
        enabled: true,
        pending: pending !== undefined,
        lastAt: last?.at.toISOString() ?? null,
        lastError: last && !last.ok ? (last.error ?? 'failed') : null,
        days: days.map((d) => ({
          day: d.day,
          calls: d.calls,
          failed: d.failed,
          items: d.items,
          costUsd: Number(d.cost ?? 0),
        })),
      },
    )
  }

  /** The builder's call. Never throws and never waits for the pass. */
  kick(feed: DigestFeed): void {
    const now = this.deps.now().getTime()
    if (this.running || now - this.lastStart < (this.deps.everyMs ?? DEFAULT_EVERY_MS)) return
    this.lastStart = now
    this.running = this.pass(feed)
      .catch((error: unknown) => console.error('fleet digest failed', message(error)))
      .finally(() => {
        this.running = undefined
      })
  }

  /** Waits for the pass in flight: shutdown and the tests. */
  async settled(): Promise<void> {
    await this.running
  }

  /** One pass now. Throws only for the database; a failed call is in the result. */
  async pass(feed: DigestFeed): Promise<PassResult> {
    const { sql } = this.deps
    const now = this.deps.now()
    const [pending]: { run_id: string; batch: unknown; waits_failed: number }[] =
      await sql`SELECT run_id, batch, waits_failed FROM factory.fleet_digest_pending WHERE id = 1`
    if (pending) return this.resume(pending.run_id, pending.batch, pending.waits_failed)

    const cached = new Map<string, CacheRow>()
    for (const r of await sql`SELECT key, fingerprint, answer, at FROM factory.fleet_digest`) {
      cached.set(r.key, { fingerprint: r.fingerprint, answer: r.answer, at: r.at })
    }
    const backoff = new Map<string, BackoffRow>()
    for (const r of await sql`SELECT key, turn, failures, batch, errors, retry_at FROM factory.fleet_digest_backoff`) {
      backoff.set(r.key, { turn: r.turn, failures: r.failures, batch: r.batch, errors: r.errors, retryAt: r.retry_at })
    }
    const { items, touches, wanted } = await this.collect(feed, cached, backoff, now)
    for (const t of touches) {
      await sql`UPDATE factory.fleet_digest SET answer = answer || ${JSON.stringify(t.patch)}::text::jsonb WHERE key = ${t.key}`
    }
    await this.prune(feed.complete ? wanted : undefined, cached, now)
    if (items.length === 0) return { called: false, sent: 0, stored: 0, failedItems: 0, waiting: 0 }

    // Items that never failed come first, then by fewest failures, then the oldest answers: a suspect waits behind the healthy ones and
    // joins a batch only while the batch is no bigger than its cap, so one poison item never starves the rest. A batch is what one call
    // takes, the rest waits for the next pass.
    const age = (i: Item) => cached.get(i.key)?.at.getTime() ?? 0
    items.sort((a, b) => a.failures - b.failures || age(a) - age(b) || a.key.localeCompare(b.key))
    const picked: Item[] = []
    let chars = 0
    let limit = MAX_ITEMS
    for (const item of items) {
      limit = Math.min(limit, item.cap)
      if (picked.length >= limit || chars + item.text.length > MAX_BATCH_CHARS) break
      picked.push(item)
      chars += item.text.length
    }
    const waiting = items.length - picked.length
    if (picked.length === 0) return { called: false, sent: 0, stored: 0, failedItems: 0, waiting }
    const batch: BatchItem[] = picked.map(({ failures: _f, cap: _c, ...item }, i) => ({ ...item, id: `i${i}` }))
    return this.start(batch, waiting)
  }

  /** A new call for a batch. */
  private async start(batch: BatchItem[], waiting: number): Promise<PassResult> {
    const { sql } = this.deps
    const batchHash = batchHashOf(batch)
    const [ended]: { n: number }[] = await sql`
      SELECT count(*)::int AS n FROM factory.fleet_digest_runs WHERE batch_hash = ${batchHash} AND terminal`
    const key = `factory-digest-${batchHash}-${ended?.n ?? 0}`
    // agw's digest knows heading, session, reply and window: a line and an about are asked as a session (a title and one sentence).
    const stdin = JSON.stringify(
      batch.map(({ id, kind, text }) => ({
        id,
        kind: kind === 'line' || kind === 'about' ? 'session' : kind,
        text,
      })),
    )
    let reply: Reply
    try {
      reply = await this.exec([this.deps.bin, 'digest', '--format', 'json', '--idempotency-key', key], stdin)
    } catch (error) {
      const terminal = error instanceof CallFailed && error.kind === 'terminal'
      return this.failBatch(batch, message(error), { waiting, terminal })
    }
    if (reply.kind === 'hung') return this.failBatch(batch, 'agw digest hung past the guard', { waiting })
    if (reply.kind === 'pending') {
      if (!reply.runId) return this.failBatch(batch, 'agw says the run is pending but names no run id', { waiting })
      await sql`
        INSERT INTO factory.fleet_digest_pending (id, run_id, batch, started_at, waits_failed)
        VALUES (1, ${reply.runId}, ${JSON.stringify(batch)}::text::jsonb, ${this.deps.now()}, 0)
        ON CONFLICT (id) DO UPDATE SET run_id = EXCLUDED.run_id, batch = EXCLUDED.batch, started_at = EXCLUDED.started_at,
          waits_failed = 0`
      return { called: true, sent: batch.length, stored: 0, failedItems: 0, waiting, pending: true }
    }
    return this.finish(batch, reply, { waiting })
  }

  /**
   * A pass with a pending run: only waits for it. Pending is not a failure. A wait that fails without `agw` saying why is journalled
   * each time and the run is let go on the third in a row; `agw` saying the run failed, was cancelled or is unknown ends it at once.
   */
  private async resume(runId: string, stored: unknown, waitsFailed: number): Promise<PassResult> {
    const parsed = z.array(BatchItem).safeParse(stored)
    if (!parsed.success) return this.failBatch([], 'the pending batch does not parse', { clearPending: true })
    const batch = parsed.data
    const still = { called: false, sent: batch.length, stored: 0, failedItems: 0, waiting: 0, pending: true }
    let reply: Reply
    try {
      reply = await this.exec([this.deps.bin, 'run', 'wait', runId, '--format', 'json'])
    } catch (error) {
      const kind = error instanceof CallFailed ? error.kind : 'unclear'
      if (kind === 'terminal') return this.failBatch(batch, message(error), { clearPending: true, terminal: true })
      if (kind === 'unknown') {
        return this.failBatch(batch, `${message(error)}: agw does not know the run`, { clearPending: true })
      }
      return this.waitFailed(batch, waitsFailed, message(error))
    }
    if (reply.kind === 'hung') return this.waitFailed(batch, waitsFailed, 'agw run wait hung past the guard')
    if (reply.kind === 'pending') {
      if (waitsFailed > 0) await this.deps.sql`UPDATE factory.fleet_digest_pending SET waits_failed = 0 WHERE id = 1`
      return still
    }
    return this.finish(batch, reply, { clearPending: true })
  }

  private async waitFailed(batch: BatchItem[], before: number, reason: string): Promise<PassResult> {
    const failed = before + 1
    if (failed >= WAITS_FAILED_MAX) {
      return this.failBatch(batch, `${reason} (${failed} waits in a row)`, { clearPending: true })
    }
    await this.deps.sql.begin(async (tx) => {
      await tx`UPDATE factory.fleet_digest_pending SET waits_failed = ${failed} WHERE id = 1`
      await this.journal(tx, { ok: false, items: batch.length, error: reason, batchHash: batchHashOf(batch) })
    })
    return { called: false, sent: batch.length, stored: 0, failedItems: 0, waiting: 0, pending: true, error: reason }
  }

  /**
   * The answers of a finished call. Each is stored under a savepoint of its own: an answer the database refuses is that item's error
   * and the others are kept. The journal row, the cost and (for a pending run) the end of the wait go in the same transaction.
   */
  private async finish(
    batch: BatchItem[],
    reply: Extract<Reply, { kind: 'done' }>,
    where: Pick<Failure, 'waiting' | 'clearPending'>,
  ): Promise<PassResult> {
    const { sql } = this.deps
    const now = this.deps.now()
    const answered: BatchItem[] = []
    const refused: BatchItem[] = []
    try {
      await sql.begin(async (tx) => {
        answered.length = 0
        refused.length = 0
        for (const item of batch) {
          const answer = parseAnswer(item, reply.answers.get(item.id))
          if (!answer) {
            refused.push(item)
            continue
          }
          try {
            await tx.savepoint(async (sp) => {
              await sp`
                INSERT INTO factory.fleet_digest (key, fingerprint, answer, at)
                VALUES (${item.key}, ${item.fingerprint}, ${JSON.stringify(answer)}::text::jsonb, ${now})
                ON CONFLICT (key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, answer = EXCLUDED.answer, at = EXCLUDED.at`
            })
            answered.push(item)
          } catch {
            refused.push(item)
          }
        }
        if (answered.length > 0) {
          await tx`DELETE FROM factory.fleet_digest_backoff WHERE key IN ${tx(answered.map((i) => i.key))}`
        }
        await this.backOffAnswers(tx, refused)
        // A call whose every item was refused answered nothing: it counts as a failed pass.
        const ok = answered.length > 0
        await this.journal(tx, {
          ok,
          items: batch.length,
          failedItems: refused.length,
          cost: reply.cost,
          error: ok ? null : 'no item of the call was answered',
          batchHash: batchHashOf(batch),
        })
        if (where.clearPending) await tx`DELETE FROM factory.fleet_digest_pending WHERE id = 1`
      })
    } catch (error) {
      // The transaction itself failed (the database): nothing of it is kept, and the call is a failed one.
      return this.failBatch(batch, `the answers could not be stored: ${message(error)}`, where)
    }
    const ok = answered.length > 0
    return {
      called: true,
      sent: batch.length,
      stored: answered.length,
      failedItems: refused.length,
      waiting: where.waiting ?? 0,
      ...(ok ? {} : { error: 'no item of the call was answered' }),
    }
  }

  /** A call that failed: its items wait a flat quarter of an hour (and a batch that failed twice in a row is halved), the pass is journalled as failed. */
  private async failBatch(batch: BatchItem[], reason: string, failure: Failure = {}): Promise<PassResult> {
    await this.deps.sql.begin(async (tx) => {
      await this.backOffCall(tx, batch)
      await this.journal(tx, {
        ok: false,
        items: batch.length,
        error: reason,
        batchHash: batch.length > 0 ? batchHashOf(batch) : undefined,
        terminal: failure.terminal,
      })
      if (failure.clearPending) await tx`DELETE FROM factory.fleet_digest_pending WHERE id = 1`
    })
    return { called: true, sent: batch.length, stored: 0, failedItems: 0, waiting: failure.waiting ?? 0, error: reason }
  }

  private async backoffOf(sql: SQL, items: readonly BatchItem[]): Promise<Map<string, BackoffRow>> {
    if (items.length === 0) return new Map()
    const rows: {
      key: string
      turn: number | null
      failures: number
      batch: number
      errors: number
      retry_at: Date
    }[] =
      await sql`SELECT key, turn, failures, batch, errors, retry_at FROM factory.fleet_digest_backoff WHERE key IN ${sql(items.map((i) => i.key))}`
    return new Map(
      rows.map((r) => [
        r.key,
        { turn: r.turn, failures: r.failures, batch: r.batch, errors: r.errors, retryAt: r.retry_at },
      ]),
    )
  }

  private async setBackoff(
    sql: SQL,
    item: BatchItem,
    row: Pick<BackoffRow, 'failures' | 'batch' | 'errors'> & { waitMs: number },
  ): Promise<void> {
    // From the time of the failure, not of the pass: a call can run for minutes before it fails.
    const retryAt = new Date(this.deps.now().getTime() + row.waitMs)
    await sql`
      INSERT INTO factory.fleet_digest_backoff (key, turn, failures, batch, errors, retry_at)
      VALUES (${item.key}, ${item.turn}, ${row.failures}, ${row.batch}, ${row.errors}, ${retryAt})
      ON CONFLICT (key) DO UPDATE SET turn = EXCLUDED.turn, failures = EXCLUDED.failures, batch = EXCLUDED.batch,
        errors = EXCLUDED.errors, retry_at = EXCLUDED.retry_at`
  }

  /** A whole call failed: every item of it waits `CALL_RETRY_MS` and has one more failure in a row (for the same turn; a newer turn starts over). */
  private async backOffCall(sql: SQL, batch: readonly BatchItem[]): Promise<void> {
    const before = await this.backoffOf(sql, batch)
    for (const item of batch) {
      const prior = before.get(item.key)?.turn === item.turn ? before.get(item.key) : undefined
      await this.setBackoff(sql, item, {
        failures: (prior?.failures ?? 0) + 1,
        batch: batch.length,
        errors: prior?.errors ?? 0,
        waitMs: CALL_RETRY_MS,
      })
    }
  }

  /** Items whose own answer came back as an error (or that the database refused): each waits longer than the time before, up to a day. */
  private async backOffAnswers(sql: SQL, items: readonly BatchItem[]): Promise<void> {
    const before = await this.backoffOf(sql, items)
    for (const item of items) {
      const prior = before.get(item.key)?.turn === item.turn ? before.get(item.key) : undefined
      const errors = (prior?.errors ?? 0) + 1
      await this.setBackoff(sql, item, {
        failures: prior?.failures ?? 0,
        batch: prior?.batch ?? 1,
        errors,
        waitMs: errorBackoffMs(errors),
      })
    }
  }

  private async collect(
    feed: DigestFeed,
    cached: ReadonlyMap<string, CacheRow>,
    backoff: ReadonlyMap<string, BackoffRow>,
    now: Date,
  ): Promise<{ items: Item[]; touches: Touch[]; wanted: Set<string> }> {
    const items: Item[] = []
    const touches: Touch[] = []
    const wanted = new Set<string>()
    const waitingFor = (key: string, turn: number | null): BackoffRow | undefined => {
      const row = backoff.get(key)
      return row?.turn === turn ? row : undefined
    }
    /** Waiting before it is asked about again: nothing is read or looked up for it. */
    const blocked = (key: string, turn: number | null): boolean => {
      const row = waitingFor(key, turn)
      return row !== undefined && row.retryAt.getTime() > now.getTime()
    }
    const offer = (item: Omit<Item, 'failures' | 'cap'>) => {
      if (cached.get(item.key)?.fingerprint === item.fingerprint || blocked(item.key, item.turn)) return
      const row = waitingFor(item.key, item.turn)
      items.push({ ...item, failures: row?.failures ?? 0, cap: row ? batchCap(row.failures, row.batch) : MAX_ITEMS })
    }

    for (const raw of feed.headings) {
      const text = cleanHeading(raw)
      if (!text) continue
      const key = headingKey(text)
      // One item per heading text, however many plans have it.
      if (wanted.has(key)) continue
      wanted.add(key)
      offer({ key, kind: 'heading', text, fingerprint: hash(text), turn: null, at: null })
    }

    for (const raw of feed.lines ?? []) {
      const text = lineText(raw)
      const key = lineKey(text)
      // One item per text, however many lines have it.
      if (wanted.has(key)) continue
      wanted.add(key)
      offer({ key, kind: 'line', text, fingerprint: hash(text), turn: null, at: null })
    }

    for (const a of feed.abouts ?? []) {
      const key = aboutKey(a.issue)
      wanted.add(key)
      const text = aboutText(a.title, a.goal)
      offer({ key, kind: 'about', text, fingerprint: hash(text), turn: null, at: null })
    }

    const current =
      this.deps.session ??
      (async (id: string) => {
        const live = await getSession(this.deps.sql, id, this.deps.now())
        return live ? { turn: live.turn, settled: live.state === 'idle' || live.state === 'waiting' } : undefined
      })
    for (const s of feed.sessions) {
      const skey = sessionKey(s.id)
      const rkey = replyKey(s.id)
      wanted.add(skey)
      wanted.add(rkey)
      // A turn that has not ended has no reply yet: the headline and the ask stay what they were until it does.
      if (!s.settled || s.turn < 1 || !s.transcriptPath) continue
      const sessionRow = StoredSession.safeParse(cached.get(skey)?.answer)
      const replyRow = StoredReply.safeParse(cached.get(rkey)?.answer)
      const needSession = (!sessionRow.success || sessionRow.data.turn !== s.turn) && !blocked(skey, s.turn)
      const needReply = (!replyRow.success || replyRow.data.turn !== s.turn) && !blocked(rkey, s.turn)
      if (!needSession && !needReply) continue
      const last = await this.replies.lastReply(s.transcriptPath)
      if (!last) continue
      // The feed is a few seconds old and a transcript is read live: a session that went on in between has another turn's last message.
      const live = await current(s.id)
      if (!live || live.turn !== s.turn || !live.settled) continue
      const at = s.since ?? now.toISOString()
      if (needSession) {
        const text = sessionText(s, last)
        const item = { key: skey, kind: 'session' as const, text, fingerprint: hash(text), turn: s.turn, at: null }
        if (cached.get(skey)?.fingerprint === item.fingerprint) touches.push({ key: skey, patch: { turn: s.turn } })
        else offer(item)
      }
      if (needReply) {
        const text = boundReply(last)
        const item = { key: rkey, kind: 'reply' as const, text, fingerprint: hash(text), turn: s.turn, at }
        if (cached.get(rkey)?.fingerprint === item.fingerprint) touches.push({ key: rkey, patch: { turn: s.turn, at } })
        else offer(item)
      }
    }
    return { items, touches, wanted }
  }

  /** One `agw` process: `done` with its answers, `pending` with the run's id, `hung` past the guard. Anything else throws a `CallFailed`. */
  private async exec(cmd: string[], stdin?: string): Promise<Reply> {
    const result = await this.run(cmd, this.deps.hangGuardMs ?? HANG_GUARD_MS, childEnv(), stdin)
    const what = `agw ${cmd[1]}`
    if (result.exitCode === EXIT_TIMEOUT) return { kind: 'hung' }
    if (result.exitCode === EXIT_PENDING) return { kind: 'pending', runId: runIdOf(result.stdout) }
    const status = statusOf(result.stdout)
    if (result.exitCode === EXIT_NOT_FOUND) throw new CallFailed(`${what} exited ${result.exitCode}`, 'unknown')
    if (result.exitCode !== 0) {
      throw new CallFailed(`${what} exited ${result.exitCode}`, isTerminal(status) ? 'terminal' : 'unclear')
    }
    if (isTerminal(status)) throw new CallFailed(`the digest run is ${status}`, 'terminal')
    if (status !== undefined && status !== 'done') return { kind: 'pending', runId: runIdOf(result.stdout) }
    let body: unknown
    try {
      body = JSON.parse(result.stdout)
    } catch {
      throw new CallFailed(`${what} printed no JSON`)
    }
    const parsed = Envelope.safeParse(body)
    if (!parsed.success)
      throw new CallFailed(`${what} answered an unexpected shape: ${parsed.error.issues[0]?.message}`)
    // An id we did not send is dropped, a repeat keeps the first.
    const answers = new Map<string, Record<string, unknown>>()
    for (const r of parsed.data.output.results) if (!answers.has(r.id)) answers.set(r.id, r)
    return { kind: 'done', answers, cost: parsed.data.cost ?? null }
  }

  private async journal(sql: SQL, run: Journal): Promise<void> {
    await sql`
      INSERT INTO factory.fleet_digest_runs (at, ok, items, failed_items, cost_usd, error, batch_hash, terminal)
      VALUES (${this.deps.now()}, ${run.ok}, ${run.items}, ${run.failedItems ?? 0}, ${run.cost ?? null},
              ${run.error ? reasonText(run.error) : null}, ${run.batchHash ?? null}, ${run.terminal ?? false})`
  }

  /** Rows no item wants any more (a heading rewritten, a session gone), once they have been unwanted for a week (not on a partial feed); old journal and backoff rows. */
  private async prune(
    wanted: ReadonlySet<string> | undefined,
    cached: ReadonlyMap<string, CacheRow>,
    now: Date,
  ): Promise<void> {
    const { sql } = this.deps
    const stale = wanted
      ? [...cached.entries()]
          .filter(([key, row]) => !wanted.has(key) && now.getTime() - row.at.getTime() > KEEP_UNWANTED_MS)
          .map(([key]) => key)
      : []
    if (stale.length > 0) await sql`DELETE FROM factory.fleet_digest WHERE key IN ${sql(stale)}`
    // A run agw ended for good stays: its count is the attempt in the next call's key.
    await sql`DELETE FROM factory.fleet_digest_runs WHERE at < ${new Date(now.getTime() - KEEP_RUNS_MS)} AND NOT terminal`
    await sql`DELETE FROM factory.fleet_digest_backoff WHERE retry_at < ${new Date(now.getTime() - KEEP_UNWANTED_MS)}`
  }
}

/** The stored form of one item's answer, or `undefined` when agw's answer is missing, an error or breaks the item's schema. */
function parseAnswer(item: BatchItem, raw: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!raw || 'error' in raw) return undefined
  if (item.kind === 'heading') {
    const parsed = HeadingAnswer.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }
  if (item.kind === 'line' || item.kind === 'about') {
    const parsed = StoredLine.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }
  if (item.kind === 'session') {
    const parsed = SessionAnswer.safeParse(raw)
    return parsed.success ? { ...parsed.data, turn: item.turn } : undefined
  }
  const parsed = ReplyAnswer.safeParse(raw)
  if (!parsed.success || item.turn === null) return undefined
  // What the ask shows: the end of the message, where the question is.
  return { ...parsed.data, turn: item.turn, at: item.at ?? '', text: tail(item.text, 1_000) }
}

/** The failed passes of the last 24 h, for `factory status` (the table exists once the migrations have run, which is before anything reads it). */
export async function digestFailures(sql: SQL, now: Date): Promise<number> {
  const [row]: { n: number }[] = await sql`
    SELECT count(*)::int AS n FROM factory.fleet_digest_runs WHERE NOT ok AND at >= ${new Date(now.getTime() - 24 * 3_600_000)}`
  return row?.n ?? 0
}
