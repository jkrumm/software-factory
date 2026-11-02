import { createHash } from 'node:crypto'
import type { FleetDigest } from '@software-factory/contract'
import { NO_DIGEST } from '@software-factory/contract'
import type { SQL } from 'bun'
import { z } from 'zod'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { getSession } from '../sessions.ts'
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
const LIMIT = { heading: 300, session: 2_000, reply: 4_000 } as const

export const DEFAULT_EVERY_MS = 5 * 60_000
/**
 * A hang guard on one `agw` process, not a budget (`rules/agent-limits.md`: a single LLM request is never cut short; the guard is at
 * least 30 minutes). `agw` itself waits for a run for its own budget and then answers "pending" with the run's id (exit 10).
 */
export const HANG_GUARD_MS = 30 * 60_000
/** An item that failed is asked about again after this long, doubled with every failure, at most a day (persisted: `fleet_digest_backoff`). */
const BACKOFF_BASE_MS = 5 * 60_000
const BACKOFF_MAX_MS = 24 * 3_600_000
/** A run that has not ended after this long is let go (a lifecycle deadline, not a limit on a request: `agw` has its own watchdog far below it). */
export const PENDING_MAX_MS = 24 * 3_600_000
const backoffMs = (failures: number): number => Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS)
/** A batch that has failed twice is halved with every further failure, so one poison item is isolated in a few steps. */
const batchCap = (failures: number, failedBatch: number): number =>
  failures < 2 ? MAX_ITEMS : Math.max(1, Math.floor(failedBatch / 2))
/** A cache row that no current item wants is dropped after this long. */
const KEEP_UNWANTED_MS = 7 * 24 * 3_600_000
const KEEP_RUNS_MS = 14 * 24 * 3_600_000
const EXCERPT = 1_200
const DAYS_SHOWN = 7

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Postgres refuses NUL and a lone surrogate in jsonb: a text goes in and out of the cache only without them. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
export const wellFormed = (text: string): string => text.replace(LONE_SURROGATE, '\uFFFD').replaceAll('\0', '')
/**
 * The first / last `n` UTF-16 units of a well-formed text (agw counts its limits in them), never through the middle of a surrogate
 * pair: a cut that lands inside one drops the half that is left.
 */
export function head(text: string, n: number): string {
  if (text.length <= n) return text
  const cut = text.slice(0, n)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}
export function tail(text: string, n: number): string {
  if (text.length <= n) return text
  const cut = text.slice(text.length - n)
  return /^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut
}
const hash = (text: string, length = 16): string => createHash('sha256').update(text).digest('hex').slice(0, length)

export type ItemKind = 'heading' | 'session' | 'reply'

export const headingKey = (text: string): string => `heading:${hash(text, 12)}`
export const sessionKey = (id: string): string => `session:${id}`
export const replyKey = (id: string): string => `reply:${id}`

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
  /** every source was read in the build that made this feed; a partial one (hc down, a plan unreadable) must not make the cache forget rows */
  complete: boolean
}

// --- the answers, as stored and as agw gives them ------------------------------------------------------------------

/** Model text that is stored and shown: one line, no control characters, a bounded length (an answer shaped by a transcript is data, not a document). */
const line = (max: number) =>
  z
    .string()
    .transform((t) =>
      t
        .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .pipe(z.string().min(1).max(max))
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

  reply(sessionId: string): StoredReply | null {
    const parsed = StoredReply.safeParse(this.rows.get(replyKey(sessionId))?.answer)
    return parsed.success ? parsed.data : null
  }
}

// --- the items ----------------------------------------------------------------------------------------------------

interface Item {
  key: string
  kind: ItemKind
  text: string
  /** the content that was sent: what the cache compares */
  fingerprint: string
  /** the session's turn the answer is for; headings have none */
  turn: number | null
  at: string | null
  /** failures of this content so far (`fleet_digest_backoff`): a suspect is asked about with fewer companions */
  failures: number
  /** the most companions a call with it may have */
  cap: number
}

/** A cached answer whose content did not change but whose turn did: only the turn (and the ask's time) moves, no model. */
interface Touch {
  key: string
  patch: { turn: number; at?: string }
}

const cleanHeading = (text: string): string => head(wellFormed(text).replace(/\s+/g, ' ').trim(), LIMIT.heading)

/** A message cut to what a call takes: whole, else its start and its end (the question is usually last). */
export function boundReply(text: string): string {
  const t = wellFormed(text).trim()
  return t.length <= LIMIT.reply ? t : `${head(t, 1_000)}\n[…]\n${tail(t, LIMIT.reply - 1_010)}`
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

/** `agw` exits 10 for a run that is still going. */
const EXIT_PENDING = 10
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{5,127}$/

/** The id of a pending run, from the JSON `agw` printed with exit 10. */
function runIdOf(stdout: string): string | undefined {
  try {
    const body = JSON.parse(stdout) as Record<string, unknown>
    const run = body.run as Record<string, unknown> | undefined
    const id = body.runId ?? body.run_id ?? run?.id ?? body.id
    return typeof id === 'string' && RUN_ID.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

const Envelope = z.object({
  status: z.string().optional(),
  output: z.object({ results: z.array(z.object({ id: z.string() }).loose()) }).loose(),
  cost: z.number().nullish(),
})

/** One item of a batch as it is kept while its run is pending: what was sent, and what its answer is stored under. */
const BatchItem = z.object({
  id: z.string(),
  key: z.string(),
  kind: z.enum(['heading', 'session', 'reply']),
  text: z.string(),
  fingerprint: z.string(),
  turn: z.number().int().nullable(),
  at: z.string().nullable(),
})
type BatchItem = z.infer<typeof BatchItem>

type Reply =
  | { kind: 'done'; answers: Map<string, Record<string, unknown>>; cost: number | null }
  | { kind: 'pending'; runId: string | undefined }
  | { kind: 'hung' }

/** A call that failed; `terminal`: `agw` says the run itself failed or was cancelled (else it may be a blip and the run still going). */
class CallFailed extends Error {
  constructor(
    message: string,
    readonly terminal = false,
  ) {
    super(message)
  }
}

const TERMINAL = new Set(['failed', 'cancelled', 'canceled', 'error', 'timed_out'])
/** Whether what `agw` printed says its run is over for good. */
function endedBadly(stdout: string): boolean {
  try {
    const status = (JSON.parse(stdout) as { status?: unknown }).status
    return typeof status === 'string' && TERMINAL.has(status)
  } catch {
    return false
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

interface BackoffRow {
  fingerprint: string
  failures: number
  /** the size of the batch it last failed in */
  batch: number
  retryAt: Date
}

/**
 * The digest's one writer. `kick(feed)` is the builder's call after a snapshot: a pass starts behind its back when one is due
 * and none runs. A pass keeps a fingerprint per item (the content it would send) and asks about the changed ones only, at most
 * 64, oldest answers first, in one call. A run that `agw` has not finished (exit 10) is kept with its batch (`fleet_digest_pending`)
 * and the following passes only wait for it (`agw run wait`); a call that fails for good backs its items off, exponentially and
 * persisted, and a batch that failed twice is halved with every failure after: the model stays as it was.
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
    const [pending]: { run_id: string; batch: unknown; started_at: Date }[] =
      await sql`SELECT run_id, batch, started_at FROM factory.fleet_digest_pending WHERE id = 1`
    if (pending) return this.resume(pending.run_id, pending.batch, pending.started_at, now)

    const cached = new Map<string, CacheRow>()
    for (const r of await sql`SELECT key, fingerprint, answer, at FROM factory.fleet_digest`) {
      cached.set(r.key, { fingerprint: r.fingerprint, answer: r.answer, at: r.at })
    }
    const backoff = new Map<string, BackoffRow>()
    for (const r of await sql`SELECT key, fingerprint, failures, batch, retry_at FROM factory.fleet_digest_backoff`) {
      backoff.set(r.key, { fingerprint: r.fingerprint, failures: r.failures, batch: r.batch, retryAt: r.retry_at })
    }
    const { items, touches, wanted } = await this.collect(feed, cached, backoff, now)
    for (const t of touches) {
      await sql`UPDATE factory.fleet_digest SET answer = answer || ${JSON.stringify(t.patch)}::text::jsonb WHERE key = ${t.key}`
    }
    await this.prune(feed.complete ? wanted : undefined, cached, now)
    if (items.length === 0) return { called: false, sent: 0, stored: 0, failedItems: 0, waiting: 0 }

    // Items that never failed come first, then by fewest failures, then the oldest answers: a suspect waits behind the healthy ones and
    // is asked about with fewer companions each time (it joins a batch only while the batch is no bigger than its cap), so one poison
    // item never starves the rest. A batch is what one call takes, the rest waits for the next pass.
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
    if (picked.length === 0) return { called: false, sent: 0, stored: 0, failedItems: 0, waiting: items.length }
    const batch: BatchItem[] = picked.map((item, i) => ({
      id: `i${i}`,
      key: item.key,
      kind: item.kind,
      text: item.text,
      fingerprint: item.fingerprint,
      turn: item.turn,
      at: item.at,
    }))
    const attempt = Math.max(...picked.map((i) => i.failures))
    return this.start(batch, items.length - batch.length, attempt, now)
  }

  /** A new call for a batch. */
  private async start(batch: BatchItem[], waiting: number, attempt: number, now: Date): Promise<PassResult> {
    const stdin = JSON.stringify(batch.map(({ id, kind, text }) => ({ id, kind, text })))
    // The batch's and the attempt's: a restart that lost a run's id finds the run again, a failed run is not replayed to its retry.
    const key = `factory-digest-${hash(stdin, 24)}-${attempt}`
    let reply: Reply
    try {
      reply = await this.exec([this.deps.bin, 'digest', '--format', 'json', '--idempotency-key', key], stdin)
    } catch (error) {
      return this.failBatch(batch, message(error), waiting, now)
    }
    if (reply.kind === 'hung') return this.failBatch(batch, 'agw digest hung past the guard', waiting, now)
    if (reply.kind === 'pending') {
      if (!reply.runId) return this.failBatch(batch, 'agw says the run is pending but names no run id', waiting, now)
      const { sql } = this.deps
      await sql`
        INSERT INTO factory.fleet_digest_pending (id, run_id, batch, started_at)
        VALUES (1, ${reply.runId}, ${JSON.stringify(batch)}::text::jsonb, ${now})
        ON CONFLICT (id) DO UPDATE SET run_id = EXCLUDED.run_id, batch = EXCLUDED.batch, started_at = EXCLUDED.started_at`
      return { called: true, sent: batch.length, stored: 0, failedItems: 0, waiting, pending: true }
    }
    return this.finish(batch, reply, waiting, false, now)
  }

  /**
   * A pass with a pending run: only waits for it. Pending is not a failure, and neither is a wait that did not get through (a blip, a
   * hung process): the run is kept. It is let go when `agw` says it failed or was cancelled, or when it is a day old.
   */
  private async resume(runId: string, stored: unknown, startedAt: Date, now: Date): Promise<PassResult> {
    const parsed = z.array(BatchItem).safeParse(stored)
    const batch = parsed.success ? parsed.data : []
    if (!parsed.success) return this.failBatch(batch, 'the pending batch does not parse', 0, now, true)
    if (now.getTime() - startedAt.getTime() > PENDING_MAX_MS) {
      return this.failBatch(batch, `run ${runId} did not end in a day`, 0, now, true)
    }
    const waiting = { called: false, sent: batch.length, stored: 0, failedItems: 0, waiting: 0, pending: true }
    let reply: Reply
    try {
      reply = await this.exec([this.deps.bin, 'run', 'wait', runId, '--format', 'json'])
    } catch (error) {
      if (error instanceof CallFailed && error.terminal) return this.failBatch(batch, message(error), 0, now, true)
      return { ...waiting, error: message(error) }
    }
    if (reply.kind !== 'done') return waiting
    return this.finish(batch, reply, 0, true, now)
  }

  /** The answers of a finished call: stored with its journal row in one transaction, or (the store failed) backed off and journalled as failed. */
  private async finish(
    batch: BatchItem[],
    reply: Extract<Reply, { kind: 'done' }>,
    waiting: number,
    clearPending: boolean,
    now: Date,
  ): Promise<PassResult> {
    const { sql } = this.deps
    const rows: { item: BatchItem; answer: Record<string, unknown> }[] = []
    const refused: BatchItem[] = []
    for (const item of batch) {
      const answer = parseAnswer(item, reply.answers.get(item.id))
      if (answer) rows.push({ item, answer })
      else refused.push(item)
    }
    // A call whose every item failed answered nothing: it counts as a failed pass.
    const ok = rows.length > 0
    const error = ok ? null : 'no item of the call was answered'
    try {
      await sql.begin(async (tx) => {
        for (const { item, answer } of rows) {
          await tx`
            INSERT INTO factory.fleet_digest (key, fingerprint, answer, at)
            VALUES (${item.key}, ${item.fingerprint}, ${JSON.stringify(answer)}::text::jsonb, ${now})
            ON CONFLICT (key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, answer = EXCLUDED.answer, at = EXCLUDED.at`
        }
        if (rows.length > 0) {
          await tx`DELETE FROM factory.fleet_digest_backoff WHERE key IN ${tx(rows.map((r) => r.item.key))}`
        }
        await this.backOff(tx, refused, 'the answer was missing, an error or broke its schema', 1)
        await this.journal(tx, { ok, items: batch.length, failedItems: refused.length, cost: reply.cost, error })
        if (clearPending) await tx`DELETE FROM factory.fleet_digest_pending WHERE id = 1`
      })
    } catch (storeError) {
      // The answers are lost with the transaction: the pass is journalled as failed with the reason and the items back off, so a
      // text the database refuses does not lead every later batch.
      return this.failBatch(
        batch,
        `the answers could not be stored: ${message(storeError)}`,
        waiting,
        now,
        clearPending,
      )
    }
    return {
      called: true,
      sent: batch.length,
      stored: rows.length,
      failedItems: refused.length,
      waiting,
      ...(ok ? {} : { error: error ?? undefined }),
    }
  }

  /** A call that failed for good: its items back off, the pass is journalled as failed, a pending run is let go. */
  private async failBatch(
    batch: BatchItem[],
    reason: string,
    waiting: number,
    now: Date,
    clearPending = false,
  ): Promise<PassResult> {
    const { sql } = this.deps
    await sql.begin(async (tx) => {
      await this.backOff(tx, batch, reason, batch.length)
      await this.journal(tx, { ok: false, items: batch.length, failedItems: 0, cost: null, error: reason })
      if (clearPending) await tx`DELETE FROM factory.fleet_digest_pending WHERE id = 1`
    })
    return { called: true, sent: batch.length, stored: 0, failedItems: 0, waiting, error: reason }
  }

  /** One more failure for each item (for the same content; changed content starts over), and when it may be asked about again. */
  private async backOff(
    sql: SQL,
    items: readonly Pick<BatchItem, 'key' | 'fingerprint'>[],
    reason: string,
    batchSize: number,
  ): Promise<void> {
    if (items.length === 0) return
    // From the time of the failure, not of the pass: a call can run for minutes before it fails.
    const now = this.deps.now()
    const why = head(wellFormed(reason), 500)
    const known: { key: string; fingerprint: string; failures: number }[] =
      await sql`SELECT key, fingerprint, failures FROM factory.fleet_digest_backoff WHERE key IN ${sql(items.map((i) => i.key))}`
    const before = new Map(known.map((k) => [k.key, k]))
    for (const item of items) {
      const prior = before.get(item.key)
      const failures = prior && prior.fingerprint === item.fingerprint ? prior.failures + 1 : 1
      await sql`
        INSERT INTO factory.fleet_digest_backoff (key, fingerprint, failures, batch, retry_at, error)
        VALUES (${item.key}, ${item.fingerprint}, ${failures}, ${batchSize}, ${new Date(now.getTime() + backoffMs(failures))}, ${why})
        ON CONFLICT (key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, failures = EXCLUDED.failures, batch = EXCLUDED.batch,
          retry_at = EXCLUDED.retry_at, error = EXCLUDED.error`
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
    const offer = (item: Omit<Item, 'failures' | 'cap'>) => {
      if (cached.get(item.key)?.fingerprint === item.fingerprint) return
      const failed = backoff.get(item.key)
      const same = failed && failed.fingerprint === item.fingerprint ? failed : undefined
      if (same && same.retryAt.getTime() > now.getTime()) return
      items.push({
        ...item,
        failures: same?.failures ?? 0,
        cap: same ? batchCap(same.failures, same.batch) : MAX_ITEMS,
      })
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
      const needSession = !sessionRow.success || sessionRow.data.turn !== s.turn
      const needReply = !replyRow.success || replyRow.data.turn !== s.turn
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

  /** One `agw` process: `done` with its answers, `pending` (exit 10) with the run's id, `hung` past the guard. Anything else throws a line. */
  private async exec(cmd: string[], stdin?: string): Promise<Reply> {
    const result = await this.run(cmd, this.deps.hangGuardMs ?? HANG_GUARD_MS, childEnv(), stdin)
    if (result.exitCode === EXIT_TIMEOUT) return { kind: 'hung' }
    if (result.exitCode === EXIT_PENDING) return { kind: 'pending', runId: runIdOf(result.stdout) }
    if (result.exitCode !== 0)
      throw new CallFailed(`agw ${cmd[1]} exited ${result.exitCode}`, endedBadly(result.stdout))
    let body: unknown
    try {
      body = JSON.parse(result.stdout)
    } catch {
      throw new CallFailed(`agw ${cmd[1]} printed no JSON`)
    }
    const status = (body as { status?: unknown } | null)?.status
    if (typeof status === 'string' && status !== 'done') {
      if (TERMINAL.has(status)) throw new CallFailed(`the digest run is ${status}`, true)
      return { kind: 'pending', runId: runIdOf(result.stdout) }
    }
    const parsed = Envelope.safeParse(body)
    if (!parsed.success) {
      throw new CallFailed(`agw ${cmd[1]} answered an unexpected shape: ${parsed.error.issues[0]?.message}`)
    }
    // An id we did not send is dropped, a repeat keeps the first.
    const answers = new Map<string, Record<string, unknown>>()
    for (const r of parsed.data.output.results) if (!answers.has(r.id)) answers.set(r.id, r)
    return { kind: 'done', answers, cost: parsed.data.cost ?? null }
  }

  private async journal(
    sql: SQL,
    run: { ok: boolean; items: number; failedItems: number; cost: number | null; error: string | null },
  ): Promise<void> {
    await sql`
      INSERT INTO factory.fleet_digest_runs (at, ok, items, failed_items, cost_usd, error)
      VALUES (${this.deps.now()}, ${run.ok}, ${run.items}, ${run.failedItems}, ${run.cost}, ${run.error ? head(wellFormed(run.error), 500) : null})`
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
    await sql`DELETE FROM factory.fleet_digest_runs WHERE at < ${new Date(now.getTime() - KEEP_RUNS_MS)}`
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
