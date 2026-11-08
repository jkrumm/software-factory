import type { MainCheckouts } from '../../domains/loops/ports.ts'
import { err, ok, portError, type Result } from '../../kernel/result.ts'
import { GitTimeout, readMainCheckout } from './git.ts'
import { CannotExecute, type Run } from './process.ts'

/** The main checkout of a repo the factory may look at (inside the allowed roots); one it may not is no finding. */
export function gitMainCheckouts(
  repos: { locate(repo: string): Promise<Result<string>> },
  options: { run?: Run; git?: string } = {},
): MainCheckouts {
  return {
    async look(repo) {
      const located = await repos.locate(repo)
      if (!located.ok) return ok(null)
      return readMainCheckout(located.value, options).then(ok, (error: unknown) => err(failure(error)))
    },
  }
}

const failure = (error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error)
  if (error instanceof CannotExecute) return portError('gone', detail)
  return portError(error instanceof GitTimeout ? 'timeout' : 'unreadable', detail)
}
