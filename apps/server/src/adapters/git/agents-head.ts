import type { AgentsHead } from '../../kernel/case-file.ts'
import { err, ok, portError } from '../../kernel/result.ts'
import { CannotExecute, GitTimeout, gitIn } from '../process.ts'

/** The most of AGENTS.md a case carries: the head, where a repo's rules for every task stand. */
const AGENTS_HEAD_CHARS = 12_000

/** Where the default branch is looked for, first hit wins: what was last fetched, then the checkout's own. */
const REFS = ['origin/HEAD', 'origin/master', 'origin/main', 'master', 'main', 'HEAD']

/**
 * The head of a repo's `AGENTS.md` as its default branch has it, read from the main checkout with `git show` (an edit not
 * committed, or a feature branch checked out, is not what the repo's leads read). Empty when no ref has the file.
 */
export function gitAgentsHead(options: { timeoutMs: number }): AgentsHead {
  return async (checkout) => {
    for (const ref of REFS) {
      try {
        const shown = await gitIn(checkout, ['show', `${ref}:AGENTS.md`], {
          timeoutMs: options.timeoutMs,
          group: true,
          env: { LC_ALL: 'C' },
        })
        if (shown.exitCode === 0) return ok(shown.stdout.slice(0, AGENTS_HEAD_CHARS))
      } catch (error) {
        if (error instanceof GitTimeout) return err(portError('timeout', `git show AGENTS.md in ${checkout} timed out`))
        if (error instanceof CannotExecute) return err(portError('gone', error.message))
        throw error
      }
    }
    return ok('')
  }
}
