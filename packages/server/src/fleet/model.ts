import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type {
  Fleet,
  FleetAsk,
  FleetHealth,
  FleetIssue,
  FleetRepo,
  FleetSession,
  FleetSummary,
  Status,
} from '@software-factory/contract'
import { healthKind } from '../health.ts'
import { isLeadSession } from '../issues/names.ts'
import { BLOCKED_AFTER_MS } from '../rules.ts'
import { enclosingRepo } from '../projects/sync.ts'
import type { HcTerminal, QueueRequest } from './sources.ts'

/** An ask older than this counts in `summary.staleAsks`. */
export const STALE_ASK_MS = 24 * 3_600_000
/** A factory-raised ask this old resolves itself as expired: it is bookkeeping, not a decision waiting on the owner. */
export const EXPIRE_FACTORY_ASK_MS = 7 * 24 * 3_600_000

/** A session as the merge left it: what the model shows, and what the asks and the digest's scope need besides. */
export interface MergedSession {
  session: FleetSession
  /** the repo directory under a root it belongs to; undefined: no repo of the model (outside every root, or not under a repo) */
  repo: string | undefined
  /** its spawn's repo */
  spawnRepo: string | null
  cwd: string | null
  hc: HcTerminal | undefined
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
  /** the repo directories to list (real paths): those with a session or an open Issue */
  repos: readonly string[]
  issues: FleetIssue[]
  decisions: DecisionRow[]
  queue: QueueRequest[]
  /** when an ask that has no time of its own (hc, a wait's fallback, an attention line) was first seen: the first build that saw it */
  firstSeen: ReadonlyMap<string, string>
  /** when a health line (by id) was first seen: the previous build's `since`, so a restart keeps it */
  healthSeen?: ReadonlyMap<string, string>
  errors: string[]
}

const isWorking = (s: { state: string }) => s.state === 'working' || s.state === 'starting'

const STATE_ORDER = ['walled', 'blocked', 'stuck', 'working', 'waiting', 'starting', 'idle'] as const

const hash = (text: string, length = 12): string => createHash('sha256').update(text).digest('hex').slice(0, length)

/**
 * What an attention line is about, as the key of its ask: the session and the verb, the note, the spawn, the notification, the
 * Issue and what is wrong with it, then a short hash of the line with its digits removed: two different lines of one subject do not
 * collapse, and a counter (`for 5 min`, `for 3 h`) does not change the id.
 */
export function lineKey(line: string): string {
  return `${subjectKey(line)}:${hash(line.replace(/\d+(\.\d+)?( h\b| min\b)?/g, ''), 6)}`
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
      [/^ parked for [^:]+: its lead stopped twice/, 'unreported'],
      [/^ parked for [^:]+: its lead is gone/, 'lead-gone'],
      [/^ parked for [^:]+: its account hit/, 'wall'],
      [/^ blocked/, 'blocked'],
      [/^ parked/, 'parked'],
      [/^: no hook event/, 'silent'],
      [/^: working /, 'over-budget'],
      [/^: \d+ regressions/, 'regressions'],
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
  const session =
    /^(?:blocked|stuck|walled) (\S+)/.exec(line) ??
    /^note \S+ to (\S+)/.exec(line) ??
    /^(lead-\d+-\d+) waits at a permission prompt/.exec(line)
  if (session?.[1]) return { session: session[1].replace(/:$/, '') }
  const spawn = /^spawn (\S+) failed/.exec(line)
  if (spawn?.[1]) return { spawn: spawn[1] }
  const issue = /^Issue (\d+)/.exec(line)
  if (issue?.[1]) return { issue: Number(issue[1]) }
  return {}
}

/**
 * Whether a health line is the factory's own bookkeeping and worth no line on `/fleet`: it stays in `factory status`'s health list.
 * A note to a terminal that no longer exists (it expired, or was never confirmed), a spawn marked failed while its terminal works on, a
 * kept worktree of a closed Issue, and the informational "waits for the claim".
 */
export function isMachineNoise(
  line: string,
  facts: {
    /** the session the line names, when the model has it */
    session: string | null
    /** the spawn's agent is a live, working session */
    spawnWorking: boolean
    /** the Issue the line names is open */
    issueOpen: boolean
  },
): boolean {
  if (/^note \S+ to \S+/.test(line)) return facts.session === null || /\bunconfirmed:/.test(line)
  if (/^spawn \S+ failed/.test(line)) return facts.spawnWorking
  if (/^Issue \d+: its worktree was kept/.test(line)) return !facts.issueOpen
  return /^Issue \d+ waits for the claim/.test(line)
}

const askKind = (line: string): FleetAsk['kind'] => (/^(blocked|Issue|review) /.test(line) ? 'blocker' : 'note')

function sessionOrder(a: FleetSession, b: FleetSession): number {
  return STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.id.localeCompare(b.id)
}

/** The read model from what was read: pure, so the same sources always give the same model. `fingerprint` is left for `fingerprintOf`. */
export function assemble(input: ModelInput): Omit<Fleet, 'fingerprint' | 'digest'> {
  const { now, status } = input

  const bySession = new Map<string, MergedSession>(input.sessions.map((m) => [m.session.id, m]))
  const repoOf = (path: string | undefined) => (path ? enclosingRepo(path, input.roots) : undefined)
  const spawnRepo = new Map(status.queue.spawns.map((s) => [s.key, repoOf(s.repo)]))
  const issueRepo = new Map(status.issues.map((i) => [i.id, repoOf(i.repo)]))

  const repos: FleetRepo[] = []
  const listed = new Set(input.repos)
  for (const path of input.repos) {
    repos.push({
      name: basename(path),
      space: path,
      visible: input.isVisible(path),
      sessions: input.sessions
        .filter((m) => m.repo === path)
        .map((m) => m.session)
        .sort(sessionOrder),
    })
  }
  repos.sort((a, b) => a.name.localeCompare(b.name) || a.space.localeCompare(b.space))

  const unplaced: FleetSession[] = input.sessions
    .filter((m) => !m.repo || !listed.has(m.repo))
    .map((m) => m.session)
    .sort(sessionOrder)

  const asks: FleetAsk[] = []
  const expired: Record<string, string> = {}
  const ask = (a: Omit<FleetAsk, 'short'>) => {
    asks.push({ short: null, ...a })
  }

  // The time of an ask that has none of its own: the first build that saw it (kept by the builder), never this build's.
  const seen = (id: string) => input.firstSeen.get(id) ?? now.toISOString()

  // hc's blocked, and a session that declared a wait on the owner.
  const hcBlocked = new Set<string>()
  for (const m of input.sessions) {
    const { id, wait, since } = m.session
    const repo = m.repo ?? null
    // An Issue lead at a permission prompt is no ask: it is the steward's cause, and a health line after 15 minutes (status.ts).
    if (m.hc?.status === 'blocked' && !isLeadSession(id)) {
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

  // The factory's own asks: a lead's `blocked` Issue Open decisions have their own asks below, and a
  // blocked session its hc ask.
  for (const line of status.attention) {
    if (/^Issue \d+ asks: /.test(line)) continue
    const subject = lineSubject(line)
    if (subject.session && /^blocked /.test(line) && hcBlocked.has(subject.session)) continue
    const id = `factory:${lineKey(line)}`
    if (asks.some((a) => a.id === id)) continue
    const session = subject.session && bySession.has(subject.session) ? subject.session : null
    const repo =
      (session ? bySession.get(session)?.repo : undefined) ??
      (subject.spawn ? spawnRepo.get(subject.spawn) : undefined) ??
      (subject.issue === undefined ? undefined : issueRepo.get(subject.issue))
    const at = seen(id)
    if (now.getTime() - Date.parse(at) >= EXPIRE_FACTORY_ASK_MS) {
      expired[id] = at
      continue
    }
    ask({
      id,
      kind: askKind(line),
      repo: repo ?? null,
      session,
      text: line,
      source: 'factory',
      at,
    })
  }

  // The health line: parks, a silent or over-budget lead, regressions, machine failures. Never an ask.
  const health: FleetHealth[] = []
  for (const line of status.health) {
    const id = `health:${lineKey(line)}`
    if (health.some((h) => h.id === id)) continue
    const subject = lineSubject(line)
    const session = subject.session && bySession.has(subject.session) ? subject.session : null
    const spawnRow = subject.spawn ? status.queue.spawns.find((x) => x.key === subject.spawn) : undefined
    const agent = spawnRow ? (spawnRow.pane ?? spawnRow.session) : null
    const spawned = agent
      ? input.sessions.find((m) => m.session.id === agent || m.session.terminal === agent)
      : undefined
    const issue = subject.issue === undefined ? undefined : status.issues.find((i) => i.id === subject.issue)
    if (
      isMachineNoise(line, {
        session,
        spawnWorking: spawned !== undefined && isWorking(spawned.session),
        issueOpen: issue !== undefined && issue.state !== 'closed',
      })
    ) {
      continue
    }
    const repo =
      (session ? bySession.get(session)?.repo : undefined) ??
      (subject.spawn ? spawnRepo.get(subject.spawn) : undefined) ??
      (subject.issue === undefined ? undefined : issueRepo.get(subject.issue))
    health.push({
      id,
      kind: healthKind(line),
      text: line,
      repo: repo ?? null,
      ...(subject.issue === undefined ? {} : { issue: subject.issue }),
      ...(session ? { session } : {}),
      since: input.healthSeen?.get(id) ?? now.toISOString(),
    })
  }
  health.sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.id.localeCompare(b.id))

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
    expired,
    health,
    repos,
    issues: input.issues,
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
