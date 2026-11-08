import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Projects } from '../../domains/quality/ports.ts'
import { ok } from '../../kernel/result.ts'

/** A Makefile target at the start of a line, as the make contract names them (`check`, `deploy`, `verify`, `version`). */
const targetsOf = (makefile: string): Set<string> =>
  new Set(
    [...makefile.matchAll(/^([A-Za-z][A-Za-z0-9_.-]*)\s*:(?!=)/gm)].flatMap((match) => (match[1] ? [match[1]] : [])),
  )

/**
 * What a repo's Makefile says of its watch, for a repo with no `project.yaml` (`app/quality-projects.ts` reads the file
 * when there is one): a repo with a `verify` target is verified, and one with a `deploy` target is deployed by
 * `make deploy`, so its watch also reads `make version`. The window is the setting's and there are no probes. A repo
 * with no Makefile has nothing to run, and its watch passes when the window is over.
 */
export function makefileProjects(options: { windowMs: number }): Projects {
  return {
    async checksOf(repo) {
      const makefile = await readFile(join(repo, 'Makefile'), 'utf8').catch(() => '')
      const targets = targetsOf(makefile)
      return ok({
        windowMs: options.windowMs,
        deployMode: targets.has('deploy') ? 'make' : 'none',
        makeVerify: targets.has('verify'),
        probes: [],
      })
    },
  }
}
