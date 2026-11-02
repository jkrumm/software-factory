import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { type Fleet, type FleetGit, NO_DIGEST, type Session, type Status } from '@software-factory/contract'
import type { SQL } from 'bun'
import { buildStatus } from '../status.ts'
import { enclosingRepo } from '../projects/sync.ts'
import { type Digest, DigestView } from './digest.ts'
import { applyDigest, scopeOf } from './digest-model.ts'
import { GitReader } from './git.ts'
import { Places } from './place.ts'
import { type Probes, ProbeRunner } from './probes.ts'
import { Triage } from './triage.ts'
import {
  assemble,
  type DecisionRow,
  fingerprintOf,
  type MergedSession,
  type PlanFile,
  type RepoFacts,
} from './model.ts'
import { MAX_PLAN_BYTES, namedPlanPaths, namedWave } from './plans.ts'
import type { HcLister, HcTerminal, QueueReader, QueueRequest } from './sources.ts'
import { readSnapshot, writeSnapshot } from './store.ts'

export { AskHumanQueue, HcTerminals } from './sources.ts'
export { readSnapshot } from './store.ts'

/** A build at most this often from the tick; `POST /fleet/refresh` builds at once. */
export const FLEET_INTERVAL_MS = 30_000
const CONCURRENCY = 8
const MAX_DECISIONS = 500
/** the asks whose time is the first build that saw them (the others carry their own) */
const TIMED_BY_BUILDER = new Set(['hc', 'wait', 'factory', 'handoff'])
const PLAN = 'docs/waves/PLAN.md'

export interface FleetDeps {
  sql: SQL
  now: () => Date
  /** `FACTORY_REPO_ROOTS` and `FACTORY_VISIBLE_ROOTS` as configured */
  roots: readonly string[]
  visibleRoots: readonly string[]
  /** where `~/` in a plan path a spawn names is */
  home: string
  hc: HcLister
  queue: QueueReader
  git?: GitReader
  /** the digest (`digest.ts`): its cache is read into every build and a pass is kicked after it; without it the model has no digest text */
  digest?: Digest
  alertLeads?: boolean
  intervalMs?: number
  /** the triage's probes (`probes.ts`): the machines they may look at (`FACTORY_PROBE_HOSTS`: name → ssh alias or `local`), the one a queue request's command runs on, and (tests) the probes themselves */
  triage?: { hosts?: ReadonlyMap<string, string>; queueMachine?: string; probes?: Probes }
}

interface DbPart {
  status: Status
  /** what the read left out, said in `errors` */
  notes: string[]
  spawns: Map<string, { repo: string; prompt: string }>
  decisions: DecisionRow[]
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isFile = (path: string) =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  )
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )
const inside = (path: string, roots: readonly string[]) => roots.some((root) => path.startsWith(`${root}/`))

/** `<repo>/.claude/worktrees/<x>/…` is the worktree of `<repo>`: its plan is the repo's. */
const mainCheckout = (path: string): string => path.replace(/\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/, '')

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
  /** when a terminal the factory does not know was first seen in its state: hc's own time moves with every message */
  private since = new Map<string, string>()
  private readonly git: GitReader
  private readonly triage: Triage
  private readonly last: {
    db?: DbPart
    hc?: HcTerminal[]
    queue?: QueueRequest[]
    git: Map<string, FleetGit>
    plans: Map<string, PlanFile>
    digest?: DigestView
  } = { git: new Map(), plans: new Map() }

  constructor(private readonly deps: FleetDeps) {
    this.git = deps.git ?? new GitReader()
    const hosts = deps.triage?.hosts ?? new Map<string, string>()
    this.triage = new Triage({
      sql: deps.sql,
      probes: deps.triage?.probes ?? new ProbeRunner({ hosts, home: deps.home, now: deps.now, git: this.git }),
      machines: [...hosts.keys()],
      queueMachine: deps.triage?.queueMachine,
    })
  }

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

    // Seeded from the stored snapshot once it has been read: a read that failed is tried again by the next build.
    if (!this.seeded) {
      try {
        const stored = await readSnapshot(sql)
        this.seeded = true
        for (const a of stored?.asks ?? []) if (TIMED_BY_BUILDER.has(a.source)) this.firstSeen.set(a.id, a.at)
        for (const x of [...(stored?.repos.flatMap((r) => r.sessions) ?? []), ...(stored?.unplaced ?? [])]) {
          if (x.since) this.since.set(`${x.id}\0${x.state}`, x.since)
        }
      } catch (error) {
        errors.push(`snapshot: ${message(error)}`)
      }
    }

    const visibleRoots = await realRoots(this.deps.visibleRoots)
    const roots = [...new Set([...(await realRoots(this.deps.roots)), ...visibleRoots])]
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
    const sessions = mergeSessions({
      sessions: db.status.sessions,
      spawns: db.spawns,
      terminals,
      roots,
      knownSince: this.since,
      real: (path) => real.get(path) ?? path,
    })
    const planOf = new Map<string, { plan: string | null; wave: number | null }>()
    const repoPaths = new Set<string>()
    for (const m of sessions) if (m.repo) repoPaths.add(m.repo)
    for (const root of roots) {
      try {
        for (const dir of await repoDirs(root)) {
          if (await isFile(join(dir, PLAN))) repoPaths.add(dir)
        }
      } catch (error) {
        // A root that cannot be listed is said, and the repos the last build knew under it are tried again (they may still be reachable).
        errors.push(`repos ${root}: ${message(error)}`)
        for (const known of this.last.git.keys()) if (known.startsWith(`${root}/`)) repoPaths.add(known)
      }
    }

    // Each session's plan file; a plan in another repo of the roots (a spawn names it) puts that repo on the list too.
    for (const m of sessions) {
      const plan = await this.sessionPlan(m, roots)
      planOf.set(m.session.id, { plan, wave: namedWave(m.prompt ?? '') })
      const home = plan ? enclosingRepo(plan, roots) : undefined
      if (home) repoPaths.add(home)
    }

    // Each repo's errors are kept with it and merged in path order, so the reads running side by side cannot reorder them.
    const facts: RepoFacts[] = []
    const list = [...repoPaths].sort()
    for (let i = 0; i < list.length; i += CONCURRENCY) {
      const read = await Promise.all(list.slice(i, i + CONCURRENCY).map((path) => this.readRepo(path, roots, planOf)))
      for (const found of read) {
        if (!found) continue
        facts.push(found.facts)
        errors.push(...found.errors)
      }
    }

    const base = assemble({
      now,
      roots,
      isVisible: (path) => places.isVisible(path),
      status: db.status,
      sessions,
      sessionPlans: planOf,
      repos: facts,
      decisions: db.decisions,
      queue,
      firstSeen: this.firstSeen,
      errors,
    })
    // The digest's text comes from its cache, for the repos and sessions it may read (IuRoot's stay as the plan wrote them).
    const scope = scopeOf({
      model: base,
      merged: sessions,
      sessions: db.status.sessions,
      isVisible: (path) => places.isVisible(path),
    })
    const digested = applyDigest(base, view, scope, now)
    // The triage: tiers, suggestions with evidence, actions, and the bookkeeping that needs no one. Its failure leaves the asks as they are.
    let model: Omit<Fleet, 'fingerprint'> = digested
    let timed = digested.asks
    try {
      const triaged = await this.triage.apply({ model: digested, now, queue, firstSeen: this.firstSeen, roots })
      model = triaged.model
      timed = triaged.timed
    } catch (error) {
      console.error('fleet triage failed', message(error))
      // What the owner closed or snoozed stays gone; the rest is the asks as the sources raised them.
      const hidden = await this.triage.hide(digested, now).catch(() => digested)
      model = { ...hidden, errors: [...hidden.errors, `triage: ${message(error)}`] }
    }
    // What the snapshot will hold, so the answer to a refresh, the fingerprint and `GET /fleet` agree: no NUL (Postgres refuses it in jsonb).
    const clean: Omit<Fleet, 'fingerprint'> = JSON.parse(
      JSON.stringify(model, (_key, value: unknown) => (typeof value === 'string' ? value.replaceAll('\0', '') : value)),
    )
    const fleet: Fleet = { ...clean, fingerprint: fingerprintOf(clean) }
    // Every ask the sources raised, also one the triage folded or the owner snoozed: it keeps its time for when it comes back.
    this.firstSeen = new Map(timed.filter((a) => TIMED_BY_BUILDER.has(a.source)).map((a) => [a.id, a.at]))
    this.since = new Map(
      [...fleet.repos.flatMap((r) => r.sessions), ...fleet.unplaced].flatMap((x) =>
        x.since ? [[`${x.id}\0${x.state}`, x.since] as const] : [],
      ),
    )
    await writeSnapshot(sql, fleet)
    // A source the feed is made from that failed makes it partial (the queue and git are not in it).
    digest?.kick({ ...scope.feed, complete: !errors.some((e) => /^(hc|database|repos |plan )/.test(e)) })
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
      return previous
    }
  }

  private async readDb(now: Date): Promise<DbPart> {
    const { sql } = this.deps
    const status = await buildStatus(sql, now, { alertLeads: this.deps.alertLeads ?? false })
    const spawnRows: { key: string; repo: string; prompt: string }[] = await sql`
      SELECT key, repo, left(prompt, 65536) AS prompt FROM factory.spawns WHERE status = 'started'`
    const decisionRows: { key: string; repo: string; question: string; created_at: Date }[] = await sql`
      SELECT d.key, i.repo, d.question, d.created_at FROM factory.decisions d
      JOIN factory.issues i ON i.id = d.issue_id
      WHERE d.answered_at IS NULL AND i.state <> 'closed' ORDER BY d.id LIMIT ${MAX_DECISIONS + 1}`
    return {
      status,
      notes:
        decisionRows.length > MAX_DECISIONS
          ? [`database: more than ${MAX_DECISIONS} open decisions, the rest are not listed`]
          : [],
      spawns: new Map(spawnRows.map((r) => [r.key, { repo: r.repo, prompt: r.prompt }])),
      decisions: decisionRows
        .slice(0, MAX_DECISIONS)
        .map((r) => ({ key: r.key, repo: r.repo, question: r.question, createdAt: r.created_at })),
    }
  }

  /**
   * The plan file a session works: the one its start text names (a `docs/waves/*.md` path, the most named first), else the
   * `docs/waves/PLAN.md` found walking up from its directory to its repo (a plan deeper in the tree is the nearest), else the
   * repo's. Only a regular file under a root, of a size a plan has, counts.
   */
  private async sessionPlan(m: MergedSession, roots: readonly string[]): Promise<string | null> {
    const repo = m.repo
    const bases = [m.spawnRepo, repo, m.cwd, ...roots].filter((b): b is string => Boolean(b)).map(mainCheckout)
    for (const named of namedPlanPaths(m.prompt ?? '').slice(0, 5)) {
      const candidates = named.startsWith('~/')
        ? [join(this.deps.home, named.slice(2))]
        : named.startsWith('/')
          ? [named]
          : bases.map((base) => join(base, named))
      for (const candidate of candidates) {
        const real = await usablePlan(candidate, roots)
        if (real) return real
      }
    }
    if (!repo) return null
    let dir = m.cwd ? mainCheckout(m.cwd) : repo
    if (!dir.startsWith(`${repo}/`) && dir !== repo) dir = repo
    for (;;) {
      const found = await usablePlan(join(dir, PLAN), roots)
      if (found) return found
      if (dir === repo) return null
      dir = dirname(dir)
    }
  }

  private async readRepo(
    path: string,
    roots: readonly string[],
    planOf: ReadonlyMap<string, { plan: string | null }>,
  ): Promise<{ facts: RepoFacts; errors: string[] } | undefined> {
    const errors: string[] = []
    if (!(await exists(join(path, '.git')))) return undefined
    const name = path.split('/').at(-1) ?? path
    let git: FleetGit | null = null
    try {
      git = await this.git.state(path)
      this.last.git.set(path, git)
    } catch (error) {
      errors.push(`git ${name}: ${message(error)}`)
      git = this.last.git.get(path) ?? null
    }

    const rootPlan = (await usablePlan(join(path, PLAN), roots)) ?? null
    const paths = new Set<string>(rootPlan ? [rootPlan] : [])
    for (const { plan } of planOf.values()) if (plan && enclosingRepo(plan, roots) === path) paths.add(plan)

    const plans: PlanFile[] = []
    for (const file of [...paths].sort()) {
      try {
        const text = await Bun.file(file).text()
        const read = { path: file, text, touched: await this.git.touched(file) }
        this.last.plans.set(file, read)
        plans.push(read)
      } catch (error) {
        errors.push(`plan ${name}/${file.slice(path.length + 1)}: ${message(error)}`)
        const before = this.last.plans.get(file)
        if (before) plans.push(before)
      }
    }
    return { facts: { path, git, plans, rootPlan }, errors }
  }
}

/** The real path of a plan file if it is a regular file under a root and no larger than a plan is; else undefined. */
async function usablePlan(path: string, roots: readonly string[]): Promise<string | undefined> {
  try {
    // The directory's real path, not the file's: a plan that cannot be read still is one (and reading it fails with a line in `errors`).
    const link = await lstat(path)
    const real = link.isSymbolicLink() ? await realpath(path) : join(await realpath(dirname(path)), basename(path))
    const info = await stat(real)
    if (!info.isFile() || info.size > MAX_PLAN_BYTES || !real.endsWith('.md')) return undefined
    return inside(real, roots) ? real : undefined
  } catch {
    return undefined
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

/** The git repos directly under a root: `.git` is a directory, or a file for a worktree. */
async function repoDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const found: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(root, entry.name)
    if (await exists(join(path, '.git'))) found.push(path)
  }
  return found
}

/** hc's word for a state, for a terminal the factory has no session for. */
const stateOfHc = (status: string | null): 'working' | 'blocked' | 'idle' =>
  status === 'working' ? 'working' : status === 'blocked' ? 'blocked' : 'idle'

export interface MergeInput {
  sessions: readonly Session[]
  spawns: ReadonlyMap<string, { repo: string; prompt: string }>
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
      prompt: spawn?.prompt ?? term?.prompt ?? null,
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
      prompt: t.prompt,
      spawnRepo: null,
      cwd: place.where,
      hc: t,
    })
  }
  return merged
}
