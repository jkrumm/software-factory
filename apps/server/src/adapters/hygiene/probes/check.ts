import { EXIT_TIMEOUT } from '../../process.ts'
import { exec, gitTry, type Tools, withStderr } from '../git.ts'
import { installed } from './toolrun.ts'
import { type Outcome, clean, failed, finding, found, skipped } from './finding.ts'
import { type Checkout, MAX_EVIDENCE_LINES } from '../../../domains/hygiene/hygiene-model.ts'

/** A CLI helper's limit, not an agent's: the repo's whole gate can be slow. */
export const CHECK_TIMEOUT_MS = 45 * 60_000

/** `factory slot run` ends with this when no slot came in time (sysexits `EX_TEMPFAIL`): the check did not run. */
const EX_TEMPFAIL = 75

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

/**
 * `make <target>` in `cwd`: the exit code, the seconds it took and the tail of its output (ANSI stripped, `MAX_EVIDENCE_LINES` lines).
 * `slot`: the command runs inside one of the host's test slots (`tools.slot`), so a whole gate never runs beside the leads' own.
 */
export async function makeTarget(tools: Tools, cwd: string, target: string, options: { slot?: boolean } = {}) {
  const started = Date.now()
  const result = await exec(
    withStderr([...(options.slot ? tools.slot : []), tools.make, target]),
    CHECK_TIMEOUT_MS,
    cwd,
  )
  const tail = result.stdout
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-MAX_EVIDENCE_LINES)
  return { exitCode: result.exitCode, seconds: Math.round((Date.now() - started) / 1000), tail }
}

/** The project's own checkout is at `sha` and has no changes: only then is its result a verdict on the branch. */
async function cleanAt(tools: Tools, source: string, sha: string): Promise<boolean> {
  const head = await gitTry(tools, source, ['rev-parse', 'HEAD'])
  if (head?.trim() !== sha) return false
  return (await gitTry(tools, source, ['status', '--porcelain']))?.trim() === ''
}

/**
 * `make check` on the default branch: green or one finding with the tail of its output. A red in the throwaway checkout
 * is confirmed in the project's own checkout when that is clean at the same commit: green there is the throwaway's
 * fault (a path the gate cannot run under), not a finding.
 */
export async function checkProbe(tools: Tools, checkout: Checkout): Promise<Outcome> {
  const { path, ref, source } = checkout
  const makefile = await Bun.file(`${path}/Makefile`)
    .text()
    .catch(() => '')
  if (!/^check:/m.test(makefile)) return skipped('no check target in the Makefile')
  // The whole gate of a repo is the heaviest thing the sweep runs: in a test slot, never beside the leads' own work.
  const slot = tools.slot[0]
  if (!slot || !installed(slot))
    return failed(`no \`${slot ?? 'slot command'}\` on the PATH: make check needs a test slot`)
  const first = await makeTarget(tools, path, 'check', { slot: true })
  if (first.exitCode === EX_TEMPFAIL)
    return failed('no test slot came in time: make check did not run, asked again at the next pass')
  if (first.exitCode === EXIT_TIMEOUT) return failed(`make check did not finish in ${CHECK_TIMEOUT_MS / 60_000} min`)
  let detail = `make check, ${first.seconds}s, exit ${first.exitCode}`
  if (first.exitCode === 0) return clean(detail)
  if (first.exitCode === 126 || first.exitCode === 127) return failed(`${detail}: ${tools.make} cannot run`)
  const sha7 = ref.slice(0, 7)
  if (await cleanAt(tools, source, ref)) {
    const own = await makeTarget(tools, source, 'check', { slot: true })
    if (own.exitCode === EX_TEMPFAIL)
      return failed("no test slot came in time to confirm the red in the project's own checkout")
    if (own.exitCode === EXIT_TIMEOUT) return failed(`make check did not finish in the project's own checkout`)
    if (own.exitCode === 126 || own.exitCode === 127) {
      return failed(`make check, exit ${own.exitCode} in the project's own checkout: ${tools.make} cannot run`)
    }
    if (own.exitCode === 0) {
      return failed(`make check is red only in the throwaway checkout, green in the project's own checkout at ${sha7}`)
    }
    detail += ", confirmed in the project's own checkout"
  } else {
    detail += `, not confirmed: the project's own checkout is not clean at ${sha7}`
  }
  return found(detail, [finding('check', 'check', 'Hygiene: make check is red on the default branch', first.tail, 1)])
}
