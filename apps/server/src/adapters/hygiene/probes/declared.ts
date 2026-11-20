import { EXIT_TIMEOUT } from '../../process.ts'
import type { Tools } from '../git.ts'
import { CHECK_TIMEOUT_MS, makeTarget } from './check.ts'
import { type Outcome, failed, finding, found, clean, skipped } from './finding.ts'
import type { DeclaredProbe, Checkout } from '../../../domains/loops/hygiene-model.ts'

/** Whether a Makefile defines `target` as a rule (alone or among several targets of one line). `target` is `[a-z0-9-]+`. */
const definesTarget = (makefile: string, target: string): boolean =>
  new RegExp(`^(?:[\\w.-]+\\s+)*${target}(?:\\s+[\\w.-]+)*\\s*::?(?!=)`, 'm').test(makefile)

/**
 * One probe a project declares (`hygiene.probes` of its `project.yaml`): `make <target>` in the throwaway checkout. Exit 0 is
 * clean, any other exit one finding `probe:<name>` with the tail of the output; a Makefile without the target is skipped,
 * and a `make` that cannot run or a timeout is failed, never a finding.
 */
export async function declaredProbe(tools: Tools, checkout: Checkout, probe: DeclaredProbe): Promise<Outcome> {
  const { name, target } = probe
  const makefile = await Bun.file(`${checkout.path}/Makefile`)
    .text()
    .catch(() => '')
  if (!definesTarget(makefile, target)) return skipped(`${name}: no ${target} target in the Makefile`)
  const result = await makeTarget(tools, checkout.path, target)
  if (result.exitCode === EXIT_TIMEOUT) {
    return failed(`${name}: make ${target} did not finish in ${CHECK_TIMEOUT_MS / 60_000} min`)
  }
  const detail = `${name}: make ${target}, ${result.seconds}s, exit ${result.exitCode}`
  if (result.exitCode === 0) return clean(detail)
  if (result.exitCode === 126 || result.exitCode === 127) return failed(`${detail}: ${tools.make} cannot run`)
  return found(detail, [
    {
      ...finding('probe', `probe:${name}`, `Hygiene: project probe ${name} is red`, result.tail, 1),
      reproduce: `make ${target}`,
    },
  ])
}
