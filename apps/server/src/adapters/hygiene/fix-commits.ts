import { type FixCommit, parseFixSubject } from '../../domains/hygiene/fix-causes.ts'
import type { FixCommitReader } from '../../domains/hygiene/ports.ts'
import { err, ok, portError } from '../../kernel/result.ts'
import { CannotExecute } from '../process.ts'
import { originDefault, type RepoLocator } from './checkout.ts'
import { defaultTools, gitOut, ProcessFailed, type Tools } from './git.ts'

const FETCH_TIMEOUT_MS = 90_000
const FIELD = '\u001f'

/** One block of `git log --format=%x00%H<US>%cI<US>%s<US>`: the commit if its subject is a conventional fix. */
function commitOf(block: string): FixCommit | null {
  const [sha = '', iso = '', subject = ''] = block.split(FIELD)
  const committedAt = new Date(iso)
  const parsed = parseFixSubject(subject)
  if (!sha || Number.isNaN(committedAt.getTime()) || !parsed) return null
  return { sha, committedAt, subject: subject.trim(), scope: parsed.scope }
}

/**
 * The fix commits of a project's default branch since `since`: `git log --no-merges` on origin's default branch (after a
 * fetch, as the hygiene checkout finds it), the subject filtered to a conventional `fix`. Read only.
 */
export function createFixCommitReader(options: { repos: RepoLocator; git?: string }): FixCommitReader {
  const tools: Tools = defaultTools(options.git)
  return {
    async read(repo, since) {
      const located = await options.repos.locate(repo)
      if (!located.ok) return located
      const dir = located.value
      try {
        await gitOut(tools, dir, ['fetch', '-q', 'origin'], FETCH_TIMEOUT_MS)
        const branch = await originDefault(tools, dir)
        if (!branch) throw new ProcessFailed(`no origin default branch in ${dir}`, 'refused')
        const out = await gitOut(
          tools,
          dir,
          ['log', '--no-merges', `--since=${since.toISOString()}`, `--format=%x00%H%x1f%cI%x1f%s%x1f`, branch, '--'],
          FETCH_TIMEOUT_MS,
        )
        const commits: FixCommit[] = []
        for (const block of out.split('\0').slice(1)) {
          const commit = commitOf(block)
          if (commit) commits.push(commit)
        }
        return ok(commits)
      } catch (error) {
        if (error instanceof ProcessFailed) return err(portError(error.kind, error.message))
        if (error instanceof CannotExecute) return err(portError('gone', error.message))
        return err(portError('gone', `reading the fix commits of ${repo} failed: ${String(error)}`))
      }
    },
  }
}
