import { realpath, stat } from 'node:fs/promises'
import { sep } from 'node:path'

/** A repo the policy refuses; the message is the 422 body. */
export class RepoRefused extends Error {}

const withSeparator = (path: string): string => (path.endsWith(sep) ? path : `${path}${sep}`)

/**
 * The real path of a spawn's repo, if it is a directory inside one of the allowed roots. Both sides go through
 * `realpath`, so neither `..` nor a symlink (in the path, or a root that is itself a link) leads out, and the
 * stored path is the one herdr will really use. A root that does not exist allows nothing. The root itself is not a
 * repo: the path must be strictly inside it, and `/root-evil` is not inside `/root`.
 */
export async function resolveRepo(repo: string, roots: readonly string[]): Promise<string> {
  let real: string
  try {
    real = await realpath(repo)
    if (!(await stat(real)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new RepoRefused(`repo ${repo} does not exist or is not a directory`)
  }

  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => undefined)
    if (realRoot && real.startsWith(withSeparator(realRoot)) && real !== realRoot) return real
  }
  throw new RepoRefused(
    `repo ${repo}${real === repo ? '' : ` (${real})`} is outside the allowed roots (FACTORY_REPO_ROOTS): ${roots.join(', ')}`,
  )
}
