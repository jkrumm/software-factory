import { basename } from 'node:path'
import type {
  Fleet,
  FleetAsk,
  Since,
  SinceAsk,
  SinceHandled,
  SinceRecovered,
  SinceRunning,
  SinceShipped,
  SinceSpend,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import { latestReadings } from '../capacity.ts'
import { readSnapshot } from './store.ts'
import { readingEnd, readSeenAt, windowStart } from './presence.ts'
import { windowFacts, type WindowDigest } from './window.ts'

/**
 * The since reading (FV Wave 4, `GET /fleet/since`, docs/design.md §11 "The fleet view"): what happened in a window, grouped, from facts
 * that are already recorded and nothing else. Git is never run here: the commits are the snapshot builder's (`FleetGit.recent`). Every
 * line names its source (table and key, or repo and sha). A line is `visible` (IuRoot's) when its place is, or when nothing says where it
 * is: the headline's input and the morning message only ever count those.
 */

export type SinceGroups = Omit<Since, 'headline'>

const LIMIT = 100
const day = (at: Date): string => at.toISOString().slice(0, 10)

const iso = (at: Date | null): string | null => at?.toISOString() ?? null
const within = (at: string | null | undefined, t: Date, until: Date): boolean => {
  const ms = at ? Date.parse(at) : Number.NaN
  return ms >= t.getTime() && ms <= until.getTime()
}

export interface SinceInput {
  /** the stored snapshot: asks, repos (commits, plans), sessions; without one the groups come from the database alone */
  snapshot: Fleet | undefined
  now: Date
  t: Date
  clamped: boolean
  seenAt: Date | null
  /** whether a place is IuRoot's or a visible root's (the same `Places` the digest's `scopeOf` uses) */
  isVisible: (path: string) => boolean
}

export async function buildSince(sql: SQL, input: SinceInput): Promise<SinceGroups> {
  const { snapshot, now, t } = input
  const repoVisible = (path: string | null): boolean => {
    if (path === null) return true
    const known = snapshot?.repos.find((r) => r.space === path)
    return known ? known.visible || input.isVisible(path) : input.isVisible(path)
  }
  const askRepo = new Map((snapshot?.asks ?? []).map((a) => [a.id, a.repo]))
  /** an ask id the snapshot does not list says nothing of where it is: treated as IuRoot's */
  const askVisible = (id: string): boolean => {
    const repo = askRepo.get(id)
    return repo === undefined ? true : repoVisible(repo)
  }

  const needsYou: SinceAsk[] = (snapshot?.asks ?? [])
    .filter((a) => within(a.at, t, now))
    .map((ask: FleetAsk) => ({
      ask,
      yours: ask.tier === 'yours',
      visible: repoVisible(ask.repo),
      source: `fleet_snapshot:${ask.id}`,
    }))
    .sort(
      (a, b) =>
        Number(b.yours) - Number(a.yours) ||
        Date.parse(a.ask.at) - Date.parse(b.ask.at) ||
        a.ask.id.localeCompare(b.ask.id),
    )

  return {
    t: t.toISOString(),
    until: now.toISOString(),
    clamped: input.clamped,
    seenAt: iso(input.seenAt),
    // The builder says it in `errors` (`git <repo>: …`) when a repo's commits could not be read and the previous build's stand in.
    incomplete: (snapshot?.errors ?? []).flatMap((e) => /^git ([^:]+): /.exec(e)?.[1] ?? []),
    needsYou,
    shipped: await shipped(sql, input, repoVisible),
    recovered: await recovered(sql, input, repoVisible),
    handled: await handled(sql, input, askVisible),
    running: await running(sql, input, repoVisible),
    spend: await spend(sql, input),
  }
}

async function shipped(
  sql: SQL,
  { snapshot, now, t }: SinceInput,
  repoVisible: (path: string | null) => boolean,
): Promise<SinceShipped[]> {
  const out: SinceShipped[] = []
  const issues: { id: number; title: string; repo: string; closed_at: Date }[] = await sql`
    SELECT id, title, repo, closed_at FROM factory.issues
    WHERE outcome = 'done' AND closed_at >= ${t} AND closed_at <= ${now} ORDER BY closed_at DESC, id DESC LIMIT ${LIMIT}`
  for (const i of issues) {
    out.push({
      kind: 'issue',
      text: `Issue ${i.id} (${basename(i.repo)}) shipped: ${i.title}`,
      at: i.closed_at.toISOString(),
      repo: i.repo,
      visible: repoVisible(i.repo),
      source: `issues:${i.id}`,
    })
  }
  for (const repo of snapshot?.repos ?? []) {
    for (const c of repo.git?.recent ?? []) {
      if (!within(c.at, t, now)) continue
      out.push({
        kind: 'commit',
        text: `${repo.name}: ${c.subject}`,
        at: c.at,
        repo: repo.space,
        visible: repo.visible || repoVisible(repo.space),
        source: `git:${repo.name}@${c.sha}`,
      })
    }
    for (const plan of [repo.plan, ...repo.morePlans]) {
      if (!plan) continue
      for (const wave of plan.waves) {
        // A wave's date is a day; the window takes the days it touches.
        if (wave.status !== 'done' || !wave.statusDate || wave.statusDate < day(t) || wave.statusDate > day(now))
          continue
        out.push({
          kind: 'wave',
          text: `${repo.name}: Wave ${wave.n} done, ${wave.short ?? wave.title}`,
          at: `${wave.statusDate}T00:00:00.000Z`,
          repo: repo.space,
          visible: repo.visible || repoVisible(repo.space),
          source: `plan:${repo.name}/${plan.path.startsWith(`${repo.space}/`) ? plan.path.slice(repo.space.length + 1) : plan.path}#wave-${wave.n}`,
        })
      }
    }
  }
  return out.sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? '') || a.source.localeCompare(b.source))
}

/** A failure followed by its fix, one line each: the spawn that started after failed attempts, the effect and the message that went through on a later try, the digest that ran after failing. */
async function recovered(
  sql: SQL,
  { now, t }: SinceInput,
  repoVisible: (path: string | null) => boolean,
): Promise<SinceRecovered[]> {
  const out: SinceRecovered[] = []
  const spawns: { key: string; repo: string; attempts: number; assigned_at: Date }[] = await sql`
    SELECT key, repo, attempts, assigned_at FROM factory.spawns
    WHERE status = 'started' AND attempts >= 2 AND assigned_at >= ${t} AND assigned_at <= ${now}
    ORDER BY assigned_at DESC, key LIMIT ${LIMIT}`
  for (const s of spawns) {
    out.push({
      kind: 'spawn',
      text: `spawn ${s.key} started on try ${s.attempts} after ${s.attempts - 1} failed`,
      at: s.assigned_at.toISOString(),
      repo: s.repo,
      visible: repoVisible(s.repo),
      source: `spawns:${s.key}`,
    })
  }
  const effects: { key: string; kind: string; attempts: number; done_at: Date; issue_id: number; repo: string }[] =
    await sql`
    SELECT e.key, e.kind, e.attempts, e.done_at, i.id AS issue_id, i.repo FROM factory.issue_effects e
    JOIN factory.issues i ON i.id = e.issue_id
    WHERE e.done_at >= ${t} AND e.done_at <= ${now} AND e.attempts >= 2 ORDER BY e.done_at DESC, e.id DESC LIMIT ${LIMIT}`
  for (const e of effects) {
    out.push({
      kind: 'effect',
      text: `Issue ${e.issue_id} (${basename(e.repo)}): ${e.kind} done on try ${e.attempts} after ${e.attempts - 1} failed`,
      at: e.done_at.toISOString(),
      repo: e.repo,
      visible: repoVisible(e.repo),
      source: `issue_effects:${e.key}`,
    })
  }
  const messages: { key: string; kind: string; attempts: number; sent_at: Date; repo: string | null }[] = await sql`
    SELECT n.key, n.kind, n.attempts, n.sent_at, i.repo FROM factory.notifications n
    LEFT JOIN factory.issues i ON i.id = n.issue_id
    WHERE n.sent_at >= ${t} AND n.sent_at <= ${now} AND n.attempts >= 2 ORDER BY n.sent_at DESC, n.key LIMIT ${LIMIT}`
  for (const n of messages) {
    out.push({
      kind: 'notification',
      text: `a ${n.kind} message was delivered on try ${n.attempts} after ${n.attempts - 1} failed`,
      at: n.sent_at.toISOString(),
      repo: n.repo,
      // A message with no Issue (a test, a door refusal) is the factory's own; one with an Issue is where its repo is.
      visible: n.repo === null ? false : repoVisible(n.repo),
      source: `notifications:${n.key}`,
    })
  }
  // The headline's own calls are left out: they would change the facts the headline is made from, and so ask for another.
  const runs: { id: string; ok: boolean; at: Date }[] = await sql`
    SELECT id, ok, at FROM factory.fleet_digest_runs
    WHERE at >= ${t} AND at <= ${now} AND (batch_hash IS NULL OR batch_hash NOT LIKE 'window:%') ORDER BY at, id`
  const failedRuns = runs.filter((r) => !r.ok)
  const firstFailed = failedRuns[0]
  const fix = firstFailed ? runs.findLast((r) => r.ok && r.at >= firstFailed.at) : undefined
  if (firstFailed && fix) {
    // Only the failures before the fix: a failure after it is still a failure.
    const before = failedRuns.filter((r) => r.at <= fix.at)
    out.push({
      kind: 'digest',
      text: `the digest failed ${before.length} time${before.length === 1 ? '' : 's'}, then ran`,
      at: fix.at.toISOString(),
      repo: null,
      visible: false,
      source: `fleet_digest_runs:${firstFailed.id}..${fix.id}`,
    })
  }
  return out.sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? '') || a.source.localeCompare(b.source))
}

/** What the triage did for the owner (each undoable until undone) and what the owner did. */
async function handled(
  sql: SQL,
  { snapshot, now, t }: SinceInput,
  askVisible: (id: string) => boolean,
): Promise<SinceHandled[]> {
  const out: SinceHandled[] = []
  const planRepo = (path: string): Fleet['repos'][number] | undefined =>
    snapshot?.repos.find((r) => path === r.space || path.startsWith(`${r.space}/`))
  type Row = {
    id: string
    kind: string
    subject: string
    what: string
    at: Date
    undone_at: Date | null
    payload: { repo?: string }
  }
  // Each has its own limit: a night of reaped sessions must not push the undoable triage rows out of the reading.
  const triaged: Row[] = await sql`
    SELECT id, kind, subject, what, at, undone_at, payload FROM factory.fleet_triage_log
    WHERE at >= ${t} AND at <= ${now} AND kind <> 'reaped' ORDER BY id DESC LIMIT ${LIMIT}`
  const reaped: Row[] = await sql`
    SELECT id, kind, subject, what, at, undone_at, payload FROM factory.fleet_triage_log
    WHERE at >= ${t} AND at <= ${now} AND kind = 'reaped' AND payload->>'state' IS DISTINCT FROM 'closing'
    ORDER BY id DESC LIMIT ${LIMIT}`
  for (const r of [...triaged, ...reaped]) {
    // The reaper acts on ordinary repos only (never IuRoot's), and its rows cannot be undone.
    if (r.kind === 'reaped') {
      out.push({
        kind: 'reaped',
        text: r.what,
        at: r.at.toISOString(),
        repo: r.payload.repo ?? null,
        visible: false,
        source: `fleet_triage_log:${r.id}`,
        undoId: null,
      })
      continue
    }
    // A subject is a plan path or an ask id; one the snapshot cannot place is IuRoot's until shown otherwise.
    const repo = r.subject.startsWith('/') ? planRepo(r.subject) : undefined
    const visible = r.subject.startsWith('/') ? (repo ? repo.visible : true) : askVisible(r.subject)
    out.push({
      kind: 'triage',
      text: r.undone_at ? `${r.what} (undone)` : r.what,
      at: r.at.toISOString(),
      repo: repo?.space ?? null,
      visible,
      source: `fleet_triage_log:${r.id}`,
      undoId: r.undone_at ? null : Number(r.id),
    })
  }
  const acts: { id: string; ask_id: string; intent: string; at: Date }[] = await sql`
    SELECT id, ask_id, intent, at FROM factory.fleet_acts WHERE at >= ${t} AND at <= ${now} ORDER BY id DESC LIMIT ${LIMIT}`
  for (const a of acts) {
    out.push({
      kind: 'act',
      text: `you chose ${a.intent} on ${a.ask_id}`,
      at: a.at.toISOString(),
      repo: null,
      visible: askVisible(a.ask_id),
      source: `fleet_acts:${a.id}`,
      undoId: null,
    })
  }
  return out.sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? '') || a.source.localeCompare(b.source))
}

/** Sessions alive now (the snapshot's), with how long the factory's own have run. */
async function running(
  sql: SQL,
  { snapshot, now, isVisible }: SinceInput,
  repoVisible: (path: string | null) => boolean,
): Promise<SinceRunning[]> {
  if (!snapshot) return []
  const entries = [
    ...snapshot.repos.flatMap((r) =>
      r.sessions.map((s) => ({ s, repo: r.space, visible: r.visible || repoVisible(r.space) })),
    ),
    // Nothing says where an unplaced session stands.
    ...snapshot.unplaced.map((s) => ({ s, repo: null, visible: true })),
  ]
  const ids = entries.map((e) => e.s.id)
  const started = new Map<string, Date>()
  if (ids.length > 0) {
    const rows: { session: string; at: Date }[] = await sql`
      SELECT session, min(at) AS at FROM factory.events WHERE kind = 'session_started' AND session IN ${sql(ids)} GROUP BY session`
    for (const r of rows) started.set(r.session, r.at)
  }
  return entries.map(({ s, repo, visible }) => {
    const at = started.get(s.id)
    return {
      kind: 'session' as const,
      id: s.id,
      text: `${s.id}: ${s.headline ?? s.title ?? s.state}`,
      headline: s.headline,
      at: s.lastActivityAt,
      repo,
      // A session in an ordinary repo that works an IuRoot plan is IuRoot's.
      visible: visible || (s.plan !== null && isVisible(s.plan)),
      ranForMs: at ? Math.max(0, now.getTime() - at.getTime()) : null,
      source: at ? `events:${s.id}` : `fleet_snapshot:${s.id}`,
    }
  })
}

async function spend(sql: SQL, { now, t }: SinceInput): Promise<SinceSpend> {
  const atStart: { id: string; account: string; weekly_used: number | null }[] = await sql`
    SELECT DISTINCT ON (account) id, account, weekly_used FROM factory.quota_readings
    WHERE read_at <= ${t} ORDER BY account, read_at DESC, id DESC`
  const start = new Map(atStart.map((r) => [r.account, r]))
  const latest = new Map((await latestReadings(sql)).map((r) => [r.account, r]))
  const accounts = [...new Set([...start.keys(), ...latest.keys()])].sort().map((account) => {
    const before = start.get(account)
    const after = latest.get(account)
    return {
      account,
      weeklyAtStart: before?.weekly_used ?? null,
      weeklyNow: after?.weeklyUsed ?? null,
      source: `quota_readings:${before?.id ?? '-'}..${after?.id ?? '-'}`,
    }
  })
  const [cost]: { usd: string | null }[] = await sql`
    SELECT sum(cost_usd)::text AS usd FROM factory.fleet_digest_runs WHERE at >= ${t} AND at <= ${now}`
  return { accounts, digestUsd: Number(cost?.usd ?? 0), digestSource: 'fleet_digest_runs' }
}

export interface SinceReader {
  sql: SQL
  now: () => Date
  /** whether a place is IuRoot's or a visible root's, as the digest's `scopeOf` decides (`Places`) */
  visible: () => Promise<(path: string) => boolean>
  /** the headline's lifecycle; without it (the digest is off) the headline is `none` */
  windows?: WindowDigest
}

/**
 * The reading `GET /fleet/since` answers: the groups from the stored snapshot and the database, and the headline. Never waits on agw. It
 * ends at `min(now, the snapshot's build)`: that is its `until`, and an explicit `t` later than it is cut to it (an empty reading).
 *
 * Only the default reading (no `t`, from the cursor) is the window the board shows: it queues its headline (a missing one is `pending`;
 * `queue: 'now'` also starts the pass) and supersedes the others. A reading with an explicit `t` shows a paragraph that was already made,
 * or `none`, and writes nothing, so a one-off look never displaces the board's window. `undefined` before the first fleet build.
 */
export async function readSince(
  reader: SinceReader,
  options: { t?: Date | null; queue?: 'later' | 'now' } = {},
): Promise<Since | undefined> {
  const { sql } = reader
  const now = reader.now()
  const snapshot = await readSnapshot(sql)
  if (!snapshot) return undefined
  const seenAt = await readSeenAt(sql)
  const start = windowStart({ t: options.t, seenAt, now })
  // The reading ends where its snapshot does: an ask raised after the last build is in neither this reading nor, once the owner has caught
  // up to its `until`, a window that would never show it.
  const until = readingEnd(now, new Date(snapshot.builtAt))
  const t = start.t > until ? until : start.t
  const groups = await buildSince(sql, {
    snapshot,
    now: until,
    t,
    clamped: start.clamped,
    seenAt,
    isVisible: await reader.visible(),
  })
  const facts = windowFacts(groups)
  const none = { state: 'none', text: null } as const
  const headline = !reader.windows
    ? none
    : options.t
      ? await reader.windows.cached(facts)
      : await reader.windows.request(facts, { now: options.queue === 'now' })
  return { ...groups, headline }
}
