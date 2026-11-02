import type { Fleet, FleetAsk, FleetPlan, FleetRepo, FleetSession, Spawn } from '@software-factory/contract'

/**
 * The socket's view: a pane may read it, and what a pane reads goes to its model, so nothing of IuRoot's text does. A visible
 * repo (or session, or an ask about one) is rebuilt field by field from an allow-list: a field added to the contract later is a
 * compile error here until someone decides, not a leak by default. What stays: names, paths, ids, branch, dirty bit, states,
 * counts, dates, shas and wave numbers and statuses. What goes (null): plan titles, goals and shorts, wave titles and status
 * texts, commit subjects, Claude's titles and headlines, an ask's text, a spawn's error.
 *
 * Not covered, said in `docs/design.md` §11: `errors[]` lines (the factory's own words with a repo name or a path), a spawn's key,
 * and the human queue's requests, which name no repo.
 *
 * Pure: the stored snapshot is untouched.
 */

const plan = (p: FleetPlan): FleetPlan => ({
  path: p.path,
  sha: p.sha,
  title: null,
  short: null,
  goal: null,
  waves: p.waves.map((w) => ({
    n: w.n,
    title: null,
    short: null,
    status: w.status,
    statusDate: w.statusDate,
    statusText: null,
  })),
  state: p.state,
  lastTouched: p.lastTouched,
})

const session = (s: FleetSession): FleetSession =>
  s.visible
    ? {
        id: s.id,
        role: s.role,
        parent: s.parent,
        state: s.state,
        hc: s.hc,
        wait: s.wait,
        account: s.account,
        terminal: s.terminal,
        plan: s.plan,
        wave: s.wave,
        title: null,
        visible: s.visible,
        headline: null,
        since: s.since,
        lastActivityAt: s.lastActivityAt,
      }
    : s

const repo = (r: FleetRepo): FleetRepo =>
  r.visible
    ? {
        name: r.name,
        space: r.space,
        visible: r.visible,
        git: r.git && {
          branch: r.git.branch,
          dirty: r.git.dirty,
          lastCommit: r.git.lastCommit && { sha: r.git.lastCommit.sha, subject: null, at: r.git.lastCommit.at },
        },
        plan: r.plan && plan(r.plan),
        morePlans: r.morePlans.map(plan),
        sessions: r.sessions.map(session),
      }
    : { ...r, sessions: r.sessions.map(session) }

const ask = (a: FleetAsk): FleetAsk =>
  a.visible
    ? {
        id: a.id,
        kind: a.kind,
        repo: a.repo,
        session: a.session,
        plan: a.plan,
        short: null,
        text: null,
        source: a.source,
        visible: a.visible,
        at: a.at,
        suggestion: null,
        actions: [],
      }
    : a

/** A spawn is IuRoot's when it runs in a visible repo of the model or anywhere in a directory named IuRoot. */
const spawn = (s: Spawn, visibleSpaces: ReadonlySet<string>): Spawn =>
  s.repo.split('/').includes('IuRoot') ||
  [...visibleSpaces].some((space) => s.repo === space || s.repo.startsWith(`${space}/`))
    ? { ...s, error: null }
    : s

export function redactVisible(fleet: Fleet): Fleet {
  const visibleSpaces = new Set(fleet.repos.filter((r) => r.visible).map((r) => r.space))
  return {
    ...fleet,
    redacted: true,
    repos: fleet.repos.map(repo),
    unplaced: fleet.unplaced.map(session),
    asks: fleet.asks.map(ask),
    queue: { ...fleet.queue, spawns: fleet.queue.spawns.map((s) => spawn(s, visibleSpaces)) },
  }
}
