import type { MigrationFiles } from '../../domains/loops/ports.ts'
import { leadBranchIssue } from '../../kernel/ids.ts'
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

const branchOf = (ref: string): string => ref.replace(/^refs\/(heads|remotes\/origin)\//, '')

/** Whether a branch can still merge: any branch that is not a lead's, and the lead branches of the open Issues. */
function inScope(branch: string, openIssues: ReadonlySet<number>): boolean {
  if (!branch.startsWith('factory/')) return true
  const issue = leadBranchIssue(branch)
  return issue !== null && openIssues.has(issue)
}

/**
 * The migration files at `origin/master` and, for every branch that can still merge, the ones it adds to it: the branches
 * that are not a lead's and the lead branches of the open Issues, local and remote alike. The main checkout shares its refs
 * with every worktree, so each lead's branch is seen. The refs of closed Issues start no process; past `MAX_REFS` the
 * rest is named as unchecked. Local refs only, no fetch, no prompt; a base that cannot be read is an error and the
 * finding is skipped for the pass.
 */
export function gitMigrationFiles(
  repos: { locate(repo: string): Promise<Result<string>> },
  options: { run?: Run; git?: string } = {},
): MigrationFiles {
  return {
    async read(repo, scope) {
      const located = await repos.locate(repo)
      if (!located.ok) return located
      const git = (args: string[]) => gitIn(located.value, args, { ...options, timeoutMs: GIT_TIMEOUT_MS })
      try {
        const tree = await git(['ls-tree', '--name-only', BASE, `${MIGRATIONS_DIR}/`])
        if (tree.exitCode !== 0) return err(portError('unreadable', `${BASE} is not readable in ${repo}`))
        const listed = await git([
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/heads/',
          'refs/remotes/origin/',
        ])
        if (listed.exitCode !== 0) return err(portError('unreadable', `the refs of ${repo} are not readable`))
        const open = new Set(scope.openIssues)
        const seen = new Set<string>()
        const wanted: { ref: string; name: string }[] = []
        for (const line of lines(listed.stdout)) {
          const [ref = '', sha = ''] = line.split(' ')
          if (ref === `refs/remotes/${BASE}` || ref === 'refs/remotes/origin/HEAD') continue
          const name = branchOf(ref)
          if (!inScope(name, open) || seen.has(`${name} ${sha}`)) continue
          seen.add(`${name} ${sha}`)
          wanted.push({ ref, name })
        }
        const refs: { ref: string; added: string[] }[] = []
        for (const { ref, name } of wanted.slice(0, MAX_REFS)) {
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
          if (added.length > 0) refs.push({ ref: name, added })
        }
        const unchecked = wanted.slice(MAX_REFS).map((w) => w.name)
        return ok({ base: lines(tree.stdout).map(nameOf), refs, unchecked })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (error instanceof CannotExecute) return err(portError('gone', detail))
        return err(portError(error instanceof GitTimeout ? 'timeout' : 'unreadable', detail))
      }
    },
  }
}
