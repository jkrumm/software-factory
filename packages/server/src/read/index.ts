import { basename } from 'node:path'
import {
  type AccountQuota,
  API_VERSION,
  type Fleet,
  type FleetAsk,
  type FleetSession,
  type Insights,
  type IssueCard,
  type IssueDetail,
  type IssueSummary,
  type Overview,
  type ReadAsk,
  type ReadHealth,
  type SessionCard,
  type SessionState,
  type Terminal,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import { latestReadings, toQuota } from '../capacity.ts'
import type { Clock } from '../clock.ts'
import { type DigestView, readDigestCache } from '../fleet/digest.ts'
import { STALE_ASK_MS } from '../fleet/model.ts'
import { namesIuRoot } from '../fleet/place.ts'
import { readSnapshot } from '../fleet/store.ts'
import { getIssueView } from '../issues/follow.ts'
import { isLeadSession, leadKey } from '../issues/names.ts'
import { listIssues } from '../issues/read.ts'
import { type Loaded, loadByIds } from '../sessions.ts'
import { cut, describeEvent, firstSentence } from './describe.ts'
import { fallbackWords } from './plain.ts'
import { sumInsights, type TimedEvent, TranscriptInsights, workingOf } from './insights.ts'

export { describeEvent } from './describe.ts'

/** The default list length of `/v1/issues`, and its ceiling. */
export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 500
/** Sessions `/v1/sessions` looks at without an Issue: the newest. */
const SESSION_LIMIT = 200
/** How far down a lead's tree of started sessions is followed. */
const TREE_DEPTH = 4
const TITLE_WORDS_MAX = 80
/** The raw text of an ask or a health line in the read API: one line, cut at a word. */
const LINE_TEXT_MAX = 240

export interface ReadDeps {
  sql: SQL
  clock: Clock
  /** whether a place is IuRoot's or a visible root's (`Places.isVisible`); by the path alone without */
  isVisible?: (path: string) => boolean
  /** the transcript counter, shared so its cache lives as long as the server */
  insights?: TranscriptInsights
}

/**
 * A `reply` ask of an Issue's lead is the Issue's open decision asked twice: it goes when an ask of source `decision` for the same
 * Issue is there (decision ids are `decision:<issue>:<attempt>:...`).
 */
export function dropReplyDuplicates(asks: readonly FleetAsk[]): FleetAsk[] {
  const decided = new Set(asks.flatMap((a) => (a.source === 'decision' ? [/^decision:(\d+):/.exec(a.id)?.[1]] : [])))
  return asks.filter((a) => {
    if (a.source !== 'reply' || !a.session || !isLeadSession(a.session)) return true
    return !decided.has(a.session.split('-')[1])
  })
}

/** Thrown where a resource needs the fleet snapshot and none is stored yet: the route answers 503 `not_ready`. */
export class NotReady extends Error {}

interface Context {
  now: Date
  snapshot: Fleet | undefined
  digest: DigestView
  quota: ReadonlyMap<string, AccountQuota>
  placed: ReadonlyMap<string, { session: FleetSession; space: string; visible: boolean }>
}

/** A session as the projection holds it: its card and the figures an Issue sums. */
interface Bundle {
  card: SessionCard
  insights: Insights
}

const ROLE_WORDS: Record<string, string> = {
  lead: 'Issue lead',
  implementer: 'Implementer',
  verifier: 'Verifier',
  reviewer: 'Reviewer',
}

const roleWords = (role: string | null): string =>
  role === null
    ? 'Session'
    : (ROLE_WORDS[role] ?? role.charAt(0).toUpperCase() + role.slice(1).replaceAll(/[-_]/g, ' '))

const SESSION_SENTENCE: Record<SessionState, string> = {
  starting: 'Starting up.',
  working: 'Working on its current turn.',
  idle: 'Idle: its turn is done.',
  waiting: 'Waiting.',
  walled: "Paused at the account's usage limit.",
  blocked: 'Blocked on a permission prompt.',
  stuck: 'No sign of life for a long time.',
  dead: 'Ended.',
}

const WAIT_SENTENCE = {
  owner: 'Waiting for the owner.',
  workers: 'Waiting for the sessions it started.',
  deploy: 'Waiting for a deploy to finish.',
} as const

const WAITING_ISSUE: Record<string, string> = {
  wait: 'Waiting for a set time.',
  blocked: 'Blocked, waiting for help.',
  decision: 'Waiting for the owner to decide.',
  wall: "Paused at the account's usage limit.",
  dependency: 'Waiting for another Issue to land.',
  parked: 'Parked: it needs a look.',
  unreported: 'The lead stopped without reporting.',
  lead_gone: 'The lead ended and no new attempt will start.',
  claim: 'Answered, waiting for the repo to be free.',
}

/** The fixed sentence for an Issue that has said nothing of its own yet. */
function stateSentence(issue: IssueSummary): string {
  switch (issue.state) {
    case 'queued':
      return 'Queued, waiting for a free account.'
    case 'settling':
      return 'Being settled.'
    case 'working':
      return 'A lead is working on it.'
    case 'watching':
      return 'Shipped, held for its check.'
    case 'waiting':
      return (issue.reason && WAITING_ISSUE[issue.reason]) || 'Waiting.'
    case 'closed':
      return issue.outcome === 'dropped'
        ? 'Dropped.'
        : issue.outcome === 'healed'
          ? 'Healed by itself.'
          : 'Closed as done.'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

export class Reader {
  private readonly insights: TranscriptInsights
  private readonly isVisible: (path: string) => boolean

  constructor(private readonly deps: ReadDeps) {
    this.insights = deps.insights ?? new TranscriptInsights()
    this.isVisible = deps.isVisible ?? namesIuRoot
  }

  /** `GET /v1/overview`: counts from the Issues table, the rest from the stored fleet snapshot. */
  async overview(): Promise<Overview> {
    const { sql, clock } = this.deps
    const ctx = await this.context()
    if (!ctx.snapshot) throw new NotReady('the fleet model is not built yet')
    const rows: { state: string; n: number }[] = await sql`
      SELECT state, count(*)::int AS n FROM factory.issues WHERE state <> 'closed' GROUP BY state`
    const n = (state: string): number => rows.find((r) => r.state === state)?.n ?? 0
    const { asks, humanQueue, health } = this.words(ctx, ctx.snapshot)
    return {
      version: API_VERSION,
      now: clock.now().toISOString(),
      builtAt: ctx.snapshot.builtAt,
      counts: {
        working: n('working'),
        waiting: n('waiting'),
        queued: n('queued'),
        watching: n('watching'),
        asks: asks.length,
        humanQueue: humanQueue.filter((a) => !a.stale).length,
        health: health.length,
      },
      asks,
      humanQueue,
      health,
      accounts: [...ctx.quota.values()],
      queue: ctx.snapshot.queue,
    }
  }

  /** The lists of the overview, whole. */
  async lists(): Promise<{
    asks: ReadAsk[]
    humanQueue: ReadAsk[]
    health: ReadHealth[]
    accounts: AccountQuota[]
  }> {
    const ctx = await this.context()
    if (!ctx.snapshot) throw new NotReady('the fleet model is not built yet')
    return { ...this.words(ctx, ctx.snapshot), accounts: [...ctx.quota.values()] }
  }

  /**
   * The asks and health lines in plain words: the digest's answer for the line when it has one, else a reply ask's own `short`, else
   * the deterministic fallback. The digest never reads a visible place's line, so none of its answers is shown for one.
   */
  private words(ctx: Context, snapshot: Fleet): { asks: ReadAsk[]; humanQueue: ReadAsk[]; health: ReadHealth[] } {
    const visibleSpaces = new Set(snapshot.repos.filter((r) => r.visible).map((r) => r.space))
    const model = (line: { repo: string | null; session?: string | null; text: string }) => {
      const visible =
        (line.repo !== null && (visibleSpaces.has(line.repo) || this.isVisible(line.repo))) ||
        (!!line.session && !!ctx.placed.get(line.session)?.visible)
      return visible ? null : ctx.digest.line(line.text)
    }
    const all = dropReplyDuplicates(snapshot.asks).map((ask): ReadAsk => {
      const fallback = fallbackWords(ask.text, 'ask')
      const said = model(ask)
      return {
        ...ask,
        text: cut(ask.text, LINE_TEXT_MAX),
        short: said?.short ?? ask.short ?? fallback.short,
        summary: said?.summary ?? fallback.summary,
        stale: ctx.now.getTime() - Date.parse(ask.at) >= STALE_ASK_MS,
      }
    })
    const health = snapshot.health.map((line): ReadHealth => {
      const fallback = fallbackWords(line.text, 'health')
      const said = model(line)
      return {
        ...line,
        text: cut(line.text, LINE_TEXT_MAX),
        short: said?.short ?? fallback.short,
        summary: said?.summary ?? fallback.summary,
      }
    })
    return {
      asks: all.filter((a) => a.source !== 'queue'),
      humanQueue: all.filter((a) => a.source === 'queue'),
      health,
    }
  }

  async accounts(): Promise<AccountQuota[]> {
    return [...(await this.context()).quota.values()]
  }

  /** `GET /v1/issues`: open first by recent activity. */
  async issues(options: { scope: 'open' | 'closed' | 'all'; limit: number }): Promise<IssueCard[]> {
    const { sql } = this.deps
    const ctx = await this.context()
    const issues = await listIssues(sql, options.limit, { scope: options.scope, byActivity: true })
    return this.cards(ctx, issues)
  }

  /** `GET /v1/issues/:id`. */
  async issue(id: number): Promise<IssueDetail | undefined> {
    const { sql } = this.deps
    const view = await getIssueView(sql, id)
    if (!view) return undefined
    const ctx = await this.context()
    const { sessions, card } = await this.cardWithSessions(ctx, view)
    return {
      ...card,
      timeline: view.timeline
        .filter((entry) => entry.source === 'event')
        .map((e) => ({
          at: e.at,
          kind: e.kind,
          text: describeEvent(e.kind, e.from, e.to, e.payload),
          session: e.session,
        })),
      evidence: view.evidence.map((e) => ({
        kind: e.kind,
        link: e.link,
        note: isRecord(e.payload) ? text(e.payload.note) : null,
        at: e.at,
      })),
      asks: view.decisions.map((d) => ({
        question: d.question,
        options: Array.isArray(d.options) ? d.options.filter((o): o is string => typeof o === 'string') : [],
        default: d.default,
        answer: d.answer,
        askedAt: d.askedAt,
      })),
      sessions,
    }
  }

  /** `GET /v1/sessions`: an Issue's tree, or the newest sessions; `live` leaves the ended ones out. */
  async sessions(filter: { issue?: number; role?: string; live?: boolean }): Promise<SessionCard[]> {
    const { sql, clock } = this.deps
    const ctx = await this.context()
    const newest: { id: string }[] =
      filter.issue === undefined
        ? await sql`SELECT id FROM factory.sessions ORDER BY created_at DESC, id LIMIT ${SESSION_LIMIT}`
        : await this.trees([filter.issue])
    const ids = newest.map((r) => r.id)
    const bundles = await this.bundles(ctx, await loadByIds(sql, ids, clock.now()))
    return [...bundles.values()]
      .map((b) => b.card)
      .filter((c) => (filter.role === undefined || c.role === filter.role) && (!filter.live || c.state !== 'dead'))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.id.localeCompare(b.id))
  }

  async session(id: string): Promise<SessionCard | undefined> {
    const { sql, clock } = this.deps
    const ctx = await this.context()
    const bundles = await this.bundles(ctx, await loadByIds(sql, [id], clock.now()))
    return bundles.get(id)?.card
  }

  /** The Issue each of these sessions belongs to: its own, else its nearest ancestor's (the session that started it). */
  async issuesOf(ids: readonly string[]): Promise<Map<string, number>> {
    const { sql } = this.deps
    const found = new Map<string, number>()
    if (ids.length === 0) return found
    const rows: { origin: string; issue_id: number }[] = await sql`
      WITH RECURSIVE chain AS (
        SELECT s.id AS origin, s.id AS cur, s.issue_id, 0 AS depth FROM factory.sessions s WHERE s.id IN ${sql(ids)}
        UNION ALL
        SELECT c.origin, p.parent, ps.issue_id, c.depth + 1 FROM chain c
        JOIN factory.sessions cs ON cs.id = c.cur
        JOIN factory.spawns p ON p.key = cs.spawn_key
        JOIN factory.sessions ps ON ps.id = p.parent
        WHERE c.issue_id IS NULL AND c.depth < ${TREE_DEPTH})
      SELECT origin, issue_id FROM chain WHERE issue_id IS NOT NULL`
    for (const row of rows) found.set(row.origin, row.issue_id)
    return found
  }

  // --- internals ---------------------------------------------------------------------------------------------------

  /** Every session of these Issues: their leads of every attempt and what they started. */
  private async trees(issueIds: readonly number[]): Promise<{ id: string; root: number }[]> {
    const { sql } = this.deps
    if (issueIds.length === 0) return []
    return sql`
      WITH RECURSIVE tree AS (
        SELECT s.id, s.issue_id AS root, 0 AS depth FROM factory.sessions s WHERE s.issue_id IN ${sql(issueIds)}
        UNION
        SELECT c.id, t.root, t.depth + 1 FROM tree t
        JOIN factory.spawns p ON p.parent = t.id
        JOIN factory.sessions c ON c.spawn_key = p.key
        WHERE t.depth < ${TREE_DEPTH})
      SELECT DISTINCT id, root FROM tree`
  }

  private async context(): Promise<Context> {
    const { sql, clock } = this.deps
    const now = clock.now()
    const [snapshot, digest, readings] = await Promise.all([
      readSnapshot(sql),
      readDigestCache(sql),
      latestReadings(sql),
    ])
    const quota = new Map<string, AccountQuota>(
      readings.map((r) => {
        const q = toQuota(r, now)
        return [
          q.account,
          {
            account: q.account,
            fiveHourUsed: q.fiveHourUsed,
            weeklyUsed: q.weeklyUsed,
            fiveHourResetsAt: q.fiveHourResetsAt,
            weeklyResetsAt: q.weeklyResetsAt,
            exhaustedUntil: q.exhaustedUntil,
            fresh: q.fresh,
          },
        ]
      }),
    )
    const placed = new Map<string, { session: FleetSession; space: string; visible: boolean }>()
    for (const repo of snapshot?.repos ?? []) {
      for (const session of repo.sessions) placed.set(session.id, { session, space: repo.space, visible: repo.visible })
    }
    return { now, snapshot, digest, quota, placed }
  }

  /** The cards of these Issues, in order. */
  private async cards(ctx: Context, issues: readonly IssueSummary[]): Promise<IssueCard[]> {
    if (issues.length === 0) return []
    const { sql } = this.deps
    const ids = issues.map((i) => i.id)
    const trees = await this.trees(ids)
    const bundles = await this.bundles(ctx, await loadByIds(sql, [...new Set(trees.map((t) => t.id))], ctx.now))
    const extras = await this.extras(ids)
    return issues.map((issue) => {
      const mine = trees.filter((t) => t.root === issue.id).flatMap((t) => bundles.get(t.id) ?? [])
      return this.card(ctx, issue, mine, extras)
    })
  }

  private async cardWithSessions(
    ctx: Context,
    issue: IssueSummary,
  ): Promise<{ card: IssueCard; sessions: SessionCard[] }> {
    const { sql } = this.deps
    const trees = await this.trees([issue.id])
    const bundles = await this.bundles(
      ctx,
      await loadByIds(
        sql,
        trees.map((t) => t.id),
        ctx.now,
      ),
      issue.id,
    )
    const mine = trees.flatMap((t) => bundles.get(t.id) ?? [])
    const extras = await this.extras([issue.id])
    return {
      card: this.card(ctx, issue, mine, extras),
      sessions: mine
        .map((b) => b.card)
        .sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt) || a.id.localeCompare(b.id)),
    }
  }

  /** The latest phase and the closing words per Issue, and which Issues have an open question. */
  private async extras(ids: readonly number[]): Promise<Extras> {
    const { sql } = this.deps
    const phases: { issue_id: number; payload: unknown }[] = await sql`
      SELECT DISTINCT ON (issue_id) issue_id, payload FROM factory.issue_events
      WHERE issue_id IN ${sql(ids)} AND kind = 'phase' ORDER BY issue_id, id DESC`
    const closings: { issue_id: number; payload: unknown }[] = await sql`
      SELECT DISTINCT ON (issue_id) issue_id, payload FROM factory.issue_events
      WHERE issue_id IN ${sql(ids)} AND kind IN ('close', 'ship', 'drop', 'stop') ORDER BY issue_id, id DESC`
    const asking: { issue_id: number }[] = await sql`
      SELECT DISTINCT issue_id FROM factory.decisions WHERE issue_id IN ${sql(ids)} AND answered_at IS NULL`
    return {
      phases: new Map(phases.map((p) => [p.issue_id, p.payload])),
      closings: new Map(closings.map((p) => [p.issue_id, p.payload])),
      asking: new Set(asking.map((a) => a.issue_id)),
    }
  }

  private card(ctx: Context, issue: IssueSummary, sessions: readonly Bundle[], extras: Extras): IssueCard {
    const visible = this.isVisible(issue.repo)
    const open = issue.state !== 'closed'
    const phasePayload = extras.phases.get(issue.id)
    const phase = isRecord(phasePayload) && phasePayload.attempt === issue.attempt ? text(phasePayload.phase) : null
    const phaseNote = isRecord(phasePayload) && phasePayload.attempt === issue.attempt ? text(phasePayload.note) : null
    const leads = sessions.filter((b) => b.card.role === 'lead' && b.card.issue === issue.id)
    const current = leads.find((b) => b.card.id === leadKey(issue.id, issue.attempt))
    const lead = open && current && current.card.state !== 'dead' ? current.card.id : null
    const closing = extras.closings.get(issue.id)
    const closingWords = isRecord(closing) ? (text(closing.summary) ?? text(closing.reason)) : null
    const headline = lead && !visible ? ctx.digest.headline(lead) : null
    const summary = open
      ? (headline ?? (phaseNote ? firstSentence(phaseNote) : null) ?? stateSentence(issue))
      : closingWords
        ? firstSentence(closingWords)
        : stateSentence(issue)
    const heading = visible ? null : ctx.digest.heading(issue.title)
    const account = current?.card.account ?? null
    const startedAt = issue.createdAt
    const endedAt = issue.closedAt
    const sum = sumInsights(sessions.map((b) => b.insights))
    const elapsedMs = Math.max(0, (endedAt ? Date.parse(endedAt) : ctx.now.getTime()) - Date.parse(startedAt))
    return {
      id: issue.id,
      filedTitle: issue.title,
      title: heading ?? cut(issue.title, TITLE_WORDS_MAX),
      summary,
      state: issue.state,
      reason: issue.reason,
      outcome: issue.outcome,
      phase,
      repo: issue.repo,
      repoName: basename(issue.repo),
      visible,
      kind: issue.kind,
      size: issue.size,
      lead,
      account,
      quota: account ? (ctx.quota.get(account) ?? null) : null,
      insights: { startedAt, endedAt, elapsedMs, ...sum, attempts: issue.attempt },
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      closedAt: issue.closedAt,
      waitingOnOwner:
        open &&
        (extras.asking.has(issue.id) ||
          (issue.state === 'waiting' && (issue.reason === 'decision' || issue.reason === 'blocked'))),
    }
  }

  /** The cards of the loaded sessions with their figures; `issue` is the Issue a whole tree is known to belong to. */
  private async bundles(ctx: Context, loaded: readonly Loaded[], issue?: number): Promise<Map<string, Bundle>> {
    const { sql } = this.deps
    const out = new Map<string, Bundle>()
    if (loaded.length === 0) return out
    const ids = loaded.map((l) => l.view.id)
    const belongs = issue === undefined ? await this.issuesOf(ids) : new Map(ids.map((id) => [id, issue]))
    const keys = [...new Set(loaded.flatMap((l) => (l.view.spawn ? [l.view.spawn] : [])))]
    const spawns: { key: string; repo: string; space: string; workspace: string | null }[] =
      keys.length === 0
        ? []
        : await sql`SELECT key, repo, COALESCE(space, repo) AS space, workspace FROM factory.spawns WHERE key IN ${sql(keys)}`
    const spawnOf = new Map(spawns.map((s) => [s.key, s]))
    const own: { id: string; issue_id: number | null }[] = await sql`
      SELECT id, issue_id FROM factory.sessions WHERE id IN ${sql(ids)}`
    const ownIssue = new Map(own.map((o) => [o.id, o.issue_id]))
    await Promise.all(
      loaded.map(async (l) => {
        const s = l.view
        const fleet = ctx.placed.get(s.id)
        const spawn = s.spawn ? spawnOf.get(s.spawn) : undefined
        const repo = spawn?.repo ?? fleet?.space ?? s.cwd
        const visible = (fleet?.visible ?? false) || (repo !== null && this.isVisible(repo))
        const dead = s.state === 'dead'
        const read = await this.insights.read(s.transcriptPath)
        const events: readonly TimedEvent[] = l.facts
        const { workingMs, turns } = workingOf(events, ctx.now, dead ? new Date(s.lastEventAt) : null)
        const startedAt = (l.facts[0]?.at ?? new Date(s.lastEventAt)).toISOString()
        const endedAt = dead ? s.lastEventAt : null
        const insights: Insights = {
          startedAt,
          endedAt,
          elapsedMs: Math.max(0, (endedAt ? Date.parse(endedAt) : ctx.now.getTime()) - Date.parse(startedAt)),
          workingMs,
          turns,
          toolCalls: read.stats.toolCalls,
          subagents: read.stats.subagents,
          tokens: read.stats.tokens,
          models: read.stats.models,
          attempts: 1,
          partial: read.partial,
        }
        const terminalId = fleet?.session.terminal ?? s.pane
        const space = fleet?.space ?? spawn?.space ?? null
        const terminal: Terminal | null =
          terminalId || s.tab || spawn?.workspace
            ? { id: terminalId, name: terminalId ? s.id : null, space, tab: s.tab, workspace: spawn?.workspace ?? null }
            : null
        const headline = visible ? null : ctx.digest.headline(s.id)
        const wait = s.state === 'waiting' && s.wait ? WAIT_SENTENCE[s.wait] : null
        out.set(s.id, {
          insights,
          card: {
            id: s.id,
            issue: belongs.get(s.id) ?? ownIssue.get(s.id) ?? null,
            role: s.role,
            title: fleet?.session.title ?? roleWords(s.role),
            summary: headline ?? wait ?? SESSION_SENTENCE[s.state],
            state: s.state,
            wait: s.wait,
            account: s.account,
            quota: s.account ? (ctx.quota.get(s.account) ?? null) : null,
            model: read.stats.models.at(-1) ?? null,
            turn: s.turn,
            terminal,
            transcriptPath: s.transcriptPath,
            repo,
            visible,
            since: s.since,
            lastActivityAt: s.lastEventAt,
            insights,
          },
        })
      }),
    )
    return out
  }
}

interface Extras {
  phases: ReadonlyMap<number, unknown>
  closings: ReadonlyMap<number, unknown>
  asking: ReadonlySet<number>
}
