import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type {
  Fleet,
  FleetAsk,
  FleetGit,
  FleetPlan,
  FleetRepo,
  FleetSession,
  FleetSummary,
  Status,
} from '@software-factory/contract'
import { BLOCKED_AFTER_MS } from '../rules.ts'
import { enclosingRepo } from '../projects/sync.ts'
import { parsePlan, planState } from './plans.ts'
import type { HcTerminal, QueueRequest } from './sources.ts'

/** An ask older than this counts in `summary.staleAsks`. */
export const STALE_ASK_MS = 24 * 3_600_000

/** A session as the merge left it: what the model shows, and what the plan lookup and the asks need besides. */
export interface MergedSession {
  session: Omit<FleetSession, 'plan' | 'wave'>
  /** the repo directory under a root it belongs to; undefined: no repo of the model (outside every root, or not under a repo) */
  repo: string | undefined
  /** the text it was started with, where a plan path may be named; data, scanned for a path only */
  prompt: string | null
  /** its spawn's repo, the base of a relative plan path */
  spawnRepo: string | null
  cwd: string | null
  hc: HcTerminal | undefined
}

export interface PlanFile {
  path: string
  text: string
  touched: string | null
}

export interface RepoFacts {
  path: string
  git: FleetGit | null
  plans: PlanFile[]
  /** the repo's own `docs/waves/PLAN.md`, when it has one */
  rootPlan: string | null
}

export interface DecisionRow {
  key: string
  repo: string
  question: string
  createdAt: Date
}

export interface ModelInput {
  now: Date
  /** whether a place is visible (a visible root, or IuRoot by place) */
  isVisible: (path: string) => boolean
  /** real paths */
  roots: readonly string[]
  status: Status
  sessions: MergedSession[]
  /** by session id: the plan file it works and the wave its start names */
  sessionPlans: ReadonlyMap<string, { plan: string | null; wave: number | null }>
  repos: RepoFacts[]
  decisions: DecisionRow[]
  queue: QueueRequest[]
  /** when an ask that has no time of its own (hc, a wait's fallback, an attention line) was first seen: the first build that saw it */
  firstSeen: ReadonlyMap<string, string>
  errors: string[]
}

const isWorking = (s: { state: string }) => s.state === 'working' || s.state === 'starting'

const STATE_ORDER = ['walled', 'blocked', 'stuck', 'working', 'waiting', 'starting', 'idle'] as const

const hash = (text: string, length = 12): string => createHash('sha256').update(text).digest('hex').slice(0, length)

/**
 * What an attention line is about, as the key of its ask: the session and the verb, the note, the spawn, the notification, the
 * Issue and what is wrong with it, then a short hash of the line with its digits removed: two different lines of one subject do not
 * collapse, and a counter (`for 5 min`) does not change the id.
 */
export function lineKey(line: string): string {
  return `${subjectKey(line)}:${hash(line.replace(/\d+/g, ''), 6)}`
}

function subjectKey(line: string): string {
  const session = /^(blocked|stuck|walled) (\S+?):?(?: |$)/.exec(line)
  if (session) return `${session[1]}:${session[2]}`
  const note = /^note (\S+) to /.exec(line)
  if (note) return `note:${note[1]}`
  const spawn = /^spawn (\S+) failed/.exec(line)
  if (spawn) return `spawn:${spawn[1]}`
  const notification = /^notification (\S+) was not delivered/.exec(line)
  if (notification) return `notification:${notification[1]}`
  const issue = /^Issue (\d+)(.*)$/.exec(line)
  if (issue) {
    const rest = issue[2] ?? ''
    const kinds: [RegExp, string][] = [
      [/^ parked: its lead stopped twice/, 'unreported'],
      [/^ parked: its lead is gone/, 'lead-gone'],
      [/^ blocked/, 'blocked'],
      [/^ parked/, 'parked'],
      [/^ is an alert/, 'alert-off'],
      [/^ waits for the claim/, 'claim'],
      [/^: its lead did not start/, 'lead-not-started'],
      [/^: its worktree could not be made/, 'worktree'],
      [/^: it cannot be finalized/, 'finalize'],
      [/^: its worktree was kept/, 'worktree-kept'],
    ]
    const kind = kinds.find(([pattern]) => pattern.test(rest))?.[1]
    return `issue:${issue[1]}:${kind ?? 'other'}`
  }
  return 'line'
}

/** The session or spawn or Issue an attention line names, for the repo and the session of its ask. */
function lineSubject(line: string): { session?: string; spawn?: string; issue?: number } {
  const session = /^(?:blocked|stuck|walled) (\S+)/.exec(line) ?? /^note \S+ to (\S+)/.exec(line)
  if (session?.[1]) return { session: session[1].replace(/:$/, '') }
  const spawn = /^spawn (\S+) failed/.exec(line)
  if (spawn?.[1]) return { spawn: spawn[1] }
  const issue = /^Issue (\d+)/.exec(line)
  if (issue?.[1]) return { issue: Number(issue[1]) }
  return {}
}

/** Whether a session counts as working a plan: running, or stopped mid-turn (blocked, stuck, walled), or waiting on workers or a deploy; not an idle or done tab, nor one that waits on the owner. */
const worksAPlan = (s: { state: string; wait: string | null }) =>
  s.state === 'waiting' ? s.wait !== 'owner' : s.state !== 'idle'

const askKind = (line: string): FleetAsk['kind'] =>
  /^(blocked|stuck|walled|spawn|Issue) /.test(line) ? 'blocker' : 'note'

function sessionOrder(a: FleetSession, b: FleetSession): number {
  return STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.id.localeCompare(b.id)
}

/**
 * The read model from what was read: pure, so the same sources always give the same model. Plans are parsed here, their state
 * decided against the sessions and the clock. `fingerprint` is left for `fingerprintOf`.
 */
export function assemble(input: ModelInput): Omit<Fleet, 'fingerprint' | 'digest'> {
  const { now, status } = input

  // A session's plan, and a plan's live sessions.
  const worked = new Set<string>()
  for (const m of input.sessions) {
    const plan = input.sessionPlans.get(m.session.id)?.plan
    if (plan && worksAPlan(m.session)) worked.add(plan)
  }

  const bySession = new Map<string, MergedSession>(input.sessions.map((m) => [m.session.id, m]))
  const repoOf = (path: string | undefined) => (path ? enclosingRepo(path, input.roots) : undefined)
  const spawnRepo = new Map(status.queue.spawns.map((s) => [s.key, repoOf(s.repo)]))
  const issueRepo = new Map(status.issues.map((i) => [i.id, repoOf(i.repo)]))

  const repos: FleetRepo[] = []
  const listed = new Set(input.repos.map((r) => r.path))
  for (const facts of input.repos) {
    const isVisible = input.isVisible(facts.path)
    const plans: FleetPlan[] = facts.plans.map((file) => {
      const parsed = parsePlan(file.text, { visible: isVisible })
      return {
        path: file.path,
        ...parsed,
        state: planState({ waves: parsed.waves, worked: worked.has(file.path), lastTouched: file.touched, now }),
        lastTouched: file.touched,
      }
    })
    // The plan a live session works leads (the repo's own first), then the repo's own, then the others in path order.
    const rank = (p: FleetPlan) => (p.state === 'running' ? 0 : 2) + (p.path === facts.rootPlan ? 0 : 1)
    plans.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
    const sessions: FleetSession[] = input.sessions
      .filter((m) => m.repo === facts.path)
      .map((m) => {
        const found = input.sessionPlans.get(m.session.id)
        const plan = found?.plan ?? null
        const wave =
          plan && plans.find((p) => p.path === plan)?.waves.some((w) => w.n === found?.wave)
            ? (found?.wave ?? null)
            : null
        return { ...m.session, plan, wave }
      })
      .sort(sessionOrder)
    repos.push({
      name: basename(facts.path),
      space: facts.path,
      visible: isVisible,
      git: facts.git,
      plan: plans[0] ?? null,
      morePlans: plans.slice(1),
      sessions,
    })
  }
  repos.sort((a, b) => a.name.localeCompare(b.name) || a.space.localeCompare(b.space))

  const unplaced: FleetSession[] = input.sessions
    .filter((m) => !m.repo || !listed.has(m.repo))
    .map((m) => ({ ...m.session, plan: null, wave: null }))
    .sort(sessionOrder)

  const asks: FleetAsk[] = []
  const ask = (
    a: Omit<FleetAsk, 'short' | 'suggestion' | 'actions' | 'plan' | 'tier' | 'folded' | 'occurrence'> & {
      plan?: string | null
    },
  ) => {
    const planOf = a.session ? (input.sessionPlans.get(a.session)?.plan ?? null) : null
    asks.push({
      short: null,
      tier: 'yours',
      suggestion: null,
      actions: [],
      folded: [],
      occurrence: 1,
      ...a,
      plan: a.plan ?? planOf,
    })
  }

  // The time of an ask that has none of its own: the first build that saw it (kept by the builder), never this build's.
  const seen = (id: string) => input.firstSeen.get(id) ?? now.toISOString()

  // hc's blocked, and a session that declared a wait on the owner.
  const hcBlocked = new Set<string>()
  for (const m of input.sessions) {
    const { id, wait, since } = m.session
    const repo = m.repo ?? null
    if (m.hc?.status === 'blocked') {
      // hc's own time for it (when its status last changed), else the first build that saw it; the debounce counts from there.
      const askId = `hc:${id}`
      const hcAt = m.hc.statusAt && !Number.isNaN(Date.parse(m.hc.statusAt)) ? m.hc.statusAt : null
      const at = input.firstSeen.get(askId) ?? hcAt ?? now.toISOString()
      // With no usable time from hc there is nothing to debounce from: the ask is raised at once, at the first build that saw it.
      if (hcAt === null || now.getTime() - Date.parse(at) >= BLOCKED_AFTER_MS) {
        hcBlocked.add(id)
        ask({
          id: askId,
          kind: 'permission',
          repo,
          session: id,
          text: m.hc.statusMessage ?? `${id} is blocked on a dialog`,
          source: 'hc',
          at,
        })
      }
    }
    if (wait === 'owner') {
      const askId = `wait:${id}`
      ask({
        id: askId,
        kind: 'question',
        repo,
        session: id,
        text: `${id} waits on the owner`,
        source: 'wait',
        at: since ?? seen(askId),
      })
    }
  }

  // The factory's own attention lines. Open decisions have their own asks below, and a blocked session its hc ask.
  for (const line of status.attention) {
    if (/^Issue \d+ asks: /.test(line)) continue
    // The digest's own counter (`factory status` shows it): about the model's text, not something waiting on the owner.
    if (line.startsWith('digest: ')) continue
    const subject = lineSubject(line)
    if (subject.session && /^blocked /.test(line) && hcBlocked.has(subject.session)) continue
    const id = `factory:${lineKey(line)}`
    if (asks.some((a) => a.id === id)) continue
    const session = subject.session && bySession.has(subject.session) ? subject.session : null
    const repo =
      (session ? bySession.get(session)?.repo : undefined) ??
      (subject.spawn ? spawnRepo.get(subject.spawn) : undefined) ??
      (subject.issue === undefined ? undefined : issueRepo.get(subject.issue))
    ask({
      id,
      kind: askKind(line),
      repo: repo ?? null,
      session,
      text: line,
      source: 'factory',
      at: seen(id),
    })
  }

  for (const d of input.decisions) {
    ask({
      id: `decision:${d.key}`,
      kind: 'question',
      repo: repoOf(d.repo) ?? null,
      session: null,
      text: d.question,
      source: 'decision',
      at: d.createdAt.toISOString(),
    })
  }

  for (const r of input.queue) {
    ask({ id: `queue:${r.id}`, kind: 'human', repo: null, session: null, text: r.text, source: 'queue', at: r.askedAt })
  }

  asks.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))

  // Only what is listed under a repo is counted; the unplaced are listed apart.
  const alive = repos.flatMap((r) => r.sessions)
  const summary: FleetSummary = {
    working: alive.filter(isWorking).length,
    done: alive.filter((s) => !isWorking(s) && s.hc === 'done').length,
    idle: alive.filter((s) => !isWorking(s) && s.hc !== 'done').length,
    asks: asks.length,
    staleAsks: asks.filter((a) => now.getTime() - Date.parse(a.at) >= STALE_ASK_MS).length,
  }

  return {
    builtAt: now.toISOString(),
    summary,
    asks,
    repos,
    unplaced,
    quota: status.accounts,
    queue: status.queue,
    errors: input.errors,
  }
}

/** Keys that move with the clock or with every tool call, and the digest's own spend: a model that differs only there has not changed. */
const VOLATILE = new Set(['builtAt', 'lastActivityAt', 'readAt', 'sampledAt', 'digest'])

/** sha-256 (16 hex) of the model without its volatile fields; what `NOTIFY fleet` carries. */
export function fingerprintOf(model: Omit<Fleet, 'fingerprint'>): string {
  const text = JSON.stringify(model, (key, value: unknown) => (VOLATILE.has(key) ? undefined : value))
  return hash(text, 16)
}
