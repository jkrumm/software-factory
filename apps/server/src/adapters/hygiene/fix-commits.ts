import { type FixCommit, BODY_CHARS, FILES_MAX, parseFixSubject } from '../../domains/loops/fix-classes.ts'
import type { FixCommitReader } from '../../domains/loops/ports.ts'
import { err, ok, portError } from '../../kernel/result.ts'
import { CannotExecute } from '../hc/process.ts'
import { originDefault, type RepoLocator } from './checkout.ts'
import { gitOut, ProcessFailed, type Tools } from './git.ts'

const FETCH_TIMEOUT_MS = 90_000
const FIELD = '\u001f'

/** One block of `git log --format=%x00%H<US>%cI<US>%s<US>%b<US> --name-only`: the commit if its subject is a conventional fix. */
function commitOf(block: string): FixCommit | null {
  const [sha = '', iso = '', subject = '', body = '', ...rest] = block.split(FIELD)
  const committedAt = new Date(iso)
  if (!sha || Number.isNaN(committedAt.getTime()) || !parseFixSubject(subject)) return null
  const files = rest
    .join(FIELD)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, FILES_MAX)
  return {
    sha,
    committedAt,
    subject: subject.trim(),
    scope: parseFixSubject(subject)?.scope ?? null,
    body: body.trim().slice(0, BODY_CHARS),
    files,
  }
}

/**
 * The fix commits of a project's default branch since `since`: `git log --no-merges` on origin's default branch (after a
 * fetch, as the hygiene checkout finds it), the subject filtered to a conventional `fix`. Read only.
 */
export function createFixCommitReader(options: { repos: RepoLocator; git?: string }): FixCommitReader {
  const tools: Tools = { git: options.git ?? 'git', make: 'make', bun: 'bun' }
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
          [
            'log',
            '--no-merges',
            '--no-renames',
            `--since=${since.toISOString()}`,
            `--format=%x00%H%x1f%cI%x1f%s%x1f%b%x1f`,
            '--name-only',
            branch,
            '--',
          ],
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
