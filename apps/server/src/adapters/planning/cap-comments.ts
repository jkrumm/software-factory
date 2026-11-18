import { capComment } from '@software-factory/project-lint'
import { CannotStart, runProcess } from './process.ts'

const GIT_TIMEOUT_MS = 10_000

/**
 * The comment beside a repo's `leads:` (or a lane's cap) in the `project.yaml` on its default branch as last fetched, which is
 * what the factory runs on. Null when the file or the comment is not there; never throws, a cap is quoted with what is known.
 */
export async function readCapComment(repoPath: string, lane: string | null): Promise<string | null> {
  for (const ref of ['origin/HEAD', 'origin/master', 'origin/main', 'HEAD']) {
    try {
      const out = await runProcess(['git', '-C', repoPath, 'show', `${ref}:project.yaml`], {
        timeoutMs: GIT_TIMEOUT_MS,
        env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      })
      if (out.code === 0) return capComment(out.stdout, { lane })
    } catch (error) {
      if (!(error instanceof CannotStart)) throw error
      return null
    }
  }
  return null
}
