import type { Fleet, FleetAsk, FleetSession } from '@software-factory/contract'
import { type DigestFeed, type DigestView, type FeedSession } from './digest.ts'
import { type MergedSession, STALE_ASK_MS } from './model.ts'

/**
 * Where the digest meets the model. Two things, both pure: which parts of the model the digest may read (`scopeOf`, the one
 * place that decides, so a visible repo's or session's text is never an item), and what its cache adds to the model
 * (`applyDigest`). The model has no plans any more: the only headings are Issue titles, and a session has no plan or wave.
 */

export interface DigestScope {
  feed: DigestFeed
  /** the sessions the digest may read, by id */
  sessions: ReadonlyMap<string, FeedSession>
  /** the repos the digest may read (their `space`) */
  repos: ReadonlySet<string>
}

export interface ScopeInput {
  /** the model before the digest's text is added */
  model: Omit<Fleet, 'fingerprint' | 'digest'>
  merged: readonly MergedSession[]
  /** the factory's sessions: the turn count and the transcript */
  sessions: readonly { id: string; turn: number; transcriptPath: string | null }[]
  /** whether a place is IuRoot's or a visible root's */
  isVisible: (path: string) => boolean
  /** the open Issues: the filed titles of those in ordinary repos get a short heading */
  issues: readonly { title: string; repo: string }[]
  /** the names of the visible repos: the directories directly under each visible root, and the model's visible repos */
  visibleNames: readonly string[]
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Names shorter than this are too common as words to mean a repo. */
const NAME_MIN = 3

/** Whether a text mentions IuRoot or a visible repo by name (whole word, any case). */
function namesVisible(text: string, names: readonly string[]): boolean {
  if (/iuroot/i.test(text)) return true
  const long = [...new Set(names.filter((n) => n.length >= NAME_MIN))]
  if (long.length === 0) return false
  const words = long.map(escapeRegExp).join('|')
  return new RegExp(String.raw`(?<![A-Za-z0-9_])(?:${words})(?![A-Za-z0-9_])`, 'i').test(text)
}

/**
 * The digest's reading of the model. A session is offered only when it is listed under an ordinary repo and none of its places is
 * visible: its repo, its spawn's repo, its directory, its terminal's directory. A session outside every repo is never offered
 * (nothing says where it stands). The feed's headings are the filed titles of the open Issues of ordinary repos and nothing else: an
 * Issue whose repo is visible (or the model marks visible) never has its title offered. The feed's lines are the texts of the asks and
 * health lines whose repo and session are ordinary and whose text names neither IuRoot nor a visible repo; any other line gets its
 * words from the deterministic fallback alone.
 */
export function scopeOf(input: ScopeInput): DigestScope {
  const { model, isVisible } = input
  const sessions = new Map<string, FeedSession>()
  const repos = new Set<string>()
  const byId = new Map(input.merged.map((m) => [m.session.id, m]))
  const known = new Map(input.sessions.map((s) => [s.id, s]))

  for (const repo of model.repos) {
    if (repo.visible || isVisible(repo.space)) continue
    repos.add(repo.space)
    for (const session of repo.sessions) {
      const m = byId.get(session.id)
      // Only a session the factory knows has a turn count and a transcript on record; a terminal only hc knows gets no digest text.
      const fact = known.get(session.id)
      if (!m || !fact) continue
      const places = [repo.space, m.repo, m.spawnRepo, m.cwd, m.hc?.cwd]
      if (places.some((p) => p && isVisible(p))) continue
      sessions.set(session.id, {
        id: session.id,
        turn: fact.turn,
        settled: session.state === 'idle' || session.state === 'waiting',
        transcriptPath: fact.transcriptPath,
        since: session.since,
        title: session.title,
        role: session.role,
        repo: repo.name,
        plan: null,
        wave: null,
      })
    }
  }
  const visibleRepos = new Set(model.repos.filter((repo) => repo.visible).map((repo) => repo.space))
  const headings = [
    ...new Set(
      input.issues
        .filter((issue) => !visibleRepos.has(issue.repo) && !isVisible(issue.repo))
        .map((issue) => issue.title),
    ),
  ]
  const visibleNames = [...input.visibleNames, ...model.repos.filter((repo) => repo.visible).map((repo) => repo.name)]
  const visibleSessions = new Set(
    model.repos
      .filter((repo) => repo.visible || isVisible(repo.space))
      .flatMap((repo) => repo.sessions.map((s) => s.id)),
  )
  const placedVisible = (session: string | null): boolean => {
    if (!session) return false
    const m = byId.get(session)
    return !!m && [m.repo, m.spawnRepo, m.cwd, m.hc?.cwd].some((p) => p && isVisible(p))
  }
  const mayRead = (line: { repo: string | null; session?: string | null; text: string }): boolean =>
    !(line.repo !== null && (visibleRepos.has(line.repo) || isVisible(line.repo))) &&
    !(line.session && (visibleSessions.has(line.session) || placedVisible(line.session))) &&
    !namesVisible(line.text, visibleNames)
  const lines = [...new Set([...model.asks, ...model.health].filter(mayRead).map((line) => line.text))]
  return { feed: { headings, sessions: [...sessions.values()], lines, complete: true }, sessions, repos }
}

/**
 * The model with the digest's text: the sessions' `headline`, and the asks the digest found in a session's last message. A reply's ask is the session's current turn's
 * only: a newer turn drops it at once, before the digest has read that turn, and a turn still running has none.
 */
export function applyDigest(
  model: Omit<Fleet, 'fingerprint' | 'digest'>,
  view: DigestView,
  scope: DigestScope,
  now: Date,
): Omit<Fleet, 'fingerprint'> {
  const asks: FleetAsk[] = [...model.asks]
  const repos = model.repos.map((repo) => {
    if (repo.visible || !scope.repos.has(repo.space)) return repo
    const sessions: FleetSession[] = repo.sessions.map((s) => {
      const fed = scope.sessions.get(s.id)
      if (!fed) return s
      const reply = view.reply(s.id)
      if (
        reply &&
        fed.settled &&
        fed.turn === reply.turn &&
        reply.asks &&
        reply.kind !== 'note' &&
        reply.confidence !== 'low'
      ) {
        // A session that already has an ask of its own (blocked on a dialog, waiting on the owner) is one ask: the reply gives it its words
        // (`short`) and nothing else; its kind stays the deterministic source's.
        const own = asks.findIndex((a) => a.session === s.id && (a.source === 'hc' || a.source === 'wait'))
        const folded = own >= 0 ? asks[own] : undefined
        if (folded) {
          asks[own] = { ...folded, short: reply.short }
          return { ...s, headline: view.headline(s.id) }
        }
        asks.push({
          id: `reply:${s.id}:${reply.turn}`,
          kind: reply.kind,
          repo: repo.space,
          session: s.id,
          short: reply.short,
          text: reply.text,
          source: 'reply',
          at: reply.at,
        })
      }
      return { ...s, headline: view.headline(s.id) }
    })
    return { ...repo, sessions }
  })
  asks.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
  return {
    ...model,
    repos,
    asks,
    summary: {
      ...model.summary,
      asks: asks.length,
      staleAsks: asks.filter((a) => now.getTime() - Date.parse(a.at) >= STALE_ASK_MS).length,
    },
    digest: view.stats,
  }
}
