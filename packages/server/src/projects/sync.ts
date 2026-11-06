import { createHash } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  isProjectDirName,
  MAX_MANIFEST_BYTES,
  MAX_PLAN_BYTES,
  type MakeTargets,
  type PlanFile,
  type ProjectManifest,
  type ProjectSyncResult,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { createIssue } from '../issues/create.ts'
import { contentSha, parseManifest } from './manifest.ts'
import { parsePlan } from './plan-file.ts'
import { makeTargetsOf } from './make.ts'

/** A full pass over the roots at most this often; the repos Issues and spawns name are picked up on every tick. */
export const SYNC_INTERVAL_MS = 10 * 60_000
const GIT_TIMEOUT_MS = 5_000
const FETCH_TIMEOUT_MS = 30_000
const CONCURRENCY = 8
/** How long `factory project sync` waits for the remotes in all: well inside the server's idle timeout (240 s) and the CLI's (250 s), and a pass still follows. */
export const SYNC_FETCH_BUDGET_MS = 40_000

export interface SyncDeps {
  sql: SQL
  roots: readonly string[]
  now: () => Date
  intervalMs?: number
  /** the process runner, for tests that want to count or break it */
  run?: typeof runProcess
  /** ask each project's remote what it has: a repo's default branch moves on GitHub without touching this checkout */
  fetch?: boolean
  /** `SYNC_FETCH_BUDGET_MS`: how long `syncNow` waits for the fetches */
  fetchBudgetMs?: number
}

interface Row {
  name: string
  repo: string
  manifest: ProjectManifest | null
  manifest_sha: string | null
  manifest_error: string | null
  manifest_error_sha: string | null
  plan: PlanFile | null
  plan_sha: string | null
  plan_error: string | null
  plan_error_sha: string | null
}

/** `undefined`: no default branch to read, so nothing is known (the row keeps what it has) */
type Manifested = string | null | undefined | { bad: string; sha: string }

/** The two files of the default branch the sync reads in one pass. */
interface Committed {
  manifest: Manifested
  plan: Manifested
}

const MANIFEST_FILE = 'project.yaml'
const PLAN_FILE = 'docs/plan.yaml'

const isDirectory = (path: string) =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  )
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

/** `<name>~<8 hex of the path's hash>`: the key of a second directory of a name. */
const suffixed = (name: string, repo: string) =>
  `${name}~${createHash('sha256').update(repo).digest('hex').slice(0, 8)}`

/**
 * Reads each project's `project.yaml` from the remote's default branch as last fetched (so a feature branch, an edit not committed
 * yet or a checkout that is behind is not what the factory runs on) and its Makefile, and stores both on the project's row. A full pass visits every
 * repo directly under a root that has a manifest, every repo that already has a row and every repo an Issue or spawn names; between
 * full passes (`intervalMs`, ten minutes) a tick gives a row only to a named repo that has none. Passes never overlap. The fetch that
 * keeps the remote's refs fresh takes as long as the network does, so the tick starts it behind its back and looks again once it is
 * over; `factory project sync` waits for it.
 *
 * Project keys: the directory's name. A second directory of the same name (under another root) is told apart by its path: the
 * repo that was stored first keeps `<name>`, the other is `<name>~<8 hex of the sha-256 of its real path>`, and a stored repo
 * keeps its key whatever is added later.
 */
export class ProjectSync {
  private lastFull = 0
  private chain: Promise<unknown> = Promise.resolve()
  private fetching: Promise<void> | undefined
  /** the full pass that reads what a fetch brought: it starts no fetch of its own */
  private fresh = false

  constructor(private readonly deps: SyncDeps) {}

  /** the real roots the plan pass files Issues inside, and the sync's clock */
  get roots(): readonly string[] {
    return this.deps.roots
  }
  now(): Date {
    return this.deps.now()
  }

  /** The tick's call: a full pass when it is due, else only the repos that are named and unknown. */
  syncIfDue(): Promise<ProjectSyncResult> {
    const fresh = this.fresh
    this.fresh = false
    const due = this.deps.now().getTime() - this.lastFull >= (this.deps.intervalMs ?? SYNC_INTERVAL_MS)
    if (due && !fresh) this.fetchBehind()
    return this.exclusive(() => this.pass(due || fresh))
  }

  /**
   * `factory project sync`: what the remotes have, then a full pass. The wait for the remotes is bounded (`fetchBudgetMs`): what is not
   * fetched by then is read as it is, and the one fetch behind the tick's back is joined, not started a second time.
   */
  async syncNow(): Promise<ProjectSyncResult> {
    const budget = this.deps.fetchBudgetMs ?? SYNC_FETCH_BUDGET_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<void>((resolve) => (timer = setTimeout(resolve, budget)))
    try {
      await Promise.race([this.fetching ?? this.fetchAll(budget), expired])
    } finally {
      clearTimeout(timer)
    }
    return this.exclusive(() => this.pass(true))
  }

  private fetchBehind(): void {
    if (!this.deps.fetch || this.fetching) return
    this.fetching = this.fetchAll().finally(() => {
      this.fetching = undefined
      this.fresh = true
    })
  }

  /** Waits for the fetch behind the tick's back. The tests use it; the server never waits. */
  async settled(): Promise<void> {
    await this.fetching
  }

  /**
   * A failed fetch (a repo with no remote, a network that is away) leaves the refs as they were: what they say is read all the same. The
   * repos are fetched `CONCURRENCY` at a time, each as soon as a place frees (one slow remote holds up one place, not a batch). With a
   * `budgetMs` no fetch starts after it is spent and none runs past it.
   */
  private async fetchAll(budgetMs?: number): Promise<void> {
    if (!this.deps.fetch) return
    const run = this.deps.run ?? runProcess
    const env = childEnv({ GIT_TERMINAL_PROMPT: '0' })
    const deadline = budgetMs === undefined ? Infinity : Date.now() + budgetMs
    const known: { repo: string }[] = await this.deps.sql`SELECT repo FROM factory.projects`.catch(() => [])
    let next = 0
    const worker = async () => {
      for (let repo = known[next++]; repo; repo = known[next++]) {
        const left = deadline - Date.now()
        if (left <= 0) return
        await run(['git', '-C', repo.repo, 'fetch', '-q', 'origin'], Math.min(FETCH_TIMEOUT_MS, left), env).catch(
          () => undefined,
        )
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, known.length) }, worker))
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work)
    this.chain = result.catch(() => {})
    return result
  }

  private async pass(full: boolean): Promise<ProjectSyncResult> {
    const { sql } = this.deps
    const roots = await this.realRoots()
    const paths = new Set<string>()
    // The repos found under the roots: only a full pass looks, and one without a manifest (and without a row) is no project.
    const scanned = new Set<string>()
    if (full) {
      for (const root of roots) {
        for (const dir of await this.repoDirs(root)) scanned.add(dir)
      }
      const known: { repo: string }[] = await sql`SELECT repo FROM factory.projects`
      // A stored row whose directory is no valid name (kept from before) is left alone and silent: it is not listed either.
      for (const { repo } of known) if (isProjectDirName(basename(repo))) paths.add(repo)
    }
    const named: { repo: string }[] = await sql`
      SELECT r.repo FROM (SELECT repo FROM factory.issues UNION SELECT repo FROM factory.spawns) r
      WHERE ${full} OR NOT EXISTS (
        SELECT 1 FROM factory.projects p WHERE r.repo = p.repo OR starts_with(r.repo, p.repo || '/'))`
    // A repo whose directory is no valid project name is no project. Only an open Issue naming it is told (its lead has no project to work
    // in); a closed Issue's or a spawn's repo of the past would repeat the same line every full pass.
    const open: { repo: string }[] = await sql`SELECT DISTINCT repo FROM factory.issues WHERE state <> 'closed'`
    const openRepos = new Set(open.map((row) => row.repo))
    for (const { repo } of named) {
      const enclosing = enclosingRepo(repo, roots)
      if (!enclosing) continue
      if (!isProjectDirName(basename(enclosing)) && !openRepos.has(repo)) continue
      paths.add(enclosing)
    }
    if (full) this.lastFull = this.deps.now().getTime()

    const result: ProjectSyncResult = { synced: 0, broken: [], errors: [] }
    // In the roots' order, so the repo of the first root keeps a name the others share; the repos only named come after.
    const work = [...scanned, ...[...paths].filter((p) => !scanned.has(p))]
    // The reads run side by side; the rows are written one after the other, so two directories of one name get their keys in turn.
    for (let i = 0; i < work.length; i += CONCURRENCY) {
      const read = await Promise.all(
        work.slice(i, i + CONCURRENCY).map(async (path) => {
          try {
            return { path, found: await this.read(path) }
          } catch (error) {
            return { path, error }
          }
        }),
      )
      for (const { path, found, error } of read) {
        try {
          if (error !== undefined) throw error
          const outcome = found && (await this.store(path, found, roots, !paths.has(path)))
          if (!outcome) continue
          result.synced++
          if (outcome.broken) result.broken.push({ project: outcome.name, issue: outcome.issue })
        } catch (cause) {
          result.errors.push(`${basename(path)}: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
    }
    return result
  }

  private async realRoots(): Promise<string[]> {
    const real = await Promise.all(this.deps.roots.map((root) => realpath(root).catch(() => undefined)))
    return real.filter((root): root is string => root !== undefined)
  }

  /** The git repos directly under a root: `.git` is a directory, or a file for a worktree. */
  private async repoDirs(root: string): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const found: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const path = join(root, entry.name)
      if (await exists(join(path, '.git'))) found.push(path)
    }
    return found
  }

  /**
   * `project.yaml` and `docs/plan.yaml` as committed on the repo's default branch, each: its text; `null` when the branch has no such
   * file; `undefined` when there is no default branch to read (an empty repo, another name); `bad` when there is
   * one that cannot be read (not a regular file, larger than the limit), with the hash that keys its upkeep Issue.
   * The branch is resolved first and only that branch is read: `origin/HEAD`'s (`origin/<it>`, else the local branch), else the first
   * of `main` and `master` that exists, on the remote before the local one. Anything git fails at throws, so the row keeps what it has: a
   * failure is not a deletion.
   */
  private async committedFiles(repo: string): Promise<Committed> {
    if (!(await exists(join(repo, '.git')))) return { manifest: null, plan: null }
    const run = this.deps.run ?? runProcess
    const env = childEnv({ GIT_TERMINAL_PROMPT: '0' })
    const git = async (args: string[], accept: number[] = [0]) => {
      const done = await run(['git', '-C', repo, ...args], GIT_TIMEOUT_MS, env)
      if (done.exitCode === EXIT_TIMEOUT) throw new Error('git did not answer in time')
      if (!accept.includes(done.exitCode)) throw new Error(`git ${args[0]} failed (exit ${done.exitCode})`)
      return done
    }
    const head = await git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], [0, 1])
    const named = head.exitCode === 0 ? head.stdout.trim().replace(/^origin\//, '') : ''
    const refs = named
      ? [`refs/remotes/origin/${named}`, `refs/heads/${named}`]
      : ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']
    let ref: string | undefined
    for (const candidate of refs) {
      if ((await git(['rev-parse', '--verify', '-q', `${candidate}^{commit}`], [0, 1])).exitCode === 0) {
        ref = candidate
        break
      }
    }
    if (!ref) return { manifest: undefined, plan: undefined }

    const blob = async (file: string, limit: number): Promise<Manifested> => {
      const listed = (await git(['ls-tree', '-l', ref, '--', file])).stdout.trim()
      if (!listed) return null
      const [info] = listed.split('\t')
      const [mode, , oid, size] = (info ?? '').split(/\s+/)
      if (mode !== '100644' && mode !== '100755')
        return { bad: `${file} is not a regular file`, sha: contentSha(listed) }
      if (Number(size) > limit) {
        return { bad: `${file} is larger than ${limit} bytes`, sha: contentSha(`blob:${oid}`) }
      }
      return (await git(['cat-file', 'blob', oid ?? ''])).stdout
    }
    return { manifest: await blob(MANIFEST_FILE, MAX_MANIFEST_BYTES), plan: await blob(PLAN_FILE, MAX_PLAN_BYTES) }
  }

  /** What is on disk for one repo: the manifest and plan texts on its default branch and its Makefile's targets. */
  private async read(repo: string): Promise<{ files: Committed; make: MakeTargets } | undefined> {
    if (!(await isDirectory(repo))) return undefined
    return { files: await this.committedFiles(repo), make: await makeTargetsOf(repo) }
  }

  /** One repo's row from what was read. `skipEmpty`: a repo with no manifest and no row is no project, and gets none. */
  private async store(
    repo: string,
    { files, make }: { files: Committed; make: MakeTargets },
    roots: readonly string[],
    skipEmpty: boolean,
  ): Promise<{ name: string; broken: boolean; issue: number | null } | undefined> {
    const { sql } = this.deps
    const dirName = basename(repo)
    const text = files.manifest
    const [prev]: Row[] = await sql`
      SELECT name, repo, manifest, manifest_sha, manifest_error, manifest_error_sha,
        plan, plan_sha, plan_error, plan_error_sha FROM factory.projects WHERE repo = ${repo}`
    if (!prev && (text === null || text === undefined) && skipEmpty) return undefined
    if (!isProjectDirName(dirName)) {
      throw new Error(
        `the directory name is not a valid project name (letters, digits, dot, dash, underscore; no leading dot)`,
      )
    }

    const now = this.deps.now()
    const name = prev?.name ?? (await this.freeName(dirName, repo))

    let manifest = prev?.manifest ?? null
    let manifestSha = prev?.manifest_sha ?? null
    let error: { sha: string; message: string } | null = null
    if (text === null) {
      manifest = null
      manifestSha = null
    } else if (text === undefined) {
      // Nothing was read: the row keeps its manifest and whatever error it had.
      if (prev?.manifest_error && prev.manifest_error_sha) {
        error = { sha: prev.manifest_error_sha, message: prev.manifest_error }
      }
    } else if (typeof text === 'object') {
      error = { sha: text.sha, message: text.bad }
    } else {
      const sha = contentSha(text)
      const parsed = parseManifest(text)
      if (!parsed.ok) error = { sha, message: parsed.message }
      else if (parsed.manifest.name !== dirName) {
        error = { sha, message: `name ${parsed.manifest.name} is not the directory's name (${dirName})` }
      } else {
        manifest = parsed.manifest
        manifestSha = sha
      }
    }

    const planned = this.planOf(files.plan, prev)

    await sql`
      INSERT INTO factory.projects (name, repo, manifest, manifest_sha, manifest_error, manifest_error_sha, plan, plan_sha, plan_error, plan_error_sha, make_targets, make_checked_at, synced_at, created_at)
      VALUES (${name}, ${repo}, ${manifest === null ? null : JSON.stringify(manifest)}::text::jsonb, ${manifestSha},
              ${error?.message ?? null}, ${error?.sha ?? null},
              ${planned.plan === null ? null : JSON.stringify(planned.plan)}::text::jsonb, ${planned.sha},
              ${planned.error?.message ?? null}, ${planned.error?.sha ?? null},
              ${JSON.stringify(make)}::text::jsonb, ${now}, ${now}, ${now})
      ON CONFLICT (repo) DO UPDATE SET manifest = EXCLUDED.manifest, manifest_sha = EXCLUDED.manifest_sha,
        manifest_error = EXCLUDED.manifest_error, manifest_error_sha = EXCLUDED.manifest_error_sha,
        plan = EXCLUDED.plan, plan_sha = EXCLUDED.plan_sha, plan_error = EXCLUDED.plan_error, plan_error_sha = EXCLUDED.plan_error_sha,
        make_targets = EXCLUDED.make_targets, make_checked_at = EXCLUDED.make_checked_at, synced_at = EXCLUDED.synced_at`

    if (!error) return { name, broken: false, issue: null }
    // The Issue is keyed by the content: a second sync of the same broken file finds it, an edit that is still broken opens another.
    const { issue } = await createIssue(
      sql,
      {
        source: 'upkeep',
        sourceKey: `manifest:${name}:${error.sha}`,
        repo,
        title: `project.yaml of ${name} does not parse`,
        facts: { project: name, file: 'project.yaml', sha: error.sha, error: error.message },
      },
      { repoRoots: roots, now },
    )
    return { name, broken: true, issue: issue.id }
  }

  /**
   * The plan the row ends with, the manifest's way: absent file, no plan; nothing read, whatever the row had; an unreadable or broken
   * file keeps the last valid plan and records the error. No upkeep Issue: a plan error is a health line.
   */
  private planOf(
    text: Manifested,
    prev: Row | undefined,
  ): { plan: PlanFile | null; sha: string | null; error: { sha: string; message: string } | null } {
    const kept = { plan: prev?.plan ?? null, sha: prev?.plan_sha ?? null }
    if (text === null) return { plan: null, sha: null, error: null }
    if (text === undefined) {
      const error =
        prev?.plan_error && prev.plan_error_sha ? { sha: prev.plan_error_sha, message: prev.plan_error } : null
      return { ...kept, error }
    }
    if (typeof text === 'object') return { ...kept, error: { sha: text.sha, message: text.bad } }
    const sha = contentSha(text)
    const parsed = parsePlan(text)
    if (!parsed.ok) return { ...kept, error: { sha, message: parsed.message } }
    return { plan: parsed.plan, sha, error: null }
  }

  /** `<dir name>` if no other repo has it, else the name with the path's hash. */
  private async freeName(dirName: string, repo: string): Promise<string> {
    const [taken] = await this.deps.sql`SELECT 1 FROM factory.projects WHERE name = ${dirName}`
    return taken ? suffixed(dirName, repo) : dirName
  }
}

/** `<root>/<name>` for a path inside `<root>/<name>` (the repo itself, or a worktree of it), else `undefined`. */
export function enclosingRepo(path: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const prefix = root.endsWith('/') ? root : `${root}/`
    if (!path.startsWith(prefix)) continue
    const first = path.slice(prefix.length).split('/')[0]
    if (first) return `${prefix}${first}`
  }
  return undefined
}
