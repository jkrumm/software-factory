import { createHash } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { MakeTargets, ProjectManifest, ProjectSyncResult } from '@software-factory/contract'
import type { SQL } from 'bun'
import { childEnv, EXIT_TIMEOUT, runProcess } from '../exec.ts'
import { createIssue } from '../issues/lifecycle.ts'
import { contentSha, parseManifest } from './manifest.ts'
import { makeTargetsOf } from './make.ts'

/** A full pass over the roots at most this often; the repos Issues and spawns name are picked up on every tick. */
export const SYNC_INTERVAL_MS = 10 * 60_000
const GIT_TIMEOUT_MS = 5_000
const CONCURRENCY = 8

export interface SyncDeps {
  sql: SQL
  roots: readonly string[]
  now: () => Date
  intervalMs?: number
  /** the process runner, for tests that want to count or break it */
  run?: typeof runProcess
}

interface Row {
  name: string
  repo: string
  manifest: ProjectManifest | null
  manifest_sha: string | null
  manifest_error_sha: string | null
}

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
 * Reads each project's `project.yaml` from the default branch of its checkout (`git show`, so a feature branch or an edit not
 * committed yet is not what the factory runs on) and its Makefile, and stores both on the project's row. A full pass visits every
 * repo directly under a root that has a manifest, every repo that already has a row and every repo an Issue or spawn names; between
 * full passes (`intervalMs`, ten minutes) a tick gives a row only to a named repo that has none. Passes never overlap.
 *
 * Project keys: the directory's name. A second directory of the same name (under another root) is told apart by its path: the
 * repo that was stored first keeps `<name>`, the other is `<name>~<8 hex of the sha-256 of its real path>`, and a stored repo
 * keeps its key whatever is added later.
 */
export class ProjectSync {
  private lastFull = 0
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: SyncDeps) {}

  /** The tick's call: a full pass when it is due, else only the repos that are named and unknown. */
  syncIfDue(): Promise<ProjectSyncResult> {
    const due = this.deps.now().getTime() - this.lastFull >= (this.deps.intervalMs ?? SYNC_INTERVAL_MS)
    return this.exclusive(() => this.pass(due))
  }

  /** `factory project sync`: a full pass now. */
  syncNow(): Promise<ProjectSyncResult> {
    return this.exclusive(() => this.pass(true))
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
      for (const { repo } of known) paths.add(repo)
    }
    const named: { repo: string }[] = await sql`
      SELECT r.repo FROM (SELECT repo FROM factory.issues UNION SELECT repo FROM factory.spawns) r
      WHERE ${full} OR NOT EXISTS (
        SELECT 1 FROM factory.projects p WHERE r.repo = p.repo OR starts_with(r.repo, p.repo || '/'))`
    for (const { repo } of named) {
      const enclosing = enclosingRepo(repo, roots)
      if (enclosing) paths.add(enclosing)
    }
    if (full) this.lastFull = this.deps.now().getTime()

    const result: ProjectSyncResult = { synced: 0, broken: [], errors: [] }
    const work = [...paths, ...[...scanned].filter((p) => !paths.has(p))]
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

  /** The text of `project.yaml` on the repo's default branch, `null` when there is none (or no git checkout). */
  private async manifestText(repo: string): Promise<string | null> {
    if (!(await exists(join(repo, '.git')))) return null
    const run = this.deps.run ?? runProcess
    const git = (args: string[]) =>
      run(['git', '-C', repo, ...args], GIT_TIMEOUT_MS, childEnv({ GIT_TERMINAL_PROMPT: '0' }))
    const head = await git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
    const fromRemote = head.exitCode === 0 ? head.stdout.trim().replace(/^origin\//, '') : ''
    for (const branch of fromRemote ? [fromRemote] : ['main', 'master']) {
      const shown = await git(['show', `refs/heads/${branch}:project.yaml`])
      if (shown.exitCode === 0) return shown.stdout
      // A git that hung says nothing about the file: the row keeps what it has.
      if (shown.exitCode === EXIT_TIMEOUT) throw new Error('git did not answer in time')
    }
    return null
  }

  /** What is on disk for one repo: the manifest text on its default branch and its Makefile's targets. */
  private async read(repo: string): Promise<{ text: string | null; make: MakeTargets } | undefined> {
    if (!(await isDirectory(repo))) return undefined
    return { text: await this.manifestText(repo), make: await makeTargetsOf(repo) }
  }

  /** One repo's row from what was read. `skipEmpty`: a repo with no manifest and no row is no project, and gets none. */
  private async store(
    repo: string,
    { text, make }: { text: string | null; make: MakeTargets },
    roots: readonly string[],
    skipEmpty: boolean,
  ): Promise<{ name: string; broken: boolean; issue: number | null } | undefined> {
    const { sql } = this.deps
    const dirName = basename(repo)
    const [prev]: Row[] = await sql`
      SELECT name, repo, manifest, manifest_sha, manifest_error_sha FROM factory.projects WHERE repo = ${repo}`
    if (!prev && text === null && skipEmpty) return undefined

    const now = this.deps.now()
    const name = prev?.name ?? (await this.freeName(dirName, repo))

    let manifest = prev?.manifest ?? null
    let manifestSha = prev?.manifest_sha ?? null
    let error: { sha: string; message: string } | null = null
    if (text === null) {
      manifest = null
      manifestSha = null
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

    await sql`
      INSERT INTO factory.projects (name, repo, manifest, manifest_sha, manifest_error, manifest_error_sha, make_targets, make_checked_at, synced_at, created_at)
      VALUES (${name}, ${repo}, ${manifest === null ? null : JSON.stringify(manifest)}::text::jsonb, ${manifestSha},
              ${error?.message ?? null}, ${error?.sha ?? null}, ${JSON.stringify(make)}::text::jsonb, ${now}, ${now}, ${now})
      ON CONFLICT (repo) DO UPDATE SET manifest = EXCLUDED.manifest, manifest_sha = EXCLUDED.manifest_sha,
        manifest_error = EXCLUDED.manifest_error, manifest_error_sha = EXCLUDED.manifest_error_sha,
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
