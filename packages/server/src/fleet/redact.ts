import type { Fleet, FleetPlan, FleetSession } from '@software-factory/contract'

const plan = (p: FleetPlan): FleetPlan => ({
  ...p,
  title: null,
  short: null,
  goal: null,
  waves: p.waves.map((w) => ({ ...w, title: null, short: null, statusText: null })),
})

const session = (s: FleetSession): FleetSession => (s.visible ? { ...s, title: null, headline: null } : s)

/**
 * The socket's view: a pane may read it, and what a pane reads goes to its model, so nothing of IuRoot's text does. Every repo
 * marked `visible` keeps its name, path, branch, dirty bit, plan path, sha, states and dates, wave numbers and statuses, and its
 * sessions' ids, states and times; plan titles, goals, shorts, wave titles and status texts, commit subjects, Claude's titles and
 * headlines are null. An ask that concerns a visible repo or session keeps its id, kind, source and time and loses its text. The
 * full model is the token API's. Pure: the stored snapshot is untouched.
 */
export function redactVisible(fleet: Fleet): Fleet {
  const visibleRepos = new Set(fleet.repos.filter((r) => r.visible).map((r) => r.space))
  const visibleSessions = new Set(
    [...fleet.repos.flatMap((r) => r.sessions), ...fleet.unplaced].filter((s) => s.visible).map((s) => s.id),
  )
  return {
    ...fleet,
    redacted: true,
    repos: fleet.repos.map((r) =>
      r.visible
        ? {
            ...r,
            git: r.git && { ...r.git, lastCommit: r.git.lastCommit && { ...r.git.lastCommit, subject: null } },
            plan: r.plan && plan(r.plan),
            morePlans: r.morePlans.map(plan),
            sessions: r.sessions.map(session),
          }
        : { ...r, sessions: r.sessions.map(session) },
    ),
    unplaced: fleet.unplaced.map(session),
    asks: fleet.asks.map((a) =>
      (a.repo && visibleRepos.has(a.repo)) || (a.session && visibleSessions.has(a.session))
        ? { ...a, text: null, short: null }
        : a,
    ),
  }
}
