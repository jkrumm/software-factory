import { realpath } from 'node:fs/promises'
import { join } from 'node:path'

const namesIuRoot = (path: string): boolean => path.split('/').includes('IuRoot')

/**
 * Whether a place is the owner's read-only, never-leaves-the-mini ground: under a visible root as configured, anywhere under a
 * directory named `IuRoot`, or under the real `$HOME/IuRoot` (the same places the Issue refusal of an IuRoot alert checks), so
 * `FACTORY_VISIBLE_ROOTS=off` or a custom value does not make IuRoot's repos read as ordinary.
 */
export class Places {
  private constructor(private readonly roots: readonly string[]) {}

  static async of(input: {
    visibleRoots: readonly string[]
    configured: readonly string[]
    home: string
  }): Promise<Places> {
    const candidates = [
      ...input.visibleRoots,
      ...(input.home ? [join(input.home, 'IuRoot')] : []),
      ...input.configured.filter(namesIuRoot),
    ]
    const real = await Promise.all(candidates.map((root) => realpath(root).catch(() => root)))
    return new Places([...new Set([...candidates, ...real])])
  }

  isVisible(path: string): boolean {
    return namesIuRoot(path) || this.roots.some((root) => path === root || path.startsWith(`${root}/`))
  }
}
