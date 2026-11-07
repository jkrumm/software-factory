import type { ReadAccountQuota, ReadInsights, ReadSessionCard } from '@software-factory/contract'
import type { SQL } from 'bun'
import type { HookFact, SessionView } from '../domains/leads/session.ts'
import type { Clock } from '../kernel/clock.ts'
import { cut, plainText } from './plain.ts'

/**
 * A session is one lead attempt: its id is the lead key `lead-<n>-<attempt>`, its state is what its hook events derive when
 * read (`deriveSession`, injected: `read/` may not import domain code), its terminal and account come from the attempt's row.
 */

/** The session derivation of the leads domain, passed in by the composition. */
export type DeriveSession = (facts: readonly HookFact[]) => SessionView

export interface SessionDeps {
  sql: SQL
  clock: Clock
  deriveSession: DeriveSession
}

/** What a session card needs to know of its Issue. */
export interface IssueBrief {
  id: string
  number: number
  repo: string
  title: string
  visible: boolean
  closed: boolean
}

interface AttemptRow {
  issue_id: string
  attempt: number
  account: string | null
  terminal: string | null
  tab: string | null
  space: string | null
  first_try_at: Date
  started_at: Date | null
  gone_at: Date | null
}

interface FactRow {
  session: string
  key: string
  kind: string
  at: Date
  seq: string
  payload: unknown
}

export const leadKeyOf = (issueId: string, attempt: number): string =>
  `lead-${issueId.slice('issue_'.length)}-${attempt}`

/** `12`, `#12` or `issue_12` as `issue_12`; null for anything else. */
export function issueRefOf(text: string): string | null {
  const match = /^(?:issue_|#)?([1-9][0-9]*)$/.exec(text.trim())
  return match?.[1] ? `issue_${match[1]}` : null
}

export const issueNumberOf = (ref: string): number => Number(ref.slice('issue_'.length))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The Issues' briefs: repo, filed title and whether the repo is a work repo (a project with no `project.yaml`). */
export async function loadBriefs(sql: SQL, ids: readonly string[]): Promise<Map<string, IssueBrief>> {
  const found = new Map<string, IssueBrief>()
  if (ids.length === 0) return found
  const rows: { id: string; repo: string; title: string; state: string; work: boolean }[] = await sql`
    SELECT i.id, i.repo, i.state, f.payload->>'title' AS title,
      EXISTS (SELECT 1 FROM factory.planning_projects p WHERE p.name = i.repo AND p.source = 'defaults') AS work
    FROM factory.issues i
    JOIN factory.issue_events f ON f.issue_id = i.id AND f.kind = 'filed' AND f.version = 1
    WHERE i.id IN ${sql(ids)}`
  for (const row of rows) {
    found.set(row.id, {
      id: row.id,
      number: issueNumberOf(row.id),
      repo: row.repo,
      title: row.title,
      visible: row.work,
      closed: row.state === 'closed',
    })
  }
  return found
}

/** The attempts of these Issues (all of them), or the newest attempts of any Issue when `issueIds` is null. */
export async function loadAttempts(sql: SQL, issueIds: readonly string[] | null, limit: number): Promise<AttemptRow[]> {
  if (issueIds?.length === 0) return []
  const rows: unknown[] = issueIds
    ? await sql`
        SELECT issue_id, attempt, account, terminal, tab, space, first_try_at, started_at, gone_at
        FROM factory.lead_attempts WHERE issue_id IN ${sql(issueIds)} ORDER BY issue_id, attempt`
    : await sql`
        SELECT issue_id, attempt, account, terminal, tab, space, first_try_at, started_at, gone_at
        FROM factory.lead_attempts ORDER BY first_try_at DESC, issue_id, attempt DESC LIMIT ${limit}`
  return rows as AttemptRow[]
}

async function loadFacts(sql: SQL, keys: readonly string[]): Promise<Map<string, HookFact[]>> {
  const facts = new Map<string, HookFact[]>()
  if (keys.length === 0) return facts
  const rows: FactRow[] = await sql`
    SELECT session, key, kind, at, seq::text AS seq, payload FROM factory.lead_hook_events
    WHERE session IN ${sql(keys)} ORDER BY at, seq`
  for (const row of rows) {
    const list = facts.get(row.session) ?? []
    list.push({
      key: row.key,
      kind: row.kind as HookFact['kind'],
      at: row.at,
      seq: Number(row.seq),
      payload: isRecord(row.payload) ? row.payload : {},
    })
    facts.set(row.session, list)
  }
  return facts
}

/** Time a turn was open: started to ended, or to `until` while it is open. */
function workingMsOf(facts: readonly HookFact[], until: Date): number {
  let total = 0
  let openedAt: Date | null = null
  for (const fact of facts) {
    if (fact.kind === 'turn_started') openedAt ??= fact.at
    if ((fact.kind === 'turn_ended' || fact.kind === 'session_ended') && openedAt) {
      total += Math.max(0, fact.at.getTime() - openedAt.getTime())
      openedAt = null
    }
  }
  return openedAt ? total + Math.max(0, until.getTime() - openedAt.getTime()) : total
}

export const emptyInsights = (input: { startedAt: Date; endedAt: Date | null; now: Date }): ReadInsights => ({
  startedAt: input.startedAt.toISOString(),
  endedAt: input.endedAt?.toISOString() ?? null,
  elapsedMs: Math.max(0, (input.endedAt ?? input.now).getTime() - input.startedAt.getTime()),
  workingMs: 0,
  turns: 0,
  toolCalls: 0,
  subagents: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  models: [],
  attempts: 1,
  partial: true,
})

/** One derived attempt: the card and what an Issue sums. */
export interface LeadSession {
  card: ReadSessionCard
  attempt: number
  alive: boolean
  workingMs: number
  turns: number
}

const SESSION_SENTENCE: Record<ReadSessionCard['state'], string> = {
  starting: 'Starting up.',
  working: 'Working on its current turn.',
  idle: 'Idle: its turn is done.',
  waiting: 'Waiting.',
  walled: "Paused at the account's usage limit.",
  blocked: 'Blocked on a permission prompt.',
  stuck: 'No sign of life for a long time.',
  dead: 'Ended.',
}

function stateOf(attempt: AttemptRow, view: SessionView): ReadSessionCard['state'] {
  if (attempt.gone_at || view.state === 'gone') return 'dead'
  if (view.walled) return 'walled'
  if (view.state === 'working') return 'working'
  return view.state === 'starting' ? 'starting' : 'idle'
}

/** The session cards of these attempts, each with its figures. */
export async function deriveLeads(
  deps: SessionDeps,
  input: {
    attempts: readonly AttemptRow[]
    briefs: ReadonlyMap<string, IssueBrief>
    quota: ReadonlyMap<string, ReadAccountQuota>
  },
): Promise<LeadSession[]> {
  const now = deps.clock.now()
  const keys = input.attempts.map((a) => leadKeyOf(a.issue_id, a.attempt))
  const facts = await loadFacts(deps.sql, keys)
  return input.attempts.flatMap((attempt): LeadSession[] => {
    const brief = input.briefs.get(attempt.issue_id)
    if (!brief) return []
    const id = leadKeyOf(attempt.issue_id, attempt.attempt)
    const mine = facts.get(id) ?? []
    const view = deps.deriveSession(mine)
    const state = stateOf(attempt, view)
    const dead = state === 'dead'
    const startedAt = attempt.started_at ?? attempt.first_try_at
    const lastActivity = view.lastEventAt ?? attempt.started_at ?? attempt.first_try_at
    const endedAt = dead ? (view.lastEventAt ?? attempt.gone_at ?? now) : null
    const workingMs = workingMsOf(mine, endedAt ?? now)
    const terminal = attempt.terminal || attempt.tab || attempt.space
    return [
      {
        attempt: attempt.attempt,
        alive: !dead,
        workingMs,
        turns: view.turns,
        card: {
          id,
          issue: brief.number,
          issueRef: brief.id,
          parent: null,
          role: 'lead',
          title: `Issue lead: ${cut(plainText(brief.title), 80)}`,
          summary: SESSION_SENTENCE[state],
          state,
          status: state,
          wait: null,
          account: attempt.account,
          quota: attempt.account ? (input.quota.get(attempt.account) ?? null) : null,
          model: null,
          turn: view.turns,
          terminal: terminal
            ? {
                id: attempt.terminal,
                name: attempt.terminal ? id : null,
                space: attempt.space,
                tab: attempt.tab,
                workspace: null,
              }
            : null,
          address: attempt.terminal,
          tab: attempt.tab,
          transcriptPath: view.transcriptPath,
          repo: brief.repo,
          visible: brief.visible,
          since: startedAt.toISOString(),
          lastActivityAt: lastActivity.toISOString(),
          insights: { ...emptyInsights({ startedAt, endedAt, now }), workingMs, turns: view.turns },
        },
      },
    ]
  })
}
