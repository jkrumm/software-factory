import type { MigrationFiles } from '../../domains/loops/ports.ts'
import { err, ok, portError, type Result } from '../../kernel/result.ts'
import { GitTimeout, gitIn } from '../quality/git.ts'
import { CannotExecute, type Run } from '../quality/process.ts'

const MIGRATIONS_DIR = 'apps/server/migrations'
const BASE = 'origin/master'
const GIT_TIMEOUT_MS = 15_000
/** The most refs one pass diffs: a bound on the processes a pass starts. */
const MAX_REFS = 200

const lines = (text: string): string[] => text.split('\n').filter(Boolean)
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/**
 * The migration files at `origin/master` and, for every local branch and every remote branch, the ones it adds to it. The
 * main checkout shares its refs with every worktree, so each lead's branch is seen. Local refs only, no fetch, no prompt;
 * a base that cannot be read is an error and the finding is skipped for the pass.
 */
export function gitMigrationFiles(
  repos: { locate(repo: string): Promise<Result<string>> },
  options: { run?: Run; git?: string } = {},
): MigrationFiles {
  return {
    async read(repo) {
      const located = await repos.locate(repo)
      if (!located.ok) return located
      const git = (args: string[]) => gitIn(located.value, args, { ...options, timeoutMs: GIT_TIMEOUT_MS })
      try {
        const tree = await git(['ls-tree', '--name-only', BASE, `${MIGRATIONS_DIR}/`])
        if (tree.exitCode !== 0) return err(portError('unreadable', `${BASE} is not readable in ${repo}`))
        const listed = await git(['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/origin/'])
        if (listed.exitCode !== 0) return err(portError('unreadable', `the refs of ${repo} are not readable`))
        const refs: { ref: string; added: string[] }[] = []
        const all = lines(listed.stdout)
        if (all.length > MAX_REFS) {
          return err(portError('unreadable', `${all.length} refs in ${repo}, more than the ${MAX_REFS} compared`))
        }
        for (const ref of all) {
          if (ref === `refs/remotes/${BASE}` || ref === 'refs/remotes/origin/HEAD') continue
          const diff = await git([
            'diff',
            '--name-only',
            '--diff-filter=A',
            `${BASE}...${ref}`,
            '--',
            `${MIGRATIONS_DIR}/`,
          ])
          // A ref that cannot be compared (no common ancestor) adds nothing we can name.
          if (diff.exitCode !== 0) continue
          const added = lines(diff.stdout).map(nameOf)
          if (added.length > 0) refs.push({ ref: ref.replace(/^refs\/(heads|remotes)\//, ''), added })
        }
        return ok({ base: lines(tree.stdout).map(nameOf), refs })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (error instanceof CannotExecute) return err(portError('gone', detail))
        return err(portError(error instanceof GitTimeout ? 'timeout' : 'unreadable', detail))
      }
    },
  }
}
