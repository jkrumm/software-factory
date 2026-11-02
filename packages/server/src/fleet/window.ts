import { createHash } from 'node:crypto'
import type { Since, SinceHeadline } from '@software-factory/contract'
import type { SQL } from 'bun'
import { z } from 'zod'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { LOCKS } from '../locks.ts'
import { redact } from '../notify/text.ts'
import {
  CallFailed,
  Envelope,
  EXIT_NOT_FOUND,
  EXIT_PENDING,
  HANG_GUARD_MS,
  isTerminal,
  reasonText,
  runIdOf,
  statusOf,
} from './digest.ts'
import { head, line, wellFormed } from './digest-text.ts'

/**
 * The headline paragraph of a since window (FV Wave 4): the only model text of the reading. One `agw digest` call of kind `window` per
 * distinct window, its input the groups' non-IuRoot facts (an IuRoot item is a count, never its text), cached by the facts' hash in
 * `factory.fleet_windows`. `GET /fleet/since` never waits on agw: it reads the row and queues a missing one; the tick's pass does the call.
 * The Wave 2 lifecycle: one run in flight (a pending run is only waited for), a backoff after a failure, a cap of calls per day.
 */

/** What `agw digest` takes for a `window` item, in UTF-16 units. */
export const WINDOW_TEXT_MAX = 6_000
/** Window calls per rolling 24 hours, successes and failures. */
export const WINDOW_DAILY_CAP = 48
export const WINDOW_EVERY_MS = 15_000
const BACKOFF_BASE_MS = 15 * 60_000
const BACKOFF_MAX_MS = 6 * 3_600_000
const WAITS_FAILED_MAX = 3
const PENDING_MAX_MS = 2 * 3_600_000
const KEEP_MS = 14 * 24 * 3_600_000
const LINE_MAX = 160
const SHOWN = 8

const Paragraph = z.object({ paragraph: line(800) })

const hash = (text: string, length = 24): string => createHash('sha256').update(text).digest('hex').slice(0, length)
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const oneLine = (text: string, max = LINE_MAX): string =>
  head(redact(wellFormed(text)).replace(/\s+/g, ' ').trim(), max)

export interface WindowFacts {
  /** the text `agw digest` gets */
  text: string
  hash: string
  /** what the model may know besides the facts, outside the hash (the ordinary sessions' headlines, which change with every turn); at most 1,000 characters */
  context: string
}

/** What `agw digest` takes as an item's `context`. */
const CONTEXT_MAX = 1_000

type Groups = Omit<Since, 'headline'>

/**
 * The facts of a window that may leave the mini: the ordinary items' text, and the IuRoot items as a count. Nothing that moves with the
 * clock is in it (a run time, the spend), so equal facts are one call. `null` when there is nothing ordinary to say.
 */
export function windowFacts(groups: Groups): WindowFacts | null {
  const ordinary = <T extends { visible: boolean }>(items: readonly T[]): T[] => items.filter((i) => !i.visible)
  const needs = ordinary(groups.needsYou)
  const shipped = ordinary(groups.shipped)
  const recovered = ordinary(groups.recovered)
  const running = ordinary(groups.running)
  const hidden = [groups.needsYou, groups.shipped, groups.recovered, groups.running].reduce(
    (n, items) => n + items.filter((i) => i.visible).length,
    0,
  )
  // Counts of what was handled, never the rows' words: the triage log's subjects may name an IuRoot plan or session.
  const kinds = new Map<string, number>()
  for (const h of groups.handled) kinds.set(h.kind, (kinds.get(h.kind) ?? 0) + 1)
  if (needs.length + shipped.length + recovered.length + running.length + groups.handled.length === 0) return null

  const list = (label: string, items: readonly string[], total: number): string => {
    const shown = items.slice(0, SHOWN).map((i) => `- ${i}`)
    return [`${label}: ${total}`, ...shown, ...(total > SHOWN ? [`- (+${total - SHOWN} more)`] : [])].join('\n')
  }
  const sections = [
    list(
      'Needs the owner',
      needs.map((n) => `${n.yours ? '[yours] ' : ''}${oneLine(n.ask.short ?? n.ask.text)}`),
      needs.length,
    ),
    list(
      'Shipped',
      shipped.map((s) => oneLine(s.text)),
      shipped.length,
    ),
    list(
      'Went wrong, then recovered',
      recovered.map((r) => oneLine(r.text)),
      recovered.length,
    ),
    `Handled for you: ${groups.handled.length}${kinds.size > 0 ? ` (${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}`,
    list(
      'Still running',
      // By id: a headline changes with every turn, and a new turn must not make a new window (the headlines are the item's context).
      running.map((r) => oneLine(r.id)),
      running.length,
    ),
    `Items of a read-only area, counted only: ${hidden}`,
  ]
  const text = head(wellFormed(sections.join('\n')), WINDOW_TEXT_MAX)
  // An IuRoot session has no headline here: the running list above is the ordinary ones only.
  const context = head(
    running
      .filter((r) => r.headline)
      .map((r) => `${oneLine(r.id, 60)}: ${oneLine(r.headline ?? '', 120)}`)
      .join('\n'),
    CONTEXT_MAX,
  )
  return { text, hash: hash(text), context }
}

export interface WindowDeps {
  sql: SQL
  now: () => Date
  /** the `agw` binary (`FACTORY_AGW_BIN`) */
  bin: string
  everyMs?: number
  hangGuardMs?: number
  dailyCap?: number
  /** swapped by the tests */
  run?: typeof runProcess
  /** runs between choosing a window and claiming it (the tests make a request land there) */
  beforeClaim?: () => Promise<void>
}

interface Row {
  hash: string
  facts: string
  context: string | null
  state: 'queued' | 'pending' | 'ready' | 'failed' | 'superseded'
  paragraph: string | null
  run_id: string | null
  failures: number
  waits_failed: number
  retry_at: Date | null
  updated_at: Date
}

type Reply =
  | { kind: 'done'; paragraph: string | null; cost: number | null; reason: string | null }
  | { kind: 'pending'; runId: string | undefined }
  | { kind: 'hung' }

export class WindowDigest {
  private running: Promise<unknown> | undefined
  private lastStart = 0
  /** the window whose agw call this process is in the middle of */
  private calling: string | undefined
  private readonly run: typeof runProcess

  constructor(private readonly deps: WindowDeps) {
    this.run = deps.run ?? runProcess
  }

  /** What the reading shows for these facts, without writing anything: a window nobody has asked for yet is pending. */
  async headline(facts: WindowFacts | null): Promise<SinceHeadline> {
    if (!facts) return { state: 'none', text: null }
    const [row]: Pick<Row, 'state' | 'paragraph'>[] = await this.deps
      .sql`SELECT state, paragraph FROM factory.fleet_windows WHERE hash = ${facts.hash}`
    return row ? toHeadline(row) : { state: 'pending', text: null }
  }

  /** A paragraph already made for these facts, or `none`: for a reading that does not ask for a window (an explicit `t`). Writes nothing. */
  async cached(facts: WindowFacts | null): Promise<SinceHeadline> {
    if (!facts) return { state: 'none', text: null }
    const [row]: Pick<Row, 'state' | 'paragraph'>[] = await this.deps
      .sql`SELECT state, paragraph FROM factory.fleet_windows WHERE hash = ${facts.hash} AND state = 'ready'`
    return row ? toHeadline(row) : { state: 'none', text: null }
  }

  /**
   * Makes sure the window has a row: a missing one is queued for the pass (this never calls agw), and it supersedes every other window
   * that still waits (queued or backing off): only the newest is ever started. Requests take turns under an advisory lock. Nothing is
   * written when the row exists, is already the newest request, its context is unchanged and nothing waits. `now` starts the pass at once,
   * for the first desk act after an away window, so the card has its paragraph by the time it is read.
   */
  async request(facts: WindowFacts | null, options: { now?: boolean } = {}): Promise<SinceHeadline> {
    if (!facts) return { state: 'none', text: null }
    const { sql } = this.deps
    const at = this.deps.now()
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${LOCKS.windows})`
      const rows: { hash: string; state: Row['state']; context: string | null; requested_at: Date }[] = await tx`
        SELECT hash, state, context, requested_at FROM factory.fleet_windows WHERE hash = ${facts.hash} OR state IN ('queued', 'failed')`
      const own = rows.find((r) => r.hash === facts.hash)
      const waiting = rows.some((r) => r.hash !== facts.hash)
      if (!own || own.state === 'superseded') {
        await tx`
          INSERT INTO factory.fleet_windows (hash, facts, context, state, requested_at, updated_at)
          VALUES (${facts.hash}, ${facts.text}, ${facts.context}, 'queued', ${at}, ${at})
          ON CONFLICT (hash) DO UPDATE SET state = 'queued', context = EXCLUDED.context, requested_at = EXCLUDED.requested_at, updated_at = EXCLUDED.updated_at,
            retry_at = NULL, failures = 0, waits_failed = 0`
      } else {
        // The row is there. Its context follows the sessions as they are now while it waits, and it becomes the newest request again.
        const [newest]: { newest: Date | null }[] =
          await tx`SELECT max(requested_at) AS newest FROM factory.fleet_windows`
        const stale = (own.state === 'queued' || own.state === 'failed') && (own.context ?? '') !== facts.context
        const newer = newest?.newest != null && own.requested_at < newest.newest
        if (!stale && !newer && !waiting) return
        if (stale) await tx`UPDATE factory.fleet_windows SET context = ${facts.context} WHERE hash = ${facts.hash}`
        if (newer) await tx`UPDATE factory.fleet_windows SET requested_at = ${at} WHERE hash = ${facts.hash}`
      }
      // The newest request is the one about to be read: every other window still waiting is let go and never started.
      if (waiting) {
        await tx`
          UPDATE factory.fleet_windows SET state = 'superseded', updated_at = ${at}
          WHERE state IN ('queued', 'failed') AND hash <> ${facts.hash}`
      }
    })
    if (options.now) this.kick(true)
    return this.headline(facts)
  }

  /** The tick's call. Never throws and never waits for the pass. */
  kick(force = false): void {
    const now = this.deps.now().getTime()
    if (this.running || (!force && now - this.lastStart < (this.deps.everyMs ?? WINDOW_EVERY_MS))) return
    this.lastStart = now
    this.running = this.pass()
      .catch((error: unknown) => console.error('fleet window digest failed', message(error)))
      .finally(() => {
        this.running = undefined
      })
  }

  /** Waits for the pass in flight, at most `timeoutMs`: shutdown and the tests. */
  async settled(timeoutMs = 20_000): Promise<void> {
    let timer: Timer | undefined
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    try {
      await Promise.race([this.running, bound])
    } finally {
      clearTimeout(timer)
    }
  }

  /** One pass: wait for the run in flight, else start the newest wanted window that is due and under the daily cap (the one the owner is about to read). */
  async pass(): Promise<{ called: boolean; error?: string }> {
    const { sql } = this.deps
    const now = this.deps.now()
    await sql`DELETE FROM factory.fleet_windows WHERE state <> 'pending' AND updated_at < ${new Date(now.getTime() - KEEP_MS)}`
    const [pending]: Row[] =
      await sql`SELECT * FROM factory.fleet_windows WHERE state = 'pending' ORDER BY requested_at LIMIT 1`
    if (pending) return this.resume(pending)
    const [next]: Row[] = await sql`
      SELECT * FROM factory.fleet_windows
      WHERE state IN ('queued', 'failed') AND (retry_at IS NULL OR retry_at <= ${now})
      ORDER BY requested_at DESC, hash LIMIT 1`
    if (!next) return { called: false }
    const [calls]: { n: number }[] = await sql`
      SELECT count(*)::int AS n FROM factory.fleet_digest_runs
      WHERE batch_hash LIKE 'window:%' AND at >= ${new Date(now.getTime() - 24 * 3_600_000)}`
    if ((calls?.n ?? 0) >= (this.deps.dailyCap ?? WINDOW_DAILY_CAP))
      return { called: false, error: 'the daily cap of window calls is spent' }
    await this.deps.beforeClaim?.()
    // Claimed before the call: a window a newer request has let go meanwhile is no longer queued, and no row means no call.
    const [claimed]: Row[] = await sql`
      UPDATE factory.fleet_windows SET state = 'pending', updated_at = ${now}
      WHERE hash = ${next.hash} AND state IN ('queued', 'failed') RETURNING *`
    return claimed ? this.start(claimed) : { called: false }
  }

  /**
   * The call for a claimed window. While it runs, this process holds the claim (`calling`). If anything throws on the way, even the failure
   * record, the claim is released: the window goes back in the queue and the error goes on to the pass's log.
   */
  private async start(row: Row): Promise<{ called: boolean; error?: string }> {
    this.calling = row.hash
    try {
      return await this.call(row)
    } catch (error) {
      await this.deps.sql`
        UPDATE factory.fleet_windows SET state = 'queued', updated_at = ${this.deps.now()}
        WHERE hash = ${row.hash} AND state = 'pending' AND run_id IS NULL`.catch(() => {})
      throw error
    } finally {
      this.calling = undefined
    }
  }

  private async call(row: Row): Promise<{ called: boolean; error?: string }> {
    const { sql } = this.deps
    let key: string
    try {
      const [ended]: { n: number }[] = await sql`
        SELECT count(*)::int AS n FROM factory.fleet_digest_runs WHERE batch_hash = ${`window:${row.hash}`} AND terminal`
      key = `factory-window-${row.hash}-${ended?.n ?? 0}`
    } catch (error) {
      // Claimed and failing before the call: a failure with its backoff, not a claim left behind.
      return this.fail(row, `the call could not be prepared: ${message(error)}`, false)
    }
    const stdin = JSON.stringify([
      { id: 'w', kind: 'window', text: row.facts, ...(row.context ? { context: row.context } : {}) },
    ])
    let reply: Reply
    try {
      reply = await this.exec([this.deps.bin, 'digest', '--format', 'json', '--idempotency-key', key], stdin)
    } catch (error) {
      return this.fail(row, message(error), error instanceof CallFailed && error.kind === 'terminal')
    }
    if (reply.kind === 'hung') return this.fail(row, 'agw digest hung past the guard', false)
    if (reply.kind === 'pending') {
      if (!reply.runId) return this.fail(row, 'agw says the run is pending but names no run id', false)
      await sql`
        UPDATE factory.fleet_windows SET state = 'pending', run_id = ${reply.runId}, waits_failed = 0, updated_at = ${this.deps.now()}
        WHERE hash = ${row.hash}`
      return { called: true }
    }
    return this.finish(row, reply)
  }

  private async resume(row: Row): Promise<{ called: boolean; error?: string }> {
    if (!row.run_id) {
      // Claimed and no run id yet. If this process is making the call, that is it; otherwise a crash left the claim, and the window goes back
      // in the queue at once with no failure counted: the idempotency key is the same, so agw hands back the run if it started one.
      if (this.calling === row.hash) return { called: false }
      await this.deps
        .sql`UPDATE factory.fleet_windows SET state = 'queued', updated_at = ${this.deps.now()} WHERE hash = ${row.hash}`
      return { called: false }
    }
    // A run that never ends must not hold the queue for good.
    if (this.deps.now().getTime() - row.updated_at.getTime() > PENDING_MAX_MS) {
      return this.fail(row, 'the run was still pending after two hours', true)
    }
    let reply: Reply
    try {
      reply = await this.exec([this.deps.bin, 'run', 'wait', row.run_id, '--format', 'json'])
    } catch (error) {
      const kind = error instanceof CallFailed ? error.kind : 'unclear'
      if (kind === 'terminal') return this.fail(row, message(error), true)
      if (kind === 'unknown') return this.fail(row, `${message(error)}: agw does not know the run`, false)
      return this.waitFailed(row, message(error))
    }
    if (reply.kind === 'hung') return this.waitFailed(row, 'agw run wait hung past the guard')
    if (reply.kind === 'pending') return { called: false }
    return this.finish(row, reply)
  }

  private async waitFailed(row: Row, reason: string): Promise<{ called: boolean; error?: string }> {
    const failed = row.waits_failed + 1
    if (failed >= WAITS_FAILED_MAX) return this.fail(row, `${reason} (${failed} waits in a row)`, false)
    await this.deps
      .sql`UPDATE factory.fleet_windows SET waits_failed = ${failed}, updated_at = ${this.deps.now()} WHERE hash = ${row.hash}`
    return { called: false, error: reason }
  }

  private async finish(
    row: Row,
    reply: Extract<Reply, { kind: 'done' }>,
  ): Promise<{ called: boolean; error?: string }> {
    // The run is done and its answer is bad: terminal, so the retry is a new run and not the same answer again.
    if (reply.paragraph === null)
      return this.fail(row, reply.reason ?? 'the window item was not answered', true, reply.cost)
    const { sql } = this.deps
    const now = this.deps.now()
    try {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE factory.fleet_windows
          SET state = 'ready', paragraph = ${reply.paragraph}, run_id = NULL, failures = 0, waits_failed = 0, retry_at = NULL, error = NULL, updated_at = ${now}
          WHERE hash = ${row.hash}`
        await this.journal(tx, row, { ok: true, cost: reply.cost })
      })
    } catch (error) {
      return this.fail(row, `the answer could not be stored: ${message(error)}`, false, reply.cost)
    }
    return { called: true }
  }

  /**
   * A failed call. The window waits 15 min, doubled with every failure in a row, at most 6 h; the groups stand without the paragraph. If the
   * default reading has asked for another window since (one that is queued, or requested after this one), this window is stale and is
   * superseded instead: it would only spend the daily cap on a window nobody reads.
   */
  private async fail(
    row: Row,
    reason: string,
    terminal: boolean,
    cost: number | null = null,
  ): Promise<{ called: boolean; error: string }> {
    const now = this.deps.now()
    const failures = row.failures + 1
    const wait = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS)
    await this.deps.sql.begin(async (tx) => {
      // Under the lock a request holds, so a request being made now is seen.
      await tx`SELECT pg_advisory_xact_lock(${LOCKS.windows})`
      await tx`
        UPDATE factory.fleet_windows
        SET state = CASE WHEN EXISTS (
              SELECT 1 FROM factory.fleet_windows w
              WHERE w.hash <> ${row.hash} AND (w.state = 'queued'
                OR (w.state <> 'superseded' AND w.requested_at > (SELECT requested_at FROM factory.fleet_windows WHERE hash = ${row.hash})))
            ) THEN 'superseded' ELSE 'failed' END,
            run_id = NULL, failures = ${failures}, waits_failed = 0, retry_at = ${new Date(now.getTime() + wait)},
            error = ${reasonText(reason)}, updated_at = ${now}
        WHERE hash = ${row.hash}`
      await this.journal(tx, row, { ok: false, cost, error: reason, terminal })
    })
    return { called: true, error: reason }
  }

  private async journal(
    sql: SQL,
    row: Row,
    run: { ok: boolean; cost?: number | null; error?: string; terminal?: boolean },
  ): Promise<void> {
    await sql`
      INSERT INTO factory.fleet_digest_runs (at, ok, items, failed_items, cost_usd, error, batch_hash, terminal)
      VALUES (${this.deps.now()}, ${run.ok}, 1, ${run.ok ? 0 : 1}, ${run.cost ?? null}, ${run.error ? reasonText(run.error) : null},
              ${`window:${row.hash}`}, ${run.terminal ?? false})`
  }

  /** One `agw` process: `done` with the paragraph (or why there is none), `pending` with the run's id, `hung` past the guard. Anything else throws a `CallFailed`. */
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
    if (isTerminal(status)) throw new CallFailed(`the window run is ${status}`, 'terminal')
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
    const answer = parsed.data.output.results.find((r) => r.id === 'w')
    const cost = parsed.data.cost ?? null
    if (!answer || 'error' in answer) {
      return { kind: 'done', paragraph: null, cost, reason: 'the window item came back as an error' }
    }
    const paragraph = Paragraph.safeParse(answer)
    return paragraph.success
      ? { kind: 'done', paragraph: paragraph.data.paragraph, cost, reason: null }
      : { kind: 'done', paragraph: null, cost, reason: 'the window paragraph broke its schema' }
  }
}

/** `superseded` reads as `pending`: a newer window took its place, and asking for this one again queues it. */
const toHeadline = (row: Pick<Row, 'state' | 'paragraph'>): SinceHeadline => {
  if (row.state === 'ready' && row.paragraph) return { state: 'ready', text: row.paragraph }
  if (row.state === 'failed') return { state: 'failed', text: null }
  return { state: 'pending', text: null }
}
