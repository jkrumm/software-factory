import {
  type ChangeList,
  READ_API_VERSION,
  type ReadAccountQuota,
  type ReadAskList,
  type ReadHealthLine,
  type ReadIssueCard,
  type ReadIssueDetail,
  type ReadOverview,
  type ReadSessionCard,
  type ReadUptime,
  workCountsOf,
} from '@software-factory/contract'
import { readAccounts } from './accounts.ts'
import { readAsks } from './asks.ts'
import { DEFAULT_LIMIT, issueDetail, type IssueScope, listCards, MAX_LIMIT } from './issues.ts'
import type { QueueReasons } from './flow.ts'
import { type LineSources, readHealthLines } from './lines.ts'
import {
  redactAsk,
  redactHealth,
  redactIssueCard,
  redactIssueDetail,
  redactOverview,
  redactSessionCard,
} from './surface.ts'
import { deriveLeads, issueRefOf, loadAttempts, loadBriefs, type SessionDeps } from './sessions.ts'
import { changesAfter, follow, formatCursor, resolveCursor, type StreamEvent } from './stream.ts'
import { isWorkRepo, loadOpenProjects } from './work.ts'

export interface ReadDeps extends SessionDeps, LineSources {
  /** how often the change stream looks for news */
  streamPollMs: number
  /** why each queued Issue stays queued (the capacity use case reads the host); absent or failing, a queued card says the general sentence */
  queueReasons?: () => Promise<QueueReasons | null>
  /** the monitors' last good count, or null (off, never read, too old); absent is null */
  uptime?: () => ReadUptime | null
}

/** `redact`: the caller holds the read token, and a work repo loses its text (`surface.ts`). */
export interface Surface {
  redact: boolean
}

/** Sessions `/v1/sessions` looks at without an Issue: the newest, a page of this many unless `limit` says otherwise. */
const SESSION_LIMIT = 200
const SESSION_LIMIT_MAX = 1000

/** One page of session cards; `next` is the `before` of the following page, null when this one reached the oldest. */
export interface SessionPage {
  sessions: ReadSessionCard[]
  next: string | null
}

const clampLimit = (limit: number | undefined): number => Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

/** The read API as the routes use it: every answer is built here, whole, from the stored facts. */
export interface ReadApi {
  overview(input: Surface): Promise<ReadOverview>
  issues(input: Surface & { scope: IssueScope; limit?: number; repo?: string }): Promise<ReadIssueCard[]>
  /** `issue_12` or `12`; null when there is no such Issue or the text is no Issue */
  issue(input: Surface & { id: string }): Promise<ReadIssueDetail | null>
  sessions(
    input: Surface & { issue?: string; role?: string; live?: boolean; limit?: number; before?: Date },
  ): Promise<SessionPage | null>
  session(input: Surface & { id: string }): Promise<ReadSessionCard | null>
  asks(input: Surface): Promise<ReadAskList>
  health(input: Surface): Promise<ReadHealthLine[]>
  accounts(): Promise<ReadAccountQuota[]>
  /** `issue` is `issue_<n>`; the changes after `since` (none given: no changes, the current cursor); throws `CursorGone` */
  changes(input: { since?: string; issue?: string; limit?: number }): Promise<ChangeList>
  /** opens the stream after validating its cursor, so a bad one is an error before any byte is sent */
  stream(input: { since?: string; issue?: string; signal: AbortSignal }): Promise<AsyncGenerator<StreamEvent>>
}

export function createReader(deps: ReadDeps): ReadApi {
  const { sql, clock } = deps

  const quotaOf = async (): Promise<Map<string, ReadAccountQuota>> =>
    new Map((await readAccounts(sql, clock.now())).map((account) => [account.account, account]))

  const queueOf = async (): Promise<QueueReasons | null> => (await deps.queueReasons?.().catch(() => null)) ?? null

  async function overview({ redact }: Surface): Promise<ReadOverview> {
    const now = clock.now()
    const openProjects = redact ? await loadOpenProjects(sql) : []
    const accounts = await readAccounts(sql, now)
    const quota = new Map(accounts.map((account) => [account.account, account]))
    const open: { id: string; state: string; wait_reason: string | null }[] = await sql`
      SELECT id, state, wait_reason FROM factory.issues WHERE state <> 'closed'`
    // one capacity read serves both the counts and the cards
    let asked: Promise<QueueReasons | null> | undefined
    const queueOnce = (): Promise<QueueReasons | null> => (asked ??= queueOf())
    const reasons = open.some((row) => row.state === 'queued') ? await queueOnce() : null
    const work = workCountsOf(
      open.map((row) => ({
        state: row.state,
        waitReason: row.wait_reason,
        queueKind: reasons?.get(row.id)?.kind ?? null,
      })),
    )
    const [{ asks, humanQueue }, health, issues, states] = await Promise.all([
      readAsks(sql, now),
      readHealthLines(sql, { now, accounts, sources: deps }),
      listCards(deps, { scope: 'open', limit: MAX_LIMIT, quota, queue: queueOnce }),
      sql`SELECT project, state FROM factory.capacity_queue_states` as Promise<
        { project: string; state: 'run' | 'pace' | 'drain' }[]
      >,
    ])
    const body: ReadOverview = {
      version: READ_API_VERSION,
      now: now.toISOString(),
      builtAt: now.toISOString(),
      counts: {
        work,
        asks: asks.length,
        humanQueue: humanQueue.filter((ask) => !ask.stale).length,
        health: health.length,
      },
      asks,
      humanQueue,
      health,
      accounts,
      uptime: deps.uptime?.() ?? null,
      issues,
      queue: {
        effective: states.find((row) => row.project === '')?.state ?? 'run',
        spawns: [],
        // a work project's name is its words: under the read token its scope is not listed
        projects: Object.fromEntries(
          states
            .filter((row) => row.project !== '' && !(redact && isWorkRepo(row.project, openProjects)))
            .map((row) => [row.project, row.state]),
        ),
      },
    }
    return redact ? redactOverview(body) : body
  }

  async function sessions(
    input: Surface & { issue?: string; role?: string; live?: boolean; limit?: number; before?: Date },
  ): Promise<SessionPage | null> {
    const ref = input.issue === undefined ? undefined : issueRefOf(input.issue)
    if (ref === null) return null
    const limit = Math.min(Math.max(input.limit ?? SESSION_LIMIT, 1), SESSION_LIMIT_MAX)
    const attempts = await loadAttempts(sql, ref ? [ref] : null, limit, input.live === true, input.before ?? null)
    const briefs = await loadBriefs(sql, [...new Set(attempts.map((a) => a.issue_id))])
    const { leads } = await deriveLeads(deps, { attempts, briefs, quota: await quotaOf() })
    const cards = leads
      .map((lead) => (input.redact ? redactSessionCard(lead.card) : lead.card))
      .filter(
        (card) => (input.role === undefined || card.role === input.role) && (!input.live || card.state !== 'dead'),
      )
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.id.localeCompare(b.id))
    // an Issue's own list is whole; a full page of the newest attempts has an older page behind it
    const oldest = ref ? null : attempts.length >= limit ? attempts[attempts.length - 1] : null
    return { sessions: cards, next: oldest ? oldest.first_try_at.toISOString() : null }
  }

  return {
    overview,
    sessions,

    async issues({ redact, scope, limit, repo }) {
      const cards = await listCards(deps, {
        scope,
        limit: clampLimit(limit),
        ...(repo === undefined ? {} : { repo }),
        quota: await quotaOf(),
        queue: queueOf,
      })
      return redact ? cards.map(redactIssueCard) : cards
    },

    async issue({ redact, id }) {
      const ref = issueRefOf(id)
      if (!ref) return null
      const detail = await issueDetail(deps, { id: ref, quota: await quotaOf(), queue: queueOf })
      if (!detail) return null
      return redact ? redactIssueDetail(detail) : detail
    },

    async session({ redact, id }) {
      const match = /^lead-([1-9][0-9]*)-[1-9][0-9]*$/.exec(id)
      if (!match?.[1]) return null
      const found = await sessions({ redact, issue: match[1] })
      return found?.sessions.find((card) => card.id === id) ?? null
    },

    async asks({ redact }) {
      const { asks, humanQueue } = await readAsks(sql, clock.now())
      return redact ? { asks: asks.map(redactAsk), humanQueue: humanQueue.map(redactAsk) } : { asks, humanQueue }
    },

    async health({ redact }) {
      const now = clock.now()
      const lines = await readHealthLines(sql, { now, accounts: await readAccounts(sql, now), sources: deps })
      return redact ? lines.map(redactHealth) : lines
    },

    accounts: () => readAccounts(sql, clock.now()),

    async changes({ since, issue, limit }) {
      const cursor = await resolveCursor(sql, since)
      if (!since) return { changes: [], cursor: formatCursor(cursor) }
      const { changes, next } = await changesAfter(sql, { cursor, issue: issue ?? null, limit: clampLimit(limit) })
      return { changes, cursor: formatCursor(next) }
    },

    async stream({ since, issue, signal }) {
      const cursor = await resolveCursor(sql, since)
      return follow(sql, { cursor, issue: issue ?? null, pollMs: deps.streamPollMs, signal })
    },
  }
}
