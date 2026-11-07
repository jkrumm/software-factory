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

export { DEFAULT_LIMIT, MAX_LIMIT }

export interface ReadDeps extends SessionDeps, LineSources {
  /** how often the change stream looks for news */
  streamPollMs: number
  /** why each queued Issue stays queued (the capacity use case reads the host); absent or failing, a queued card says the general sentence */
  queueReasons?: () => Promise<QueueReasons | null>
}

/** `redact`: the caller holds the read token, and a work repo loses its text (`surface.ts`). */
export interface Surface {
  redact: boolean
}

/** Sessions `/v1/sessions` looks at without an Issue: the newest. */
const SESSION_LIMIT = 200

const clampLimit = (limit: number | undefined): number => Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

/** The read API as the routes use it: every answer is built here, whole, from the stored facts. */
export interface ReadApi {
  overview(input: Surface): Promise<ReadOverview>
  issues(input: Surface & { scope: IssueScope; limit?: number }): Promise<ReadIssueCard[]>
  /** `issue_12` or `12`; null when there is no such Issue or the text is no Issue */
  issue(input: Surface & { id: string }): Promise<ReadIssueDetail | null>
  sessions(input: Surface & { issue?: string; role?: string; live?: boolean }): Promise<ReadSessionCard[] | null>
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
    const counts: { state: string; n: number }[] = await sql`
      SELECT state, count(*)::int AS n FROM factory.issues WHERE state <> 'closed' GROUP BY state`
    const count = (state: string): number => counts.find((row) => row.state === state)?.n ?? 0
    const [{ asks, humanQueue }, health, issues, states] = await Promise.all([
      readAsks(sql, now),
      readHealthLines(sql, { now, accounts, sources: deps }),
      listCards(deps, { scope: 'open', limit: MAX_LIMIT, quota, queue: queueOf }),
      sql`SELECT project, state FROM factory.capacity_queue_states` as Promise<
        { project: string; state: 'run' | 'pace' | 'drain' }[]
      >,
    ])
    const body: ReadOverview = {
      version: READ_API_VERSION,
      now: now.toISOString(),
      builtAt: now.toISOString(),
      counts: {
        working: count('working'),
        waiting: count('waiting'),
        queued: count('queued'),
        watching: count('watching'),
        asks: asks.length,
        humanQueue: humanQueue.filter((ask) => !ask.stale).length,
        health: health.length,
      },
      asks,
      humanQueue,
      health,
      accounts,
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

  async function sessions(input: Surface & { issue?: string; role?: string; live?: boolean }) {
    const ref = input.issue === undefined ? undefined : issueRefOf(input.issue)
    if (ref === null) return null
    const attempts = await loadAttempts(sql, ref ? [ref] : null, SESSION_LIMIT)
    const briefs = await loadBriefs(sql, [...new Set(attempts.map((a) => a.issue_id))])
    const derived = await deriveLeads(deps, { attempts, briefs, quota: await quotaOf() })
    return derived
      .map((lead) => (input.redact ? redactSessionCard(lead.card) : lead.card))
      .filter(
        (card) => (input.role === undefined || card.role === input.role) && (!input.live || card.state !== 'dead'),
      )
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.id.localeCompare(b.id))
  }

  return {
    overview,
    sessions,

    async issues({ redact, scope, limit }) {
      const cards = await listCards(deps, {
        scope,
        limit: clampLimit(limit),
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
      return found?.find((card) => card.id === id) ?? null
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
