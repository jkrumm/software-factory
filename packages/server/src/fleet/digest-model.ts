import type { Fleet, FleetAsk, FleetPlan, FleetSession } from '@software-factory/contract'
import { type DigestFeed, type DigestView, type FeedSession } from './digest.ts'
import { type MergedSession, STALE_ASK_MS } from './model.ts'

/**
 * Where the digest meets the model. Two things, both pure: which parts of the model the digest may read (`scopeOf`, the one
 * place that decides, so a visible repo's, plan's or session's text is never an item), and what its cache adds to the model
 * (`applyDigest`).
 */

export interface DigestScope {
  feed: DigestFeed
  /** the sessions the digest may read, by id */
  sessions: ReadonlyMap<string, FeedSession>
  /** the plan files the digest may read the headings of */
  plans: ReadonlySet<string>
  /** the repos the digest may read (their `space`) */
  repos: ReadonlySet<string>
}

export interface ScopeInput {
  /** the model before the digest's text is added: a `short` of null is a heading with no `<!-- short: … -->` of its own */
  model: Omit<Fleet, 'fingerprint' | 'digest'>
  merged: readonly MergedSession[]
  /** the factory's sessions: the turn count and the transcript */
  sessions: readonly { id: string; turn: number; transcriptPath: string | null }[]
  /** whether a place is IuRoot's or a visible root's */
  isVisible: (path: string) => boolean
}

/**
 * The digest's reading of the model. A heading is offered only from a repo and a plan that are not visible; a session only when
 * it is listed under an ordinary repo and none of its places is visible: its repo, its spawn's repo, its directory, its terminal's
 * directory, its plan. A session outside every repo is never offered (nothing says where it stands).
 */
export function scopeOf(input: ScopeInput): DigestScope {
  const { model, isVisible } = input
  const headings: string[] = []
  const sessions = new Map<string, FeedSession>()
  const plans = new Set<string>()
  const repos = new Set<string>()
  const byId = new Map(input.merged.map((m) => [m.session.id, m]))
  const known = new Map(input.sessions.map((s) => [s.id, s]))

  for (const repo of model.repos) {
    if (repo.visible || isVisible(repo.space)) continue
    repos.add(repo.space)
    for (const plan of [repo.plan, ...repo.morePlans]) {
      if (!plan || isVisible(plan.path)) continue
      plans.add(plan.path)
      if (!plan.short && plan.title) headings.push(plan.title)
      for (const wave of plan.waves) if (!wave.short && wave.title) headings.push(wave.title)
    }
    for (const session of repo.sessions) {
      const m = byId.get(session.id)
      // Only a session the factory knows has a turn count and a transcript on record; a terminal only hc knows gets no digest text.
      const fact = known.get(session.id)
      if (!m || !fact) continue
      const places = [repo.space, m.repo, m.spawnRepo, m.cwd, m.hc?.cwd, session.plan]
      if (places.some((p) => p && isVisible(p))) continue
      const plan = [repo.plan, ...repo.morePlans].find((p) => p && p.path === session.plan)
      const wave = plan?.waves.find((w) => w.n === session.wave)
      sessions.set(session.id, {
        id: session.id,
        turn: fact.turn,
        settled: session.state === 'idle' || session.state === 'waiting',
        transcriptPath: fact.transcriptPath,
        since: session.since,
        title: session.title,
        role: session.role,
        repo: repo.name,
        plan: plan?.title ?? null,
        wave: wave ? `${wave.n} ${wave.title}` : null,
      })
    }
  }
  return { feed: { headings, sessions: [...sessions.values()], complete: true }, sessions, plans, repos }
}

/**
 * The model with the digest's text: the plans' and waves' `short` where they have none of their own (an ordinary repo's), the
 * sessions' `headline`, and the asks the digest found in a session's last message. A reply's ask is the session's current turn's
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
    // The same rule that decides what is sent: a plan the scope did not offer gets none of the cache's text.
    const plan = (p: FleetPlan): FleetPlan =>
      scope.plans.has(p.path)
        ? {
            ...p,
            short: p.short ?? view.heading(p.title),
            waves: p.waves.map((w) => ({ ...w, short: w.short ?? view.heading(w.title) })),
          }
        : p
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
        // A session that already has an ask of its own (blocked on a dialog, waiting on the owner) is one ask: the reply gives it its words.
        const own = asks.findIndex((a) => a.session === s.id && (a.source === 'hc' || a.source === 'wait'))
        const folded = own >= 0 ? asks[own] : undefined
        if (folded) {
          asks[own] = { ...folded, short: reply.short, kind: reply.kind }
          return { ...s, headline: view.headline(s.id) }
        }
        asks.push({
          id: `reply:${s.id}:${reply.turn}`,
          kind: reply.kind,
          repo: repo.space,
          session: s.id,
          plan: s.plan,
          short: reply.short,
          text: reply.text,
          source: 'reply',
          at: reply.at,
          suggestion: null,
          actions: [],
        })
      }
      return { ...s, headline: view.headline(s.id) }
    })
    return {
      ...repo,
      plan: repo.plan ? plan(repo.plan) : null,
      morePlans: repo.morePlans.map(plan),
      sessions,
    }
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
