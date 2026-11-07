import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import type { Repos } from '../../domains/leads/ports.ts'
import { err, ok, portError } from '../../kernel/result.ts'

const withSeparator = (path: string): string => (path.endsWith(sep) ? path : `${path}${sep}`)

async function realDirectory(path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path)
    return (await stat(real)).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

/**
 * The trust boundary (`AGENTS.md`): the token can start Claude Code with `--dangerously-skip-permissions`, so a repo is a
 * directory strictly inside an allowed root, after `realpath` on both sides, so neither `..` nor a link leads out. A
 * repo is a path or a name found directly under a root; the root itself is never a repo.
 */
export function rootedRepos(roots: readonly string[]): Repos {
  return {
    async locate(repo) {
      const candidates = isAbsolute(repo) ? [repo] : roots.map((root) => join(root, repo))
      for (const candidate of candidates) {
        const real = await realDirectory(candidate)
        if (!real) continue
        for (const root of roots) {
          const realRoot = await realpath(root).catch(() => undefined)
          if (realRoot && real.startsWith(withSeparator(realRoot)) && real !== realRoot) return ok(real)
        }
      }
      return err(portError('refused', `repo ${repo} is not a directory inside the allowed roots (FACTORY_REPO_ROOTS)`))
    },
  }
}
