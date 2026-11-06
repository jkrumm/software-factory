import { basename, dirname, join, resolve } from 'node:path'
import { readdir, realpath, stat } from 'node:fs/promises'
import { type Fleet, type FleetIssue, NO_DIGEST, type Session, type Status } from '@software-factory/contract'
import type { SQL } from 'bun'
import { buildStatus } from '../status.ts'
import { JUDGE_WINDOW_MS } from '../issues/attention.ts'
import { leadKey } from '../issues/names.ts'
import { enclosingRepo } from '../projects/sync.ts'
import { type Digest, DigestView, loadGoals } from './digest.ts'
import { applyDigest, scopeOf } from './digest-model.ts'
import { Places } from './place.ts'
import { assemble, type DecisionRow, fingerprintOf, type MergedSession } from './model.ts'
import { askSourcesAnswered, type HcLister, type HcTerminal, type QueueReader, type QueueRequest } from './sources.ts'
import { readSnapshot, writeSnapshot } from './store.ts'

export { AskHumanQueue, HcTerminals } from './sources.ts'
export { readSnapshot } from './store.ts'

/** A build at most this often from the tick; `POST /fleet/refresh` builds at once. */
export const FLEET_INTERVAL_MS = 30_000
const MAX_DECISIONS = 500
/** the asks whose time is the first build that saw them (the others carry their own) */
const TIMED_BY_BUILDER = new Set<string>(['hc', 'wait', 'factory'])

export interface FleetDeps {
  sql: SQL
  now: () => Date
  /** `FACTORY_REPO_ROOTS` and `FACTORY_VISIBLE_ROOTS` as configured */
  roots: readonly string[]
  visibleRoots: readonly string[]
  home: string
  hc: HcLister
  queue: QueueReader
  /** the digest (`digest.ts`): its cache is read into every build and a pass is kicked after it; without it the model has no digest text */
  digest?: Digest
  alertLeads?: boolean
  intervalMs?: number
}

interface DbPart {
  status: Status
  /** what the read left out, said in `errors` */
  notes: string[]
  spawns: Map<string, { repo: string }>
  decisions: DecisionRow[]
  issues: FleetIssue[]
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )
/**
 * Builds the fleet read model off the tick and keeps the newest in one row (`factory.fleet_snapshot`), `NOTIFY fleet` when it
 * changes. `kick` is the tick's call: a build starts behind its back when one is due and none is running; `refreshNow` builds
 * at once and waits (`POST /fleet/refresh`). Every read is bounded, nothing runs in a transaction, and no source calls a model:
 * the digest's text is read from its cache (`factory.fleet_digest`), and a digest pass is started behind the build's back.
 * A source that fails leaves its part as the last build had it (memory) with a line in `errors`; a build whose database part
 * fails with nothing to fall back on fails as a whole, and the stored snapshot stays.
 */
export class FleetBuilder {
  private lastStart = 0
  private chain: Promise<unknown> = Promise.resolve()
  private running: Promise<unknown> | undefined
  private queued: Promise<Fleet> | undefined
  private seeded = false
  private firstSeen = new Map<string, string>()
  /** the health lines of the last build, by id, with the time each was first seen */
  private healthSeen = new Map<string, string>()
  /** when a terminal the factory does not know was first seen in its state: hc's own time moves with every message */
  private since = new Map<string, string>()
  /** the sources that answered with an older reading in this build (`fallback`) */
  private fell = new Set<string>()
  private readonly last: {
    db?: DbPart
    hc?: HcTerminal[]
    queue?: QueueRequest[]
    digest?: DigestView
  } = {}

  constructor(private readonly deps: FleetDeps) {}

  /** The tick's call. Never throws and never waits for the build. */
  kick(): void {
    const now = this.deps.now().getTime()
    if (this.running || now - this.lastStart < (this.deps.intervalMs ?? FLEET_INTERVAL_MS)) return
    this.lastStart = now
    this.running = this.exclusive(() => this.build())
      .catch((error: unknown) => console.error('fleet build failed', message(error)))
      .finally(() => {
        this.running = undefined
      })
  }

  /** A build now, after the one in flight; callers that arrive before it starts share it. */
  refreshNow(): Promise<Fleet> {
    this.lastStart = this.deps.now().getTime()
    if (this.queued) return this.queued
    const queued = this.exclusive(() => {
      this.queued = undefined
      return this.build()
    })
    this.queued = queued
    return queued
  }

  /** Waits for every build in flight or queued (the tick's and a refresh's) and the digest pass, at most `timeoutMs`: shutdown and the tests. */
  async settled(timeoutMs = 20_000): Promise<void> {
    let timer: Timer | undefined
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    try {
      await Promise.race([Promise.all([this.chain, this.deps.digest?.settled()]), bound])
    } finally {
      clearTimeout(timer)
    }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work)
    this.chain = result.catch(() => {})
    return result
  }

  private async build(): Promise<Fleet> {
    const { sql } = this.deps
    const now = this.deps.now()
    const errors: string[] = []
    this.fell = new Set()

    // Seeded from the stored snapshot once it has been read: a read that failed is tried again by the next build.
    if (!this.seeded) {
      try {
        const stored = await readSnapshot(sql)
        this.seeded = true
        for (const h of stored?.health ?? []) this.healthSeen.set(h.id, h.since)
        for (const a of stored?.asks ?? []) if (TIMED_BY_BUILDER.has(a.source)) this.firstSeen.set(a.id, a.at)
        for (const [id, at] of Object.entries(stored?.expired ?? {})) this.firstSeen.set(id, at)
        for (const x of [...(stored?.repos.flatMap((r) => r.sessions) ?? []), ...(stored?.unplaced ?? [])]) {
          if (x.since) this.since.set(`${x.id}\0${x.state}`, x.since)
        }
      } catch (error) {
        errors.push(`snapshot: ${message(error)}`)
      }
    }

    const visibleRoots = await realRoots(this.deps.visibleRoots)
    const ordinaryRoots = await realRoots(this.deps.roots)
    const roots = [...new Set([...ordinaryRoots, ...visibleRoots])]
    // Both forms of a root, as configured and after realpath: a stored path may be either.
    const places = await Places.of({
      visibleRoots: [...this.deps.visibleRoots, ...visibleRoots],
      configured: [...this.deps.roots, ...roots],
      home: this.deps.home,
    })

    const db = await this.fallback(
      errors,
      'database',
      () => this.readDb(now),
      this.last.db,
      (v) => (this.last.db = v),
    )
    if (!db) throw new Error('the database part of the fleet could not be read and there is none to fall back on')
    errors.push(...db.notes)
    const terminals =
      (await this.fallback(
        errors,
        'hc',
        () => this.deps.hc.list(),
        this.last.hc,
        (v) => (this.last.hc = v),
      )) ?? []
    const queue =
      (await this.fallback(
        errors,
        'human queue',
        () => this.deps.queue.list(),
        this.last.queue,
        (v) => (this.last.queue = v),
      )) ?? []

    const digest = this.deps.digest
    const view = digest
      ? ((await this.fallback(
          errors,
          'digest',
          () => digest.view(),
          this.last.digest,
          (v) => (this.last.digest = v),
        )) ?? new DigestView(new Map(), { ...NO_DIGEST, enabled: true }))
      : new DigestView()

    // Session paths are matched after realpath, like the roots (a link in a cwd or a spawn's repo is the same place).
    const real = new Map<string, string>()
    const wanted = new Set<string>()
    for (const t of terminals) if (t.cwd) wanted.add(t.cwd)
    for (const x of db.status.sessions) if (x.cwd) wanted.add(x.cwd)
    for (const x of db.spawns.values()) wanted.add(x.repo)
    await Promise.all(
      [...wanted].map(async (path) => {
        real.set(path, await realPath(path))
      }),
    )
    const merged = mergeSessions({
      sessions: db.status.sessions,
      spawns: db.spawns,
      terminals,
      roots,
      knownSince: this.since,
      real: (path) => real.get(path) ?? path,
    })
    const sessions = merged
    const repoPaths = new Set<string>()
    for (const m of merged) if (m.repo) repoPaths.add(m.repo)
    for (const issue of db.issues) {
      const repo = enclosingRepo(await realPath(issue.repo), roots)
      if (repo) repoPaths.add(repo)
    }
    const repos: string[] = []
    for (const path of [...repoPaths].sort()) if (await exists(join(path, '.git'))) repos.push(path)

    const base = assemble({
      now,
      roots,
      isVisible: (path) => places.isVisible(path),
      status: db.status,
      sessions,
      repos,
      issues: db.issues,
      decisions: db.decisions,
      queue,
      firstSeen: this.firstSeen,
      healthSeen: this.healthSeen,
      errors,
    })
    // The digest's text comes from its cache, for the repos and sessions it may read (IuRoot's get none).
    const scope = scopeOf({
      model: base,
      merged: sessions,
      sessions: db.status.sessions,
      isVisible: (path) => places.isVisible(path),
      issues: db.issues,
      goals: await loadGoals(
        sql,
        db.issues.map((i) => i.id),
      ),
      visibleNames: await directoryNames(visibleRoots),
    })
    const complete = askSourcesAnswered(errors)
    const model = applyDigest(base, view, scope, now)
    // What the snapshot will hold, so the answer to a refresh, the fingerprint and `GET /fleet` agree: no NUL (Postgres refuses it in jsonb).
    const clean: Omit<Fleet, 'fingerprint'> = JSON.parse(
      JSON.stringify(model, (_key, value: unknown) => (typeof value === 'string' ? value.replaceAll('\0', '') : value)),
    )
    const fleet: Fleet = { ...clean, fingerprint: fingerprintOf(clean) }
    // A build that could not read a source leaves what it knew of that source's asks (they did not leave, they were not listed).
    // An expired factory ask keeps its time too, or it would come back as new at the next build.
    const listed = [
      ...model.asks.filter((a) => TIMED_BY_BUILDER.has(a.source)).map((a) => [a.id, a.at] as const),
      ...Object.entries(model.expired),
    ]
    this.firstSeen = complete ? new Map(listed) : new Map([...this.firstSeen, ...listed])
    this.healthSeen = new Map(fleet.health.map((h) => [h.id, h.since]))
    this.since = new Map(
      [...fleet.repos.flatMap((r) => r.sessions), ...fleet.unplaced].flatMap((x) =>
        x.since ? [[`${x.id}\0${x.state}`, x.since] as const] : [],
      ),
    )
    await writeSnapshot(sql, fleet)
    // A source the feed is made from that failed makes it partial (the queue is not in it).
    digest?.kick({ ...scope.feed, complete: !errors.some((e) => /^(hc|database)/.test(e)) })
    return fleet
  }

  /** A source's answer, or the last one with an `errors` line, or `undefined` when it never answered. */
  private async fallback<T>(
    errors: string[],
    label: string,
    read: () => Promise<T>,
    previous: T | undefined,
    keep: (value: T) => void,
  ): Promise<T | undefined> {
    try {
      const value = await read()
      keep(value)
      return value
    } catch (error) {
      errors.push(`${label}: ${message(error)}`)
      this.fell.add(label)
      return previous
    }
  }

  private async readDb(now: Date): Promise<DbPart> {
    const { sql } = this.deps
    const status = await buildStatus(sql, now, { alertLeads: this.deps.alertLeads ?? false })
    const spawnRows: { key: string; repo: string }[] = await sql`
      SELECT key, repo FROM factory.spawns WHERE status = 'started'`
    const decisionRows: { key: string; repo: string; question: string; created_at: Date }[] = await sql`
      SELECT d.key, i.repo, d.question, d.created_at FROM factory.decisions d
      JOIN factory.issues i ON i.id = d.issue_id
      WHERE d.answered_at IS NULL AND i.state <> 'closed'
        AND (d.created_at <= ${new Date(now.getTime() - JUDGE_WINDOW_MS)} OR EXISTS (
          SELECT 1 FROM factory.issue_events m WHERE m.key = 'ask_judged:' || d.id AND m.payload->>'outcome' <> 'answered'))
      ORDER BY d.id LIMIT ${MAX_DECISIONS + 1}`
    const issueRows: {
      id: number
      title: string
      repo: string
      state: string
      kind: string | null
      size: string | null
      attempt: number
      updated_at: Date
    }[] = await sql`
      SELECT id, title, repo, state, kind, size, attempt, updated_at FROM factory.issues
      WHERE state <> 'closed' ORDER BY id`
    const live = new Set(status.sessions.filter((x) => x.state !== 'dead').map((x) => x.id))
    return {
      status,
      issues: issueRows.map((r) => ({
        id: r.id,
        title: r.title,
        repo: r.repo,
        state: r.state,
        kind: r.kind,
        size: r.size,
        lead: live.has(leadKey(r.id, r.attempt)) ? leadKey(r.id, r.attempt) : null,
        updatedAt: r.updated_at.toISOString(),
      })),
      notes:
        decisionRows.length > MAX_DECISIONS
          ? [`database: more than ${MAX_DECISIONS} open decisions, the rest are not listed`]
          : [],
      spawns: new Map(spawnRows.map((r) => [r.key, { repo: r.repo }])),
      decisions: decisionRows
        .slice(0, MAX_DECISIONS)
        .map((r) => ({ key: r.key, repo: r.repo, question: r.question, createdAt: r.created_at })),
    }
  }
}

/** The real path of a path; for one that is gone (a removed worktree), its nearest existing parent's real path with the rest appended. */
async function realPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(await realPath(parent), basename(path))
  }
}

/** The names of the directories directly under these roots: what a text may call a visible repo. An unreadable root has none. */
async function directoryNames(roots: readonly string[]): Promise<string[]> {
  const lists = await Promise.all(roots.map((root) => readdir(root).catch((): string[] => [])))
  return lists.flat()
}

async function realRoots(roots: readonly string[]): Promise<string[]> {
  // A root that exists but cannot be resolved (no permission to open it) stays as configured: listing it then fails visibly.
  const real = await Promise.all(
    roots.map((root) =>
      realpath(root).catch(() =>
        stat(root).then(
          () => resolve(root),
          () => undefined,
        ),
      ),
    ),
  )
  return real.filter((root): root is string => root !== undefined)
}

/** hc's word for a state, for a terminal the factory has no session for. */
const stateOfHc = (status: string | null): 'working' | 'blocked' | 'idle' =>
  status === 'working' ? 'working' : status === 'blocked' ? 'blocked' : 'idle'

export interface MergeInput {
  sessions: readonly Session[]
  spawns: ReadonlyMap<string, { repo: string }>
  terminals: readonly HcTerminal[]
  /** real paths */
  roots: readonly string[]
  knownSince?: ReadonlyMap<string, string>
  /** a path after realpath: a session's directory is matched against the roots the way the roots are */
  real: (path: string) => string
}

/**
 * The factory's sessions and hc's Claude Code terminals, one entry per agent: a terminal is the factory session's when its
 * address is the session's pane or its name or `factory.key` label is the session's id. A terminal the factory does not know is
 * its own entry (IuRoot's, `rd`'s). One outside every root, or in no repo, has no `repo` and is listed as unplaced.
 */
export function mergeSessions(input: MergeInput): MergedSession[] {
  const { sessions, spawns, terminals, roots, real, knownSince = new Map() } = input
  const placeOf = (...paths: (string | null | undefined)[]) => {
    const [first] = paths.filter((p): p is string => Boolean(p)).map(real)
    const where = first ?? null
    return { where, repo: where ? enclosingRepo(where, roots) : undefined }
  }
  const used = new Set<string>()
  const merged: MergedSession[] = []
  const nameOf = new Map<string, string>()

  for (const s of sessions) {
    if (s.state === 'dead') continue
    const term = terminals.find((t) => t.address === s.pane || t.name === s.id || t.factoryKey === s.id)
    if (term) {
      used.add(term.address)
      nameOf.set(term.address, s.id)
    }
    const spawn = s.spawn ? spawns.get(s.spawn) : undefined
    const cwd = s.cwd ?? term?.cwd ?? null
    const place = placeOf(spawn?.repo, s.cwd, term?.cwd)
    const times = [s.lastEventAt, term?.statusAt].filter((t): t is string => Boolean(t))
    merged.push({
      session: {
        id: s.id,
        role: s.role,
        parent: s.parent,
        state: s.state,
        hc: term?.status ?? null,
        wait: s.wait,
        account: s.account,
        terminal: term?.address ?? s.pane,
        title: term?.title ?? null,
        headline: null,
        since: s.since,
        lastActivityAt: times.sort().at(-1) ?? null,
      },
      repo: place.repo,
      spawnRepo: spawn ? real(spawn.repo) : null,
      cwd: cwd ? real(cwd) : null,
      hc: term,
    })
  }

  for (const t of terminals) {
    if (!t.claude || used.has(t.address)) continue
    nameOf.set(t.address, t.name ?? t.address)
  }
  for (const t of terminals) {
    if (!t.claude || used.has(t.address)) continue
    const place = placeOf(t.cwd)
    merged.push({
      session: {
        id: t.name ?? t.address,
        role: t.role,
        parent: t.parent ? (nameOf.get(t.parent) ?? t.parent) : null,
        state: stateOfHc(t.status),
        hc: t.status,
        wait: null,
        account: t.account,
        terminal: t.address,
        title: t.title,
        headline: null,
        since: knownSince.get(`${t.name ?? t.address}\0${stateOfHc(t.status)}`) ?? t.statusAt,
        lastActivityAt: t.statusAt,
      },
      repo: place.repo,
      spawnRepo: null,
      cwd: place.where,
      hc: t,
    })
  }
  return merged
}
