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
  /** the repo directory under a root it belongs to */
  repo: string
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
  /** real paths */
  visibleRoots: readonly string[]
  roots: readonly string[]
  status: Status
  sessions: MergedSession[]
  /** by session id: the plan file it works and the wave its start names */
  sessionPlans: ReadonlyMap<string, { plan: string | null; wave: number | null }>
  repos: RepoFacts[]
  decisions: DecisionRow[]
  queue: QueueRequest[]
  /** when an ask the factory raises without a time of its own was first seen */
  firstSeen: ReadonlyMap<string, string>
  errors: string[]
}

const STATE_ORDER = ['walled', 'blocked', 'stuck', 'working', 'waiting', 'starting', 'idle'] as const

const hash = (text: string, length = 12): string => createHash('sha256').update(text).digest('hex').slice(0, length)
const isUnder = (path: string, roots: readonly string[]) => roots.some((root) => path.startsWith(`${root}/`))

/** The text of an attention line without what changes every minute, so the same condition keeps the same key. */
const stable = (line: string): string => line.replace(/\b\d+ min\b/g, 'N min')

/** What the line is about, for the repo and the session of its ask; the lines are `factory status`'s. */
function lineSubject(line: string): { session?: string; spawn?: string; issue?: number } {
  const session = /^(?:blocked|stuck|walled) (\S+)/.exec(line) ?? /^note \S+ to (\S+)/.exec(line)
  if (session?.[1]) return { session: session[1].replace(/:$/, '') }
  const spawn = /^spawn (\S+) failed/.exec(line)
  if (spawn?.[1]) return { spawn: spawn[1] }
  const issue = /^Issue (\d+)/.exec(line)
  if (issue?.[1]) return { issue: Number(issue[1]) }
  return {}
}

const askKind = (line: string): FleetAsk['kind'] =>
  /^(blocked|stuck|walled|spawn|Issue) /.test(line) ? 'blocker' : 'note'

function sessionOrder(a: FleetSession, b: FleetSession): number {
  return STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.id.localeCompare(b.id)
}

/**
 * The read model from what was read: pure, so the same sources always give the same model. Plans are parsed here, their state
 * decided against the sessions and the clock. `fingerprint` is left for `fingerprintOf`.
 */
export function assemble(input: ModelInput): Omit<Fleet, 'fingerprint'> {
  const { now, status } = input
  const visible = (repo: string) => isUnder(repo, input.visibleRoots)

  // A session's plan, and a plan's live sessions.
  const worked = new Set<string>()
  for (const m of input.sessions) {
    const plan = input.sessionPlans.get(m.session.id)?.plan
    if (plan) worked.add(plan)
  }

  const bySession = new Map<string, MergedSession>(input.sessions.map((m) => [m.session.id, m]))
  const repoOf = (path: string | undefined) => (path ? enclosingRepo(path, input.roots) : undefined)
  const spawnRepo = new Map(status.queue.spawns.map((s) => [s.key, repoOf(s.repo)]))
  const issueRepo = new Map(status.issues.map((i) => [i.id, repoOf(i.repo)]))

  const repos: FleetRepo[] = []
  for (const facts of input.repos) {
    const isVisible = visible(facts.path)
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

  const asks: FleetAsk[] = []
  const ask = (a: Omit<FleetAsk, 'short' | 'suggestion' | 'actions' | 'plan'> & { plan?: string | null }) => {
    const planOf = a.session ? (input.sessionPlans.get(a.session)?.plan ?? null) : null
    asks.push({ short: null, suggestion: null, actions: [], ...a, plan: a.plan ?? planOf })
  }

  // hc's blocked, and a session that declared a wait on the owner.
  const hcBlocked = new Set<string>()
  for (const m of input.sessions) {
    const { id, wait, since } = m.session
    const repo = m.repo ?? null
    if (m.hc?.status === 'blocked') {
      const at = since ?? m.hc.statusAt
      if (!at || now.getTime() - Date.parse(at) >= BLOCKED_AFTER_MS) {
        hcBlocked.add(id)
        ask({
          id: `hc:${id}`,
          kind: 'permission',
          repo,
          session: id,
          text: m.hc.statusMessage ?? `${id} is blocked on a dialog`,
          source: 'hc',
          at: at ?? now.toISOString(),
        })
      }
    }
    if (wait === 'owner') {
      ask({
        id: `wait:${id}`,
        kind: 'question',
        repo,
        session: id,
        text: `${id} waits on the owner`,
        source: 'wait',
        at: since ?? m.session.lastActivityAt ?? now.toISOString(),
      })
    }
  }

  // The factory's own attention lines. Open decisions have their own asks below, and a blocked session its hc ask.
  for (const line of status.attention) {
    if (/^Issue \d+ asks: /.test(line)) continue
    const subject = lineSubject(line)
    if (subject.session && /^blocked /.test(line) && hcBlocked.has(subject.session)) continue
    const id = `factory:${hash(stable(line))}`
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
      at: input.firstSeen.get(id) ?? now.toISOString(),
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

  const alive = input.sessions.map((m) => m.session)
  const summary: FleetSummary = {
    working: alive.filter((s) => s.state === 'working' || s.state === 'starting').length,
    done: alive.filter((s) => s.hc === 'done').length,
    idle: alive.filter((s) => s.state !== 'working' && s.state !== 'starting' && s.hc !== 'done').length,
    asks: asks.length,
    staleAsks: asks.filter((a) => now.getTime() - Date.parse(a.at) >= STALE_ASK_MS).length,
  }

  return {
    builtAt: now.toISOString(),
    summary,
    asks,
    repos,
    quota: status.accounts,
    queue: status.queue,
    errors: input.errors,
  }
}

/** Keys that move with the clock or with every tool call: a model that differs only there has not changed. */
const VOLATILE = new Set(['builtAt', 'lastActivityAt', 'readAt', 'sampledAt'])

/** sha-256 (16 hex) of the model without its volatile fields; what `NOTIFY fleet` carries. */
export function fingerprintOf(model: Omit<Fleet, 'fingerprint'>): string {
  const text = JSON.stringify(model, (key, value: unknown) => (VOLATILE.has(key) ? undefined : value))
  return hash(text, 16)
}
