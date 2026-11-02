import { createHash } from 'node:crypto'
import type { FleetDigest } from '@software-factory/contract'
import { NO_DIGEST } from '@software-factory/contract'
import type { SQL } from 'bun'
import { z } from 'zod'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
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
/** The process timeout of one call (the brief's): past it the pass has failed and the model stays as it was. */
export const CALL_TIMEOUT_MS = 60_000
/** `agw` waits this long for a run before it answers "pending" (exit 10); below the process timeout, so a slow call ends by itself. */
const AGW_WAIT_S = '50'
/** An item whose answer came back as an error is not asked again for this long (same content). */
const RETRY_ITEM_MS = 60 * 60_000
/** A cache row that no current item wants is dropped after this long. */
const KEEP_UNWANTED_MS = 7 * 24 * 3_600_000
const KEEP_RUNS_MS = 14 * 24 * 3_600_000
const EXCERPT = 1_200
const DAYS_SHOWN = 7

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const hash = (text: string, length = 16): string => createHash('sha256').update(text).digest('hex').slice(0, length)

export type ItemKind = 'heading' | 'session' | 'reply'

export const headingKey = (text: string): string => `heading:${hash(text, 12)}`
export const sessionKey = (id: string): string => `session:${id}`
export const replyKey = (id: string): string => `reply:${id}`

// --- the feed: what the builder offers ---------------------------------------------------------------------------

/** A session the digest may read: its repo, plan and place are all ordinary (the builder leaves every visible one out). */
export interface FeedSession {
  id: string
  /** turns started, when the factory knows the session; null for a terminal only hc knows (it has no transcript on record) */
  turn: number | null
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
        .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
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
}

/** A cached answer whose content did not change but whose turn did: only the turn (and the ask's time) moves, no model. */
interface Touch {
  key: string
  patch: { turn: number; at?: string }
}

const cleanHeading = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, LIMIT.heading)

/** A message cut to what a call takes: whole, else its start and its end (the question is usually last). */
export function boundReply(text: string): string {
  const t = text.trim()
  return t.length <= LIMIT.reply ? t : `${t.slice(0, 1_000)}\n[…]\n${t.slice(-(LIMIT.reply - 1_010))}`
}

function sessionText(s: FeedSession, last: string | null): string {
  const lines = [
    s.title ? `Tab title: ${s.title}` : '',
    s.role ? `Role: ${s.role}` : '',
    `Repo: ${s.repo}`,
    s.plan ? `Plan: ${s.plan}` : '',
    s.wave ? `Wave: ${s.wave}` : '',
    last ? `Last message: ${last.trim().slice(-EXCERPT)}` : '',
  ].filter(Boolean)
  return lines.join('\n').slice(0, LIMIT.session)
}

// --- the call -----------------------------------------------------------------------------------------------------

/** `agw digest` exits 10 for a run that is still going. */
const EXIT_PENDING = 10

const Envelope = z.object({
  status: z.string().optional(),
  output: z.object({ results: z.array(z.object({ id: z.string() }).loose()) }).loose(),
  cost: z.number().nullish(),
})

/** A call that failed; `sameRun`: the run may still be going, so the next pass asks for it again under the same key. */
class CallFailed extends Error {
  constructor(
    message: string,
    readonly sameRun = false,
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
  callTimeoutMs?: number
  /** swapped by the tests */
  run?: typeof runProcess
  replies?: ReplyReader
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
  /** the call failed (or was slow): the model stays as it was */
  error?: string
}

/**
 * The digest's one writer. `kick(feed)` is the builder's call after a snapshot: a pass starts behind its back when one is due
 * and none runs. A pass keeps a fingerprint per item (the content it would send) and asks about the changed ones only, at most
 * 64, oldest answers first, in one call; a failed or slow call changes nothing.
 */
export class Digest {
  private running: Promise<unknown> | undefined
  private lastStart = 0
  /** `key\0fingerprint` → when its answer was an error */
  private readonly failed = new Map<string, number>()
  /** per batch: calls that failed for good, part of the key, so a failed run is not replayed by the retry of the same batch */
  private readonly failedCalls = new Map<string, number>()
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
    return new DigestView(
      new Map(rows.map((r) => [r.key, { fingerprint: r.fingerprint, answer: r.answer, at: r.at }])),
      {
        enabled: true,
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
    const cached = new Map<string, CacheRow>()
    for (const r of await sql`SELECT key, fingerprint, answer, at FROM factory.fleet_digest`) {
      cached.set(r.key, { fingerprint: r.fingerprint, answer: r.answer, at: r.at })
    }
    const { items, touches, wanted } = await this.collect(feed, cached, now)
    for (const t of touches) {
      await sql`UPDATE factory.fleet_digest SET answer = answer || ${JSON.stringify(t.patch)}::text::jsonb WHERE key = ${t.key}`
    }
    await this.prune(feed.complete ? wanted : undefined, cached, now)
    if (items.length === 0) return { called: false, sent: 0, stored: 0, failedItems: 0, waiting: 0 }

    // Oldest answers first (never answered, then by age); a batch is what one call takes, the rest waits for the next pass.
    const age = (i: Item) => cached.get(i.key)?.at.getTime() ?? 0
    items.sort((a, b) => age(a) - age(b) || a.key.localeCompare(b.key))
    const batch: Item[] = []
    let chars = 0
    for (const item of items) {
      if (batch.length >= MAX_ITEMS || chars + item.text.length > MAX_BATCH_CHARS) break
      batch.push(item)
      chars += item.text.length
    }
    const waiting = items.length - batch.length

    const sent = batch.map((item, i) => ({ id: `i${i}`, kind: item.kind, text: item.text }))
    let answers: Map<string, Record<string, unknown>>
    let cost: number | null
    try {
      ;({ answers, cost } = await this.call(sent, now))
    } catch (error) {
      const reason = message(error)
      if (!(error instanceof CallFailed && error.sameRun)) {
        const batchKey = hash(JSON.stringify(sent), 24)
        this.failedCalls.set(batchKey, (this.failedCalls.get(batchKey) ?? 0) + 1)
      }
      await this.journal(sql, { ok: false, items: batch.length, failedItems: 0, cost: null, error: reason })
      return { called: true, sent: batch.length, stored: 0, failedItems: 0, waiting, error: reason }
    }

    const rows: { key: string; fingerprint: string; answer: unknown }[] = []
    let failedItems = 0
    batch.forEach((item, i) => {
      const answer = parseAnswer(item, answers.get(`i${i}`))
      if (!answer) {
        failedItems++
        this.failed.set(`${item.key}\0${item.fingerprint}`, now.getTime())
        return
      }
      rows.push({ key: item.key, fingerprint: item.fingerprint, answer })
    })
    // A call whose every item failed answered nothing: it counts as a failed pass.
    const ok = rows.length > 0
    // The answers and the journal row of a paid call are stored together or not at all (the call is over: this is the one short transaction).
    await sql.begin(async (tx) => {
      for (const row of rows) {
        await tx`
          INSERT INTO factory.fleet_digest (key, fingerprint, answer, at)
          VALUES (${row.key}, ${row.fingerprint}, ${JSON.stringify(row.answer)}::text::jsonb, ${now})
          ON CONFLICT (key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, answer = EXCLUDED.answer, at = EXCLUDED.at`
      }
      await this.journal(tx, {
        ok,
        items: batch.length,
        failedItems,
        cost,
        error: ok ? null : 'no item of the call was answered',
      })
    })
    return {
      called: true,
      sent: batch.length,
      stored: rows.length,
      failedItems,
      waiting,
      ...(ok ? {} : { error: 'no item of the call was answered' }),
    }
  }

  private async collect(
    feed: DigestFeed,
    cached: ReadonlyMap<string, CacheRow>,
    now: Date,
  ): Promise<{ items: Item[]; touches: Touch[]; wanted: Set<string> }> {
    const items: Item[] = []
    const touches: Touch[] = []
    const wanted = new Set<string>()
    const nowMs = now.getTime()
    const recentlyFailed = (key: string, fingerprint: string) => {
      const at = this.failed.get(`${key}\0${fingerprint}`)
      return at !== undefined && nowMs - at < RETRY_ITEM_MS
    }
    const offer = (item: Item) => {
      if (cached.get(item.key)?.fingerprint === item.fingerprint) return
      if (!recentlyFailed(item.key, item.fingerprint)) items.push(item)
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

    for (const s of feed.sessions) {
      const skey = sessionKey(s.id)
      const rkey = replyKey(s.id)
      wanted.add(skey)
      wanted.add(rkey)
      // A terminal only hc knows: no turn count and no transcript on record, so a headline from what hc says of it.
      if (s.turn === null) {
        const text = sessionText(s, null)
        offer({ key: skey, kind: 'session', text, fingerprint: hash(text), turn: null, at: null })
        continue
      }
      // A turn that has not ended has no reply yet: the headline and the ask stay what they were until it does.
      if (!s.settled || s.turn < 1 || !s.transcriptPath) continue
      const sessionRow = StoredSession.safeParse(cached.get(skey)?.answer)
      const replyRow = StoredReply.safeParse(cached.get(rkey)?.answer)
      const needSession = !sessionRow.success || sessionRow.data.turn !== s.turn
      const needReply = !replyRow.success || replyRow.data.turn !== s.turn
      if (!needSession && !needReply) continue
      const last = await this.replies.lastReply(s.transcriptPath)
      if (!last) continue
      const at = s.since ?? now.toISOString()
      if (needSession) {
        const text = sessionText(s, last)
        const item: Item = { key: skey, kind: 'session', text, fingerprint: hash(text), turn: s.turn, at: null }
        if (cached.get(skey)?.fingerprint === item.fingerprint) touches.push({ key: skey, patch: { turn: s.turn } })
        else offer(item)
      }
      if (needReply) {
        const text = boundReply(last)
        const item: Item = { key: rkey, kind: 'reply', text, fingerprint: hash(text), turn: s.turn, at }
        if (cached.get(rkey)?.fingerprint === item.fingerprint) touches.push({ key: rkey, patch: { turn: s.turn, at } })
        else offer(item)
      }
    }
    return { items, touches, wanted }
  }

  /** One `agw digest` call: the items on stdin, the answers by id. Throws a line for every way the call can fail. */
  private async call(
    items: { id: string; kind: ItemKind; text: string }[],
    now: Date,
  ): Promise<{ answers: Map<string, Record<string, unknown>>; cost: number | null }> {
    const timeout = this.deps.callTimeoutMs ?? CALL_TIMEOUT_MS
    const stdin = JSON.stringify(items)
    // The key is the batch's, the hour's and the count of failed calls: a slow call (a timeout, "pending") is found again by the next
    // pass with the same batch, while a run that failed is never replayed to the retry.
    const key = `factory-digest-${hash(stdin, 24)}-${Math.floor(now.getTime() / 3_600_000)}-${this.failedCalls.get(hash(stdin, 24)) ?? 0}`
    const result = await this.run(
      [this.deps.bin, 'digest', '--format', 'json', '--idempotency-key', key],
      timeout,
      childEnv({ AGW_WAIT_BUDGET_S: AGW_WAIT_S }),
      stdin,
    )
    if (result.exitCode === EXIT_TIMEOUT) throw new CallFailed('agw digest did not answer in time', true)
    if (result.exitCode === EXIT_PENDING)
      throw new CallFailed('agw digest is still running (the next pass finds its run)', true)
    if (result.exitCode !== 0) throw new Error(`agw digest exited ${result.exitCode}`)
    let body: unknown
    try {
      body = JSON.parse(result.stdout)
    } catch {
      throw new Error('agw digest printed no JSON')
    }
    const parsed = Envelope.safeParse(body)
    if (!parsed.success) throw new Error(`agw digest answered an unexpected shape: ${parsed.error.issues[0]?.message}`)
    if (parsed.data.status !== undefined && parsed.data.status !== 'done') {
      throw new Error(`the digest run is ${parsed.data.status}`)
    }
    // An id we did not send is dropped, a repeat keeps the first.
    const answers = new Map<string, Record<string, unknown>>()
    for (const r of parsed.data.output.results) if (!answers.has(r.id)) answers.set(r.id, r)
    return { answers, cost: parsed.data.cost ?? null }
  }

  private async journal(
    sql: SQL,
    run: { ok: boolean; items: number; failedItems: number; cost: number | null; error: string | null },
  ): Promise<void> {
    await sql`
      INSERT INTO factory.fleet_digest_runs (at, ok, items, failed_items, cost_usd, error)
      VALUES (${this.deps.now()}, ${run.ok}, ${run.items}, ${run.failedItems}, ${run.cost}, ${run.error?.slice(0, 500) ?? null})`
  }

  /** Rows no item wants any more (a heading rewritten, a session gone), once they have been unwanted for a week (not on a partial feed); old journal rows. */
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
    for (const [k, at] of this.failed) if (now.getTime() - at >= RETRY_ITEM_MS) this.failed.delete(k)
  }
}

/** The stored form of one item's answer, or `undefined` when agw's answer is missing, an error or breaks the item's schema. */
function parseAnswer(item: Item, raw: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
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
  return { ...parsed.data, turn: item.turn, at: item.at ?? '', text: item.text.slice(-1_000) }
}

/** The failed passes of the last 24 h, for `factory status` (the table exists once the migrations have run, which is before anything reads it). */
export async function digestFailures(sql: SQL, now: Date): Promise<number> {
  const [row]: { n: number }[] = await sql`
    SELECT count(*)::int AS n FROM factory.fleet_digest_runs WHERE NOT ok AND at >= ${new Date(now.getTime() - 24 * 3_600_000)}`
  return row?.n ?? 0
}
