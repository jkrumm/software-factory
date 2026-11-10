import { createHash } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, sep } from 'node:path'
import { firstLine, parseYamlText } from '@software-factory/contract/plan'
import { MAX_PLAN_BYTES } from '../../domains/planning/plan.ts'
import type { ProjectSource, RepoRef } from '../../domains/planning/ports.ts'
import { isProjectDirName, MAX_PROJECT_BYTES } from '../../domains/planning/project.ts'
import type { FileRead, RepoRead } from '../../domains/planning/sync.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import { CannotStart, runProcess } from './process.ts'

export interface GitProjectsOptions {
  /** directories whose direct children are repos */
  roots: readonly string[]
  timeoutMs: number
}

const PROJECT_FILE = { path: 'project.yaml', max: MAX_PROJECT_BYTES }
const PLAN_FILE = { path: 'docs/plan.yaml', max: MAX_PLAN_BYTES }

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export { parseYamlText }

/**
 * Reads `project.yaml` and `docs/plan.yaml` from the default branch of git repos, as last fetched: a feature branch
 * checked out, an edit not committed, or a checkout that is behind is not what the factory runs on.
 */
export function gitProjectSource(options: GitProjectsOptions): ProjectSource {
  const git = async (repo: string, args: string[]) => {
    try {
      return await runProcess(['git', '-C', repo, ...args], {
        timeoutMs: options.timeoutMs,
        env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      })
    } catch (error) {
      if (error instanceof CannotStart) return { code: 127, stdout: '', stderr: error.message, timedOut: false }
      throw error
    }
  }
  const failure = (repo: string, what: string, r: { stderr: string; timedOut: boolean }): PortError =>
    portError(
      r.timedOut ? 'timeout' : 'gone',
      `git ${what} in ${repo}: ${r.timedOut ? 'timed out' : firstLine(r.stderr)}`,
    )

  /** `origin/HEAD`'s branch, else the first of main and master that exists on the remote, then locally. */
  async function defaultBranch(repo: string): Promise<string | null> {
    const head = await git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    if (head.code === 0 && head.stdout.trim()) return head.stdout.trim()
    for (const ref of [
      'refs/remotes/origin/main',
      'refs/remotes/origin/master',
      'refs/heads/main',
      'refs/heads/master',
    ]) {
      const found = await git(repo, ['rev-parse', '--verify', '--quiet', ref])
      if (found.code === 0) return ref.replace(/^refs\/(remotes|heads)\//, '')
    }
    return null
  }

  async function readFile(
    repo: string,
    branch: string,
    file: { path: string; max: number },
  ): Promise<Result<FileRead, PortError>> {
    const tree = await git(repo, ['ls-tree', branch, '--', file.path])
    if (tree.code !== 0) return err(failure(repo, `ls-tree ${branch}`, tree))
    const line = tree.stdout.trim()
    if (!line) return ok({ state: 'absent' })
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(line)
    if (!match?.[1] || !match[3]) return err(portError('unreadable', `git ls-tree printed: ${line.slice(0, 200)}`))
    if (match[2] !== 'blob' || (match[1] !== '100644' && match[1] !== '100755')) {
      return ok({ state: 'unreadable', sha: null, message: `${file.path} is not a regular file` })
    }
    const size = await git(repo, ['cat-file', '-s', match[3]])
    if (size.code !== 0) return err(failure(repo, 'cat-file -s', size))
    if (Number(size.stdout.trim()) > file.max) {
      return ok({ state: 'unreadable', sha: match[3], message: `${file.path} is larger than ${file.max} bytes` })
    }
    const blob = await git(repo, ['cat-file', 'blob', match[3]])
    if (blob.code !== 0) return err(failure(repo, 'cat-file blob', blob))
    const sha = sha256(blob.stdout)
    const parsed = parseYamlText(blob.stdout)
    return ok(
      parsed.ok ? { state: 'text', sha, value: parsed.value } : { state: 'unreadable', sha, message: parsed.message },
    )
  }

  /** A repo has its own git directory. A linked worktree has a `.git` file pointing at another repo's, so it is not one. */
  const isRepo = async (path: string): Promise<boolean> =>
    (await stat(join(path, '.git')).catch(() => null))?.isDirectory() === true

  /** The roots after `realpath`, so a path that went through a symlink (`/tmp`) still lies in its root. */
  const realRoots = (): Promise<string[]> => Promise.all(options.roots.map((root) => realpath(root).catch(() => root)))

  const childOfRoot = (path: string, roots: readonly string[]): RepoRef | null => {
    for (const root of roots) {
      const prefix = root.endsWith(sep) ? root : `${root}${sep}`
      if (!path.startsWith(prefix)) continue
      const directory = path.slice(prefix.length).split(sep)[0]
      if (directory && isProjectDirName(directory)) return { directory, path: join(root, directory) }
    }
    return null
  }

  return {
    async discover() {
      const found: RepoRef[] = []
      for (const root of options.roots) {
        const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.') || !isProjectDirName(entry.name)) continue
          const path = await realpath(join(root, entry.name)).catch(() => null)
          if (!path || !(await isRepo(path))) continue
          const branch = await defaultBranch(path)
          if (!branch) continue
          const file = await git(path, ['ls-tree', branch, '--', PROJECT_FILE.path])
          if (file.code === 0 && file.stdout.trim()) found.push({ directory: entry.name, path })
        }
      }
      return ok(found)
    },

    async resolve(repo) {
      let path: string
      if (isAbsolute(repo)) {
        const real = await realpath(repo).catch(() => null)
        if (!real) return ok(null)
        path = real
      } else if (isProjectDirName(repo)) {
        const roots = await realRoots()
        const hit = (
          await Promise.all(roots.map(async (root) => ((await isRepo(join(root, repo))) ? join(root, repo) : null)))
        ).find((found) => found !== null)
        if (!hit) return ok(null)
        path = hit
      } else {
        return ok(null)
      }
      // A worktree of a repo is in the repo: the first directory below the root names it.
      const ref = childOfRoot(path, await realRoots())
      if (!ref || !(await isRepo(ref.path))) return ok(null)
      return ok({ directory: basename(ref.path), path: ref.path })
    },

    present: isRepo,

    async read(repo, { fetch }) {
      if (fetch) await git(repo.path, ['fetch', '--quiet', 'origin'])
      const branch = await defaultBranch(repo.path)
      if (!branch)
        return err(portError('gone', `${repo.path}: no default branch to read (no origin/HEAD, main or master)`))
      const project = await readFile(repo.path, branch, PROJECT_FILE)
      if (!project.ok) return project
      const plan = await readFile(repo.path, branch, PLAN_FILE)
      if (!plan.ok) return plan
      const read: RepoRead = { branch, project: project.value, plan: plan.value }
      return ok(read)
    },
  }
}
